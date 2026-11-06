// [LAW:parse-dont-validate] The one place a recording's text becomes a typed
// recording. A recording is one session's stream as newline-delimited JSON
// (docs/design/gather-and-renderer.md §14): a header naming the facts version,
// the session and the home its payloads were composed against, then the
// documents the session's view took, the requests it was drawn by and the
// draws of their answers, each with its instant. The session's recorder
// (src/daemon/session-recorder.ts) writes it and this unit reads it back.
// Everything past this unit holds a `Recording` and asks nothing of its shape
// again: a malformed or partial line throws naming its line number, as
// `parseFact` does for a fact.
//
// Request lines and the home are in the file because the hook's fields
// (model, cost, context window), the client's hints and whose home `~` names
// are not in the document, and a replay without them cannot draw what the
// live bar drew. Draw lines are there because an answer is drawn after its
// request's wait, from what the view took during it. The facts arm reads only
// the documents, so the seam stays facts-only.
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
// what a replay declares the view with, and what its answer is drawn at.
export interface RequestLine {
  readonly at: Instant;
  readonly request: ViewFacts;
}

// One answer drawn, once its request's wait was over, from the document the
// line before it holds: the instant of the request it answers, which is the
// instant it is drawn at.
export interface DrawLine {
  readonly request: Instant;
}

// The request a draw's view was declared with, restated ahead of the draw
// when it is not the last one the file declared: a request draws the view it
// holds, which the session may have moved away from, so the view declared
// with a later request is not the one it read. Not an arrival: nothing waits
// for it and no draw answers it.
export interface DeclaredLine {
  readonly request: ViewFacts;
}

// [LAW:one-source-of-truth] What the session's view took and its request path
// did, in the one order a replay follows: the file's. A document is the
// view's from its line on, a request or a declaration declares the view, and
// a draw draws it as it stands. Instants cannot order them: a document can be
// stamped in the millisecond a draw read the one before it, and under a held
// clock a request, what lands in its wait and its answer share one instant.
export type ReplayLine =
  | ({ readonly kind: "facts" } & FactsLine)
  | ({ readonly kind: "request" } & RequestLine)
  | ({ readonly kind: "declared" } & DeclaredLine)
  | ({ readonly kind: "draw" } & DrawLine);

// [LAW:types-are-the-program] A line of the file, by kind: the header first,
// then the replay's lines in the order the recorder took them.
export type RecordingLine =
  | {
      readonly kind: "recording";
      readonly session: SessionId;
      // The home the session's payloads were composed against: whose `~`.
      readonly home: string;
    }
  | ReplayLine;

// [LAW:types-are-the-program] A recording as the parser proved it: one
// session's, the document its view opens on (the last before its first
// request), then its lines from that request on, with at least one draw and
// every draw answering a request before it not drawn already, so a replay
// has a view to open and a frame to draw.
export interface Recording {
  readonly session: SessionId;
  readonly home: string;
  readonly opening: FactsLine;
  readonly lines: readonly [
    { readonly kind: "request" } & RequestLine,
    ...ReplayLine[],
  ];
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
  // The payload reads the session from the hook's own field, so one naming
  // another session would draw this one's view with that one's hook data.
  if (data.session_id !== session) {
    throw new FactParseError(
      where,
      `is session ${JSON.stringify(data.session_id)}'s request, and the recording is of ${JSON.stringify(session)}`,
    );
  }
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
  const { home } = header;
  if (typeof home !== "string" || !isAbsolute(home)) {
    throw new FactParseError(
      "line 1",
      "has no `home` that is an absolute path",
    );
  }
  // The document the view holds as the walk reaches each line, and the lines
  // from the first request on.
  let opening: FactsLine | null = null;
  const lines: ReplayLine[] = [];
  // The requests not yet drawn, by instant: requests can share one.
  const undrawn = new Map<Instant, number>();
  let draws = 0;
  for (const [i, row] of body.entries()) {
    const where = `line ${i + 2}`;
    const json = objectOf(row, where);
    const { kind } = json;
    if (kind === "request") {
      if (opening === null) {
        throw new FactParseError(
          where,
          "is a request before any document: a recording opens on its view's document",
        );
      }
      const at = instantOf(json.at, where, "at");
      lines.push({ kind, at, request: parseRequest(json, where, session) });
      undrawn.set(at, (undrawn.get(at) ?? 0) + 1);
      continue;
    }
    if (kind === "declared") {
      if (lines.length === 0) {
        throw new FactParseError(
          where,
          "is a declaration before any request: only a draw restates one",
        );
      }
      lines.push({ kind, request: parseRequest(json, where, session) });
      continue;
    }
    if (kind === "draw") {
      const request = instantOf(json.request, where, "request");
      const waiting = undrawn.get(request) ?? 0;
      if (waiting === 0) {
        throw new FactParseError(
          where,
          `draws the answer to a request at ${request}, and no request line before it arrived then that is not drawn already`,
        );
      }
      undrawn.set(request, waiting - 1);
      draws++;
      lines.push({ kind, request });
      continue;
    }
    if (kind !== "facts") {
      throw new FactParseError(
        where,
        `is of kind ${JSON.stringify(kind)}, not "facts", "request", "declared" or "draw"`,
      );
    }
    const at = instantOf(json.at, where, "at");
    const document = parseSessionFacts(json.facts, `${where} facts`);
    if (document.session !== session) {
      throw new FactParseError(
        where,
        `is session ${JSON.stringify(document.session)}'s document, and the recording is of ${JSON.stringify(session)}`,
      );
    }
    // Before the first request a later document replaces the opening one: no
    // draw can read the one it replaced.
    if (lines.length === 0) opening = { at, facts: document };
    else lines.push({ kind, at, facts: document });
  }
  if (opening === null) {
    throw new FactParseError("the recording", "holds no document");
  }
  // A replay draws one frame per answer, so a recording no answer was drawn
  // in (an idle session's) replays nothing. Every draw answers a request
  // before it, so the first line is a request.
  const [first, ...later] = lines;
  if (first?.kind !== "request" || draws === 0) {
    throw new FactParseError(
      "the recording",
      "holds no answered request: none was answered while it was recorded",
    );
  }
  return { session, home, opening, lines: [first, ...later] };
}

function instantOf(json: unknown, where: string, field: string): Instant {
  if (typeof json !== "number" || !Number.isFinite(json)) {
    throw new FactParseError(where, `has no finite \`${field}\``);
  }
  return json as Instant;
}

// A line as the recorder writes it: one JSON object, one newline.
export function formatLine(line: RecordingLine): string {
  const json =
    line.kind === "recording"
      ? {
          kind: line.kind,
          v: FACTS_VERSION,
          session: line.session,
          home: line.home,
        }
      : line.kind === "facts"
        ? { kind: line.kind, at: line.at, facts: line.facts }
        : line.kind === "draw"
          ? { kind: line.kind, request: line.request }
          : {
              kind: line.kind,
              ...(line.kind === "request" && { at: line.at }),
              hookData: line.request.hookData,
              cwd: line.request.cwd,
              hints: line.request.hints,
            };
  return `${JSON.stringify(json)}\n`;
}
