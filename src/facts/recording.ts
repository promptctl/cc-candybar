// [LAW:parse-dont-validate] The one place a recording's text becomes a typed
// recording. A recording is one session's stream as newline-delimited JSON
// (docs/design/gather-and-renderer.md §14): a header naming its format's version,
// the session and the home its payloads were composed against, then the
// turn the session's bar is drawn from, then the documents its view took, the
// requests it was drawn by, the draws of their answers and of the frames a
// lane's feed drew (each with its instant, the session's draw state it read
// and what it was handed) and the turn again wherever its hold moved. The session's recorder
// (src/daemon/session-recorder.ts) writes it and this unit reads it back.
// Everything past this unit holds a `Recording` and asks nothing of its shape
// again: a malformed or partial line throws naming its line number, as
// `parseFact` does for a fact.
//
// Request lines and the home are in the file because the hook's fields
// (model, cost, context window), the client's hints and whose home `~` names
// are not in the document, and a replay without them cannot draw what the
// live bar drew. Draw lines are there because an answer is drawn after its
// request's wait, from what the view took during it, and because a lane's
// frame is drawn between answers through the same view. A draw line carries what
// the session's clicks and menus left for that draw, because a replay that
// opened a session that never clicked would draw every pick absent and every
// menu closed. A turn line is there because a turn whose inputs could not be
// read holds the bar on the last turn taken, whose request and picks the
// session has since moved past: the replay takes that turn and holds its own
// over the same lines. The facts arm reads only the documents, so the seam
// stays facts-only.
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
import type { Handed } from "../daemon/draw-view";
import {
  LANE_NAMES,
  type Drawing,
  type Lane,
  type LaneFeed,
  type LaneFeeds,
  perLane,
} from "../config/lanes";
import type { HistoryDepth } from "../daemon/settings-history";
import {
  DIAGNOSTIC_LEVELS,
  diagnosticSpan,
  type DiagnosticLevel,
  type DiagnosticLine,
  type DiagnosticList,
  type DiagnosticMessage,
  type DiagnosticSeverity,
} from "../render/diagnostics";

// One pushed document and the instant its stamp was taken at: what the player
// replays, and what the recorder writes.
export interface FactsLine {
  readonly at: Instant;
  readonly facts: SessionFacts;
}

// One request a session's view was drawn by, and the instant it arrived at:
// what a replay declares the view with, and what its answer is drawn at.
// [LAW:types-are-the-program] A request as the daemon's checkpoint takes one:
// from a directory, which the session's view opens at. A shell source's run
// is identified by the directory it runs in, so a replay opens the view
// where each request came from, wherever the demo itself runs.
export type SessionRequest = ViewFacts & { readonly cwd: string };

export interface RequestLine {
  readonly at: Instant;
  readonly request: SessionRequest;
}

// What a session's clicks left: every value the session store holds for it
// and the store's revision for it (a frame keeps the last frame's memory only
// while the revision holds), and the depths of its settings history and its
// back history.
export interface ClickState {
  readonly values: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly history: HistoryDepth;
  readonly back: number;
}

// What a session's clicks and menus left for one draw, beside its view: its
// clicks' state, and when its menus' idle period began, which the draw counts
// the closing flash from.
export interface DrawState extends ClickState {
  readonly idleSince: Instant | undefined;
}

// [LAW:one-type-per-behavior] One frame drawn of the session's view, from the
// document the line before it holds: a request's answer, once its wait was
// over, at the instant its request arrived at, or a frame a lane's feed drew
// between answers, at its own instant. Both write the view's frame memory and
// the session's effect memory, so a replay draws both, in the file's order.
// It carries the session's draw state it read and what it was handed: who it
// drew for, what each lane's feed was doing, and the diagnostics list its
// door's indicator and its viewer read.
export interface DrawLine extends Handed {
  readonly at: Instant;
  readonly state: DrawState;
}

// The turn a session's bar is drawn from (src/daemon/session-source.ts): its
// document with the instant it was stamped at, the request it was composed
// from, and the clicks' state its globals were resolved over.
export interface RecordedTurn {
  readonly document: FactsLine;
  readonly request: SessionRequest;
  readonly state: ClickState;
}

// [LAW:one-type-per-behavior] The bar is drawn from this turn from here on,
// held on it or not: a recording opens on one, and writes one wherever the
// hold moves — the held turn as the hold begins, the turn taken as it ends.
// The hold's reason is the draw's, in its diagnostics.
export interface TurnLine extends RecordedTurn {
  readonly held: boolean;
}

// [LAW:one-source-of-truth] The session's clicks' state from here on, written
// ahead of a document stamped after a click moved it: the runs a document
// holds are the ones its state's keys declared, so a replay's state moves
// before it reaches that document, where the live session's moved.
export interface StateLine {
  readonly state: ClickState;
}

// Whether two clicks' states are one: their values, revision and depths.
export function sameClickState(a: ClickState, b: ClickState): boolean {
  const depths = Object.keys(a.history) as Array<keyof HistoryDepth>;
  return (
    a.revision === b.revision &&
    a.back === b.back &&
    depths.every((k) => a.history[k] === b.history[k]) &&
    sameValues(a.values, b.values)
  );
}

// The request a draw's view was declared with, restated ahead of the draw
// when it is not the last one the file declared: a request draws the view it
// holds, which the session may have moved away from, so the view declared
// with a later request is not the one it read. Not an arrival: nothing waits
// for it and no draw answers it.
export interface DeclaredLine {
  readonly request: SessionRequest;
}

// [LAW:one-source-of-truth] What the session's view took and its request path
// did, in the one order a replay follows: the file's. A document is the
// view's from its line on, a request or a declaration declares the view, and
// a draw draws it as it stands, and a turn is taken over its line's inputs and
// held or not. Instants cannot order them: a document can be
// stamped in the millisecond a draw read the one before it, and under a held
// clock a request, what lands in its wait and its answer share one instant.
export type ReplayLine =
  | ({ readonly kind: "facts" } & FactsLine)
  | ({ readonly kind: "request" } & RequestLine)
  | ({ readonly kind: "declared" } & DeclaredLine)
  | ({ readonly kind: "draw" } & DrawLine)
  | ({ readonly kind: "turn" } & TurnLine)
  | ({ readonly kind: "state" } & StateLine);

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
// session's, the turn its view opens on, then its lines, with at least one
// draw and every answer drawn for a request before it not drawn already, so a
// replay has a view to open and a frame to draw.
export interface Recording {
  readonly session: SessionId;
  readonly home: string;
  readonly opening: TurnLine;
  readonly lines: readonly ReplayLine[];
}

// [LAW:one-source-of-truth] The recording's own format: its header and its
// request, declared, draw, turn and state lines, which are the renderer's request
// path and not the facts protocol. The documents in it carry their own facts
// version, which each document's parse refuses, so a change of either moves
// one number.
export const RECORDING_VERSION = 7;

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

// The clicks' state a draw or a turn read, as the recorder wrote it.
function parseClickState(json: unknown, where: string): ClickState {
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
  };
}

// A draw's state as the recorder wrote it: an idle period that had not begun
// is `null` in the file, the one spelling JSON has for it.
function parseDrawState(json: unknown, where: string): DrawState {
  const clicks = parseClickState(json, where);
  const { idleSince } = json as Record<string, unknown>;
  return {
    ...clicks,
    idleSince:
      idleSince === null
        ? undefined
        : parseInstant(idleSince, where, "state.idleSince"),
  };
}

// [LAW:parse-dont-validate] A severity is data — the level it counts at and
// the glyph that leads it — read back as the draw wrote it, so a replayed
// message wears the same glyph and counts at the same level. Its colours are
// its level's, so a recording's `colors` (an older one wrote them) is not read.
// [LAW:single-enforcer] A level is one the level table has.
function parseSeverity(json: unknown, where: string): DiagnosticSeverity {
  if (!isPlainObject(json)) {
    throw new FactParseError(where, "is not an object");
  }
  const { level, glyph } = json;
  if (typeof level !== "string" || !Object.hasOwn(DIAGNOSTIC_LEVELS, level)) {
    throw new FactParseError(
      where,
      `has no \`level\` that is one of ${Object.keys(DIAGNOSTIC_LEVELS).join(", ")}`,
    );
  }
  if (typeof glyph !== "string" || glyph === "") {
    throw new FactParseError(where, "has no `glyph`");
  }
  return { level: level as DiagnosticLevel, glyph };
}

function parseText(json: unknown, where: string, field: string): string {
  if (typeof json !== "string") {
    throw new FactParseError(where, `has no text \`${field}\``);
  }
  return json;
}

// A viewer line: one or more spans, each its text and its click or none. The
// text crosses the one span constructor, which sanitizes it.
function parseDiagnosticLine(json: unknown, where: string): DiagnosticLine {
  if (!Array.isArray(json) || json.length === 0) {
    throw new FactParseError(where, "is not a list of spans");
  }
  const [first, ...rest] = json.map((span: unknown, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(span)) {
      throw new FactParseError(at, "is not a span object");
    }
    if (span.link !== null && typeof span.link !== "string") {
      throw new FactParseError(at, "has a link that is neither text nor null");
    }
    return diagnosticSpan(parseText(span.text, at, "text"), span.link);
  });
  return [first!, ...rest];
}

// One message a draw owed its reader (src/render/diagnostics.ts).
function parseDiagnosticMessage(
  json: unknown,
  where: string,
): DiagnosticMessage {
  if (!isPlainObject(json)) throw new FactParseError(where, "is not an object");
  if (!Array.isArray(json.lines) || json.lines.length === 0) {
    throw new FactParseError(where, "has no `lines`: a message has one");
  }
  const [first, ...rest] = json.lines.map((line: unknown, i) =>
    parseDiagnosticLine(line, `${where} lines[${i}]`),
  );
  return {
    severity: parseSeverity(json.severity, `${where} severity`),
    about: parseText(json.about, where, "about"),
    message: parseText(json.message, where, "message"),
    copy: parseText(json.copy, where, "copy"),
    lines: [first!, ...rest],
  };
}

// Who a draw drew for: a request's answer, or a lane's feed with its ceiling.
function parseDrawing(json: unknown, where: string): Drawing {
  if (!isPlainObject(json)) {
    throw new FactParseError(where, "has no `drawing` object");
  }
  if (json.by === "request") return { by: "request" };
  if (json.by === "feed") {
    return { by: "feed", fps: parseCount(json.fps, where, "drawing.fps") };
  }
  throw new FactParseError(
    where,
    "has no `drawing.by` that is request or feed",
  );
}

// What each lane's feed was doing as a draw was handed it: one per lane this
// build draws, and no other.
function parseFeeds(json: unknown, where: string): LaneFeeds {
  if (!isPlainObject(json)) {
    throw new FactParseError(where, "has no `feeds` object");
  }
  const named = Object.keys(json);
  const unknown = named.find((lane) => !LANE_NAMES.includes(lane as Lane));
  if (unknown !== undefined) {
    throw new FactParseError(
      where,
      `has a feed of lane ${JSON.stringify(unknown)}, which this build does not draw`,
    );
  }
  const feed = (lane: Lane): LaneFeed => {
    const field = `feeds.${lane}`;
    const held = json[lane];
    if (!isPlainObject(held)) {
      throw new FactParseError(where, `has no \`${field}\` object`);
    }
    if (typeof held.shown !== "boolean") {
      throw new FactParseError(
        where,
        `has no \`${field}.shown\` that is true or false`,
      );
    }
    return {
      subscribers: parseCount(held.subscribers, where, `${field}.subscribers`),
      fps: parseCount(held.fps, where, `${field}.fps`),
      shown: held.shown,
    };
  };
  return perLane(feed);
}

function parseDiagnosticList(json: unknown, where: string): DiagnosticList {
  if (!Array.isArray(json)) {
    throw new FactParseError(where, "has no `diagnostics` list");
  }
  return json.map((m: unknown, i) =>
    parseDiagnosticMessage(m, `${where} diagnostics[${i}]`),
  );
}

// A document with the instant it was stamped at, refused when it is another
// session's.
function parseFactsLine(
  json: Record<string, unknown>,
  where: string,
  session: SessionId,
): FactsLine {
  const at = parseInstant(json.at, where, "at");
  const document = parseSessionFacts(json.facts, `${where} facts`);
  if (document.session !== session) {
    throw new FactParseError(
      where,
      `is session ${JSON.stringify(document.session)}'s document, and the recording is of ${JSON.stringify(session)}`,
    );
  }
  return { at, facts: document };
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
): SessionRequest {
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
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new FactParseError(where, "has no `cwd` that is an absolute path");
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
  // The turn the view opens on, and the lines after it.
  let opening: TurnLine | null = null;
  const lines: ReplayLine[] = [];
  // The requests not yet drawn, by instant: requests can share one.
  const undrawn = new Map<Instant, number>();
  let draws = 0;
  // [LAW:parse-dont-validate] The values each revision a draw or a turn read
  // held: one revision is one state (SessionStateReader), which the replay's
  // restore keeps to, so a revision noted again over other values is refused.
  const held = new Map<number, Readonly<Record<string, string>>>();
  const oneState = (state: ClickState, where: string): void => {
    const before = held.get(state.revision) ?? state.values;
    if (!sameValues(before, state.values)) {
      throw new FactParseError(
        where,
        `reads revision ${state.revision} over other values than a line before it read there`,
      );
    }
    held.set(state.revision, state.values);
  };
  const turnOf = (json: Record<string, unknown>, where: string): TurnLine => {
    if (typeof json.held !== "boolean") {
      throw new FactParseError(where, "has no `held` that is true or false");
    }
    const state = parseClickState(json.state, where);
    oneState(state, where);
    return {
      document: parseFactsLine(json, where, session),
      request: parseRequest(json, where, session),
      state,
      held: json.held,
    };
  };
  for (const [i, row] of body.entries()) {
    const where = `line ${i + 2}`;
    const json = objectOf(row, where);
    const { kind } = json;
    // [LAW:types-are-the-program] The first line after the header is the turn
    // the view opens on: a replay opens nothing else.
    if (opening === null) {
      if (kind !== "turn") {
        throw new FactParseError(
          where,
          "is not a turn: a recording opens on the turn its bar is drawn from",
        );
      }
      opening = turnOf(json, where);
      continue;
    }
    if (kind === "turn") {
      lines.push({ kind, ...turnOf(json, where) });
      continue;
    }
    if (kind === "request") {
      const at = parseInstant(json.at, where, "at");
      lines.push({ kind, at, request: parseRequest(json, where, session) });
      undrawn.set(at, (undrawn.get(at) ?? 0) + 1);
      continue;
    }
    if (kind === "state") {
      const state = parseClickState(json.state, where);
      oneState(state, where);
      lines.push({ kind, state });
      continue;
    }
    if (kind === "declared") {
      lines.push({ kind, request: parseRequest(json, where, session) });
      continue;
    }
    if (kind === "draw") {
      const at = parseInstant(json.at, where, "at");
      const drawing = parseDrawing(json.drawing, where);
      // [LAW:types-are-the-program] An answer is drawn for a request the file
      // took before it; a lane's frame answers none.
      if (drawing.by === "request") {
        const waiting = undrawn.get(at) ?? 0;
        if (waiting === 0) {
          throw new FactParseError(
            where,
            `draws the answer to a request at ${at}, and no request line before it arrived then that is not drawn already`,
          );
        }
        undrawn.set(at, waiting - 1);
      }
      draws++;
      const state = parseDrawState(json.state, where);
      oneState(state, where);
      lines.push({
        kind,
        at,
        drawing,
        feeds: parseFeeds(json.feeds, where),
        state,
        diagnostics: parseDiagnosticList(json.diagnostics, where),
      });
      continue;
    }
    if (kind !== "facts") {
      throw new FactParseError(
        where,
        `is of kind ${JSON.stringify(kind)}, not "facts", "request", "declared", "draw", "turn" or "state"`,
      );
    }
    lines.push({ kind, ...parseFactsLine(json, where, session) });
  }
  if (opening === null) {
    throw new FactParseError(
      "the recording",
      "holds no turn: a recording opens on the turn its bar is drawn from",
    );
  }
  // A replay draws one frame per draw, so a recording nothing was drawn in (an
  // idle session's, no lane following) replays nothing.
  if (draws === 0) {
    throw new FactParseError(
      "the recording",
      "holds no draw: no request was answered and no lane drew a frame while it was recorded",
    );
  }
  return { session, home, opening, lines };
}

function parseInstant(json: unknown, where: string, field: string): Instant {
  if (typeof json !== "number" || !Number.isFinite(json)) {
    throw new FactParseError(where, `has no finite \`${field}\``);
  }
  return json as Instant;
}

// A request's fields as a line carries them: what `parseRequest` reads.
function requestFields(request: SessionRequest) {
  return {
    hookData: request.hookData,
    cwd: request.cwd,
    hints: request.hints,
  };
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
              at: line.at,
              drawing: line.drawing,
              feeds: line.feeds,
              state: { ...line.state, idleSince: line.state.idleSince ?? null },
              diagnostics: line.diagnostics,
            }
          : line.kind === "state"
            ? { kind: line.kind, state: line.state }
            : line.kind === "turn"
              ? {
                  kind: line.kind,
                  held: line.held,
                  at: line.document.at,
                  facts: line.document.facts,
                  ...requestFields(line.request),
                  state: line.state,
                }
              : {
                  kind: line.kind,
                  ...(line.kind === "request" && { at: line.at }),
                  ...requestFields(line.request),
                };
  return `${JSON.stringify(json)}\n`;
}
