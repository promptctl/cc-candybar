// [LAW:parse-dont-validate] The one place a recording's text becomes a typed
// recording. A recording is one session's stream as newline-delimited JSON
// (docs/design/gather-and-renderer.md §14): a header naming its format's version,
// the session and the home its payloads were composed against, then the
// documents the session's view took, the requests it was drawn by and the
// draws of their answers, each with its instant and the session's draw state
// it read. The session's recorder
// (src/daemon/session-recorder.ts) writes it and this unit reads it back.
// Everything past this unit holds a `Recording` and asks nothing of its shape
// again: a malformed or partial line throws naming its line number, as
// `parseFact` does for a fact.
//
// Request lines and the home are in the file because the hook's fields
// (model, cost, context window), the client's hints and whose home `~` names
// are not in the document, and a replay without them cannot draw what the
// live bar drew. Draw lines are there because an answer is drawn after its
// request's wait, from what the view took during it. A draw line carries what
// the session's clicks and menus left for that draw, because a replay that
// opened a session that never clicked would draw every pick absent and every
// menu closed. The facts arm reads only the documents, so the seam stays
// facts-only.
//
// [LAW:one-way-deps] Pure over text and values: no file, no clock. Where the
// text comes from is the caller's edge.

import {
  BUILTIN_FACTS,
  FACTS_VERSION,
  type BuiltinFacts,
  type FactsDiagnostic,
  type RunFact,
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
import type { HistoryDepth } from "../daemon/settings-history";

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

// What a session's clicks and menus left for one draw, beside its view: every
// value the session store holds for it and the store's revision for it (a
// frame keeps the last frame's memory only while the revision holds), the
// depths of its settings history and its back history, and when its menus'
// idle period began, which the draw counts the closing flash from.
export interface DrawState {
  readonly values: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly history: HistoryDepth;
  readonly back: number;
  readonly idleSince: Instant | undefined;
}

// One answer drawn, once its request's wait was over, from the document the
// line before it holds: the instant of the request it answers, which is the
// instant it is drawn at, and the session's draw state it read.
export interface DrawLine {
  readonly request: Instant;
  readonly state: DrawState;
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
  // Where the session's view opened: its first request's directory. A shell
  // source's run is identified by the directory it ran in, so a replay opens
  // its view here, wherever the demo itself runs.
  readonly cwd: string;
  readonly opening: FactsLine;
  readonly lines: readonly [
    { readonly kind: "request" } & RequestLine,
    ...ReplayLine[],
  ];
}

// [LAW:one-source-of-truth] The recording's own format: its header and its
// request, declared and draw lines, which are the renderer's request path and
// not the facts protocol. The documents in it carry their own facts version,
// which each document's parse refuses, so a change of either moves one number.
export const RECORDING_VERSION = 3;

// A recording of another format: refused whole, never read line by line
// against this build's. The version is a value, so the edge that names the
// file says which.
export class RecordingVersionError extends Error {
  constructor(readonly v: unknown) {
    super(
      `is a v${String(v)} recording; this build reads v${RECORDING_VERSION}`,
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

function parseRun(json: unknown, where: string): RunFact {
  if (!isPlainObject(json)) throw new FactParseError(where, "is not an object");
  if (json.fault !== null && typeof json.fault !== "string") {
    throw new FactParseError(
      where,
      "has a fault that is neither text nor null",
    );
  }
  return {
    reading: parseFact(json.reading, `${where} reading`) as Fact<SourceValue>,
    fault: json.fault,
  };
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
  if (!isPlainObject(json.runs)) {
    throw new FactParseError(where, "has no `runs`");
  }
  const runs = Object.fromEntries(
    Object.entries(json.runs).map(([digest, run]) => [
      digest,
      parseRun(run, `${where} runs.${digest}`),
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
    runs,
    update: parseFact(json.update, `${where} update`) as Fact<UpdateNotice>,
    diagnostics: json.diagnostics.map((d, i) =>
      parseDiagnostic(d, `${where} diagnostics[${i}]`),
    ),
  };
}

function parseCount(json: unknown, where: string, field: string): number {
  if (typeof json !== "number" || !Number.isInteger(json) || json < 0) {
    throw new FactParseError(where, `has no count \`${field}\``);
  }
  return json;
}

function sameValues(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}

// A draw's state as the recorder wrote it: an idle period that had not begun
// is `null` in the file, the one spelling JSON has for it.
function parseDrawState(json: unknown, where: string): DrawState {
  if (!isPlainObject(json)) {
    throw new FactParseError(where, "has no `state` object");
  }
  const { values, history } = json;
  if (
    !isPlainObject(values) ||
    !Object.values(values).every((v) => typeof v === "string")
  ) {
    throw new FactParseError(where, "has no `state.values` of strings by key");
  }
  if (!isPlainObject(history)) {
    throw new FactParseError(where, "has no `state.history` object");
  }
  const revision = parseCount(json.revision, where, "state.revision");
  // [LAW:parse-dont-validate] The store reads revision 0 exactly while it
  // holds nothing for the session, so a state that says otherwise was never
  // one it held.
  if ((revision === 0) !== (Object.keys(values).length === 0)) {
    throw new FactParseError(
      where,
      `has \`state.revision\` ${revision} over ${Object.keys(values).length} values: the store is at revision 0 exactly while it holds none`,
    );
  }
  return {
    values: values as Record<string, string>,
    revision,
    history: {
      undo: parseCount(history.undo, where, "state.history.undo"),
      redo: parseCount(history.redo, where, "state.history.redo"),
      sinceEdit: parseCount(
        history.sinceEdit,
        where,
        "state.history.sinceEdit",
      ),
    },
    back: parseCount(json.back, where, "state.back"),
    idleSince:
      json.idleSince === null
        ? undefined
        : parseInstant(json.idleSince, where, "state.idleSince"),
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
  // [LAW:no-silent-failure] Another format's lines are refused whole, before
  // any of them is read against this build's.
  if (header.v !== RECORDING_VERSION) throw new RecordingVersionError(header.v);
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
  // [LAW:parse-dont-validate] The values each revision a draw read held:
  // one revision is one state (SessionStateReader), which the replay's
  // restore keeps to, so a revision noted again over other values is refused.
  const held = new Map<number, Readonly<Record<string, string>>>();
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
      const at = parseInstant(json.at, where, "at");
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
      const request = parseInstant(json.request, where, "request");
      const waiting = undrawn.get(request) ?? 0;
      if (waiting === 0) {
        throw new FactParseError(
          where,
          `draws the answer to a request at ${request}, and no request line before it arrived then that is not drawn already`,
        );
      }
      undrawn.set(request, waiting - 1);
      draws++;
      const state = parseDrawState(json.state, where);
      const before = held.get(state.revision) ?? state.values;
      if (!sameValues(before, state.values)) {
        throw new FactParseError(
          where,
          `reads revision ${state.revision} over other values than a draw before it read there`,
        );
      }
      held.set(state.revision, state.values);
      lines.push({ kind, request, state });
      continue;
    }
    if (kind !== "facts") {
      throw new FactParseError(
        where,
        `is of kind ${JSON.stringify(kind)}, not "facts", "request", "declared" or "draw"`,
      );
    }
    const at = parseInstant(json.at, where, "at");
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
  const { cwd } = first.request;
  if (cwd === undefined) {
    throw new FactParseError(
      "the recording",
      "opens on a request with no `cwd`: a replay opens its view where the session's opened",
    );
  }
  return { session, home, cwd, opening, lines: [first, ...later] };
}

function parseInstant(json: unknown, where: string, field: string): Instant {
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
          v: RECORDING_VERSION,
          session: line.session,
          home: line.home,
        }
      : line.kind === "facts"
        ? { kind: line.kind, at: line.at, facts: line.facts }
        : line.kind === "draw"
          ? {
              kind: line.kind,
              request: line.request,
              state: { ...line.state, idleSince: line.state.idleSince ?? null },
            }
          : {
              kind: line.kind,
              ...(line.kind === "request" && { at: line.at }),
              hookData: line.request.hookData,
              cwd: line.request.cwd,
              hints: line.request.hints,
            };
  return `${JSON.stringify(json)}\n`;
}
