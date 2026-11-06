// [LAW:parse-dont-validate] The one place a recording's text becomes a typed
// recording. A recording is one session's stream as newline-delimited JSON
// (docs/design/gather-and-renderer.md §14): a header naming the facts version
// and the session, then the documents the session's view took and the
// requests it was drawn by, each with its instant. The session's recorder
// (src/daemon/session-recorder.ts) writes it and this unit reads it back.
// Everything past this unit holds a `Recording` and asks nothing of its shape
// again: a malformed or partial line throws naming its line number, as
// `parseFact` does for a fact.
//
// Request lines are in the file because the hook's fields (model, cost,
// context window) and the client's hints are not in the document, and a
// replay without them cannot draw what the live bar drew. The facts arm reads
// only the documents, so the seam stays facts-only.
//
// [LAW:one-way-deps] Pure over text and values: no file, no clock. Where the
// text comes from is the caller's edge.

import {
  BUILTIN_FACTS,
  FACTS_VERSION,
  type BuiltinFacts,
  type FactsDiagnostic,
  type SessionFacts,
  type SourceValue,
  type UpdateNotice,
} from "./session-facts";
import { FactParseError, parseFact, type Fact } from "./fact";
import { isAbsolute } from "node:path";
import type { Instant } from "../utils/instant";
import { isPlainObject } from "../utils/plain";
import { validateHookData } from "../utils/schema-validator";
import { parseSessionId, type SessionId } from "../daemon/session-id";
import { parseClientHints } from "../daemon/protocol";
import type { ViewFacts } from "../daemon/render-payload";
import { REFRESH_LANES, type RefreshLane } from "../daemon/refresh-faults";

// One pushed document and the instant its stamp was taken at: what the player
// replays, and what the recorder writes.
export interface FactsLine {
  readonly at: Instant;
  readonly facts: SessionFacts;
}

// One request a session's view was drawn by, and the instant it arrived at:
// what a replay opens the view with and draws each later frame at.
export interface RequestLine {
  readonly at: Instant;
  readonly request: ViewFacts;
}

// [LAW:types-are-the-program] A line of the file, by kind: the header first,
// then documents and requests in the order the recorder took them.
export type RecordingLine =
  | { readonly kind: "recording"; readonly session: SessionId }
  | ({ readonly kind: "facts" } & FactsLine)
  | ({ readonly kind: "request" } & RequestLine);

// [LAW:types-are-the-program] A recording as the parser proved it: one
// session's, its documents and its requests each in time order, at least one
// of each, and a document at or before the first request, so a replay has a
// view to open and a document for every request it draws.
export interface Recording {
  readonly session: SessionId;
  readonly facts: readonly [FactsLine, ...FactsLine[]];
  readonly requests: readonly [RequestLine, ...RequestLine[]];
}

// A recording of another facts version: refused whole, never read field by
// field against this build's document. The version is a value, so the edge
// that names the file says which.
export class RecordingVersionError extends Error {
  constructor(readonly v: unknown) {
    super(
      `is a facts v${String(v)} recording; this build reads v${FACTS_VERSION}`,
    );
    this.name = "RecordingVersionError";
  }
}

const LANES: ReadonlySet<unknown> = new Set<RefreshLane>(REFRESH_LANES);

function parseDiagnostic(json: unknown, where: string): FactsDiagnostic {
  if (!isPlainObject(json)) throw new FactParseError(where, "is not an object");
  if (!LANES.has(json.lane)) {
    throw new FactParseError(where, `names lane ${String(json.lane)}`);
  }
  if (typeof json.reason !== "string") {
    throw new FactParseError(where, "has no reason");
  }
  return { lane: json.lane as RefreshLane, reason: json.reason };
}

// [LAW:types-are-the-program] A document off a wire or a recording, or a
// throw naming where it is wrong. Each fact crosses `parseFact`; what a fact's
// value is (a usage record, a git read) is the owner's shape carried as JSON,
// which the type names and this parser takes as read.
export function parseSessionFacts(json: unknown, where: string): SessionFacts {
  if (!isPlainObject(json)) throw new FactParseError(where, "is not an object");
  if (json.v !== FACTS_VERSION) {
    throw new FactParseError(
      where,
      `is facts version ${String(json.v)}, and this build reads ${FACTS_VERSION}`,
    );
  }
  const session = parseSessionId(json.session);
  if (!session.ok)
    throw new FactParseError(where, `session ${session.problem}`);
  if (typeof json.seq !== "number" || !Number.isInteger(json.seq)) {
    throw new FactParseError(where, "has no integer `seq`");
  }
  const builtinsJson = json.builtins;
  if (!isPlainObject(builtinsJson)) {
    throw new FactParseError(where, "has no `builtins`");
  }
  // [LAW:types-are-the-program] Each built-in's value is its owner's shape
  // carried as JSON, which the type names and this parser takes as read: the
  // one cast, here, is that claim.
  const builtins = Object.fromEntries(
    BUILTIN_FACTS.map((name) => [
      name,
      parseFact(builtinsJson[name], `${where} builtins.${name}`),
    ]),
  ) as unknown as BuiltinFacts;
  if (!isPlainObject(json.sources)) {
    throw new FactParseError(where, "has no `sources`");
  }
  const sources = Object.fromEntries(
    Object.entries(json.sources).map(([name, fact]) => [
      name,
      parseFact(fact, `${where} sources.${name}`) as Fact<SourceValue>,
    ]),
  );
  if (!Array.isArray(json.diagnostics)) {
    throw new FactParseError(where, "has no `diagnostics`");
  }
  return {
    v: FACTS_VERSION,
    session: session.id,
    seq: json.seq,
    builtins,
    sources,
    update: parseFact(json.update, `${where} update`) as Fact<UpdateNotice>,
    diagnostics: json.diagnostics.map((d, i) =>
      parseDiagnostic(d, `${where} diagnostics[${i}]`),
    ),
  };
}

// A JSON object off one line of the file, or a throw naming the line.
function objectOf(line: string, where: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (e) {
    throw new FactParseError(where, `is not JSON: ${String(e)}`);
  }
  if (!isPlainObject(json)) throw new FactParseError(where, "is not an object");
  return json;
}

// The request a view was drawn by, as the view took it: its hook data crosses
// the render checkpoint's hook validator and its hints the one hint
// checkpoint, which takes recorded hints as it takes a live client's.
function parseRequest(
  json: Record<string, unknown>,
  where: string,
  session: SessionId,
): ViewFacts {
  if (!isPlainObject(json.hookData)) {
    throw new FactParseError(where, "has no `hookData` object");
  }
  const { data, report } = validateHookData(json.hookData);
  const wrong = [
    ...report.missingRequired.map((path) => `has no hookData.${path}`),
    ...report.typeMismatches.map(
      ({ path, expected, got }) =>
        `has hookData.${path} ${got}, not ${expected}`,
    ),
  ];
  if (wrong.length > 0) throw new FactParseError(where, wrong.join("; "));
  const { cwd } = json;
  if (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd))) {
    throw new FactParseError(where, "has a `cwd` that is not an absolute path");
  }
  if (!isPlainObject(json.hints)) {
    throw new FactParseError(where, "has no `hints` object");
  }
  return {
    sessionId: session,
    hookData: data,
    cwd,
    hints: parseClientHints(json.hints),
  };
}

// A recording's text, whole. Line numbers are 1-based, as an editor counts
// them. Every line ends in its newline, so text that does not end in one ends
// inside its last line, as a daemon that died mid-write leaves it: that is a
// refusal naming the line, never a shorter replay.
export function parseRecording(text: string): Recording {
  const rows = text.split("\n");
  if (rows.pop() !== "") {
    throw new FactParseError(
      `line ${rows.length + 1}`,
      "ends without its newline: the file was cut inside it",
    );
  }
  const [head, ...body] = rows;
  if (head === undefined) {
    throw new FactParseError("line 1", "is missing: the recording is empty");
  }
  const header = objectOf(head, "line 1");
  if (header.kind !== "recording") {
    throw new FactParseError("line 1", "is not a recording's header");
  }
  // [LAW:no-silent-failure] Another version's documents are refused whole,
  // before any of them is read against this build's shape.
  if (header.v !== FACTS_VERSION) throw new RecordingVersionError(header.v);
  const named = parseSessionId(header.session);
  if (!named.ok) throw new FactParseError("line 1", `session ${named.problem}`);
  const session = named.id;
  const facts: FactsLine[] = [];
  const requests: RequestLine[] = [];
  // The line each kind was last seen on, so a line that steps back names it.
  const lastOn = { facts: 0, request: 0 };
  body.forEach((row, i) => {
    const n = i + 2;
    const where = `line ${n}`;
    const json = objectOf(row, where);
    const { kind } = json;
    if (kind !== "facts" && kind !== "request") {
      throw new FactParseError(
        where,
        `is of kind ${JSON.stringify(kind)}, not "facts" or "request"`,
      );
    }
    if (typeof json.at !== "number" || !Number.isFinite(json.at)) {
      throw new FactParseError(where, "has no finite `at`");
    }
    const at = json.at as Instant;
    const prior = kind === "facts" ? facts.at(-1) : requests.at(-1);
    if (prior !== undefined && at < prior.at) {
      throw new FactParseError(
        where,
        `(at ${at}) is before line ${lastOn[kind]} (at ${prior.at}): a recording's ${kind} lines are in time order`,
      );
    }
    lastOn[kind] = n;
    if (kind === "request") {
      requests.push({ at, request: parseRequest(json, where, session) });
      return;
    }
    const document = parseSessionFacts(json.facts, `${where} facts`);
    if (document.session !== session) {
      throw new FactParseError(
        where,
        `is session ${JSON.stringify(document.session)}'s document, and the recording is of ${JSON.stringify(session)}`,
      );
    }
    facts.push({ at, facts: document });
  });
  const [first, ...rest] = facts;
  if (first === undefined) {
    throw new FactParseError("the recording", "holds no document");
  }
  // A replay draws one frame per request, so a recording no request arrived
  // in (an idle session's) replays nothing.
  const [opening, ...later] = requests;
  if (opening === undefined) {
    throw new FactParseError(
      "the recording",
      "holds no request: none arrived while it was recorded",
    );
  }
  if (opening.at < first.at) {
    throw new FactParseError(
      "the recording",
      `has a request (at ${opening.at}) before its first document (at ${first.at})`,
    );
  }
  return {
    session,
    facts: [first, ...rest],
    requests: [opening, ...later],
  };
}

// A line as the recorder writes it: one JSON object, one newline.
export function formatLine(line: RecordingLine): string {
  const json =
    line.kind === "recording"
      ? { kind: line.kind, v: FACTS_VERSION, session: line.session }
      : line.kind === "facts"
        ? { kind: line.kind, at: line.at, facts: line.facts }
        : {
            kind: line.kind,
            at: line.at,
            hookData: line.request.hookData,
            cwd: line.request.cwd,
            hints: line.request.hints,
          };
  return `${JSON.stringify(json)}\n`;
}
