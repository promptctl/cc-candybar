// [LAW:parse-dont-validate] A recording's text crosses one unit into a typed
// recording: a line that is not one is refused naming its number, a recording
// of another version or of no answered request is refused whole, and what the
// recorder writes reads back as itself.

import { restamp } from "../../src/facts/fact";
import {
  formatLine,
  parseRecording,
  parseSessionFacts,
  RECORDING_VERSION,
  RecordingVersionError,
  type DrawState,
  type FactsLine,
  type RecordingLine,
  type RequestLine,
} from "../../src/facts/recording";
import { FACTS_VERSION } from "../../src/facts/session-facts";
import { playOf } from "../../src/demo/play";
import { parseClientHints } from "../../src/daemon/protocol";
import { sessionIdOf } from "../../src/daemon/session-id";
import { instantOf, type Instant } from "../../src/utils/instant";
import { ok } from "../../src/utils/outcome";
import { pendingFacts } from "../helpers/facts";

const SESSION = sessionIdOf("rec-session");
const AT = instantOf(new Date(1_700_000_000_000));

// A document with a few answered facts beside the pending ones.
function document(seq: number): FactsLine["facts"] {
  const pending = pendingFacts(SESSION);
  return {
    ...pending,
    seq,
    builtins: {
      ...pending.builtins,
      git: restamp(
        undefined,
        ok({
          branch: "main",
          status: "clean",
          aheadBehind: ok({ ahead: 0, behind: 0 }),
          head: ok("c0ffee"),
        }),
        AT,
      ),
      hostName: restamp(undefined, ok("box"), AT),
    },
    sources: { "plugins.p.status": restamp(undefined, ok({ home: "/h" }), AT) },
    diagnostics: [{ lane: "session", reason: "transcript unreadable" }],
  };
}

const at = (s: number): Instant => (AT + s) as Instant;

// A request as a session's view takes one.
function request(): RequestLine["request"] {
  return {
    sessionId: SESSION,
    hookData: {
      hook_event_name: "Status",
      session_id: SESSION,
      transcript_path: "/elsewhere/transcript.jsonl",
      cwd: "/elsewhere/repo",
      model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
      workspace: {
        current_dir: "/elsewhere/repo",
        project_dir: "/elsewhere/repo",
      },
    },
    cwd: "/elsewhere/repo",
    hints: parseClientHints({ termCols: 120, ssh: true }),
  };
}

const HOME = "/home/recorded";
const header: RecordingLine = {
  kind: "recording",
  session: SESSION,
  home: HOME,
};
const facts = (s: number, seq: number): RecordingLine => ({
  kind: "facts",
  at: at(s),
  facts: document(seq),
});
const requested = (s: number): RecordingLine => ({
  kind: "request",
  at: at(s),
  request: request(),
});
// What a session's clicks left for a draw: a pick, an open menu, two steps to
// undo, one to go back to, and a menu idle since half a second in.
const STATE: DrawState = {
  values: { preset: "nord", "settings.menu": "open" },
  revision: 7,
  history: { undo: 2, redo: 0, sinceEdit: 0 },
  back: 1,
  idleSince: at(0.5),
};
const drawn = (s: number, state: DrawState = STATE): RecordingLine => ({
  kind: "draw",
  request: at(s),
  state,
});
const text = (...lines: RecordingLine[]): string =>
  lines.map(formatLine).join("");

test("what the recorder writes reads back as itself, opening on the last document before the first request", () => {
  expect(
    parseRecording(
      text(
        header,
        facts(0, 1),
        facts(0.2, 2),
        requested(0.5),
        facts(1.5, 3),
        drawn(0.5),
      ),
    ),
  ).toEqual({
    session: SESSION,
    home: HOME,
    opening: { at: at(0.2), facts: document(2) },
    lines: [
      { kind: "request", at: at(0.5), request: request() },
      { kind: "facts", at: at(1.5), facts: document(3) },
      { kind: "draw", request: at(0.5), state: STATE },
    ],
  });
});

test("a draw carries the session's state it read, and an idle period not begun reads back as none", () => {
  const idle = { ...STATE, idleSince: undefined };
  const { lines } = parseRecording(
    text(header, facts(0, 1), requested(1), drawn(1, idle)),
  );
  expect(lines.at(-1)).toEqual({ kind: "draw", request: at(1), state: idle });
});

test("a draw whose state is missing or malformed is refused by its line, naming what is wrong", () => {
  const drawWith = (state: unknown): string =>
    text(header, facts(0, 1), requested(1)) +
    `${JSON.stringify({ kind: "draw", request: at(1), state })}\n`;
  const wire = { ...STATE, idleSince: at(0.5) };
  expect(() => parseRecording(drawWith(undefined))).toThrow(
    /^line 4: has no `state` object/,
  );
  expect(() =>
    parseRecording(drawWith({ ...wire, values: { preset: 3 } })),
  ).toThrow(/^line 4: has no `state.values` of strings by key/);
  expect(() => parseRecording(drawWith({ ...wire, revision: -1 }))).toThrow(
    /^line 4: has no count `state.revision`/,
  );
  expect(() =>
    parseRecording(
      drawWith({ ...wire, history: { ...wire.history, undo: 1.5 } }),
    ),
  ).toThrow(/^line 4: has no count `state.history.undo`/);
  expect(() => parseRecording(drawWith({ ...wire, back: "1" }))).toThrow(
    /^line 4: has no count `state.back`/,
  );
  expect(() =>
    parseRecording(drawWith({ ...wire, idleSince: "soon" })),
  ).toThrow(/^line 4: has no finite `state.idleSince`/);
});

test("a line that is not JSON, or not a line, is refused by its number", () => {
  const good = text(header, facts(0, 1));
  expect(() => parseRecording(`${good}{not json\n`)).toThrow(
    /^line 3: is not JSON/,
  );
  expect(() => parseRecording(`${good}[1,2]\n`)).toThrow(
    /^line 3: is not an object/,
  );
  expect(() =>
    parseRecording(
      `${good}${JSON.stringify({ kind: "facts", facts: document(1) })}\n`,
    ),
  ).toThrow(/^line 3: has no finite `at`/);
  expect(() =>
    parseRecording(`${good}${JSON.stringify({ kind: "facts", at: AT })}\n`),
  ).toThrow(/^line 3 facts: is not an object/);
  expect(() =>
    parseRecording(`${good}${JSON.stringify({ kind: "frame", at: AT })}\n`),
  ).toThrow(/^line 3: is of kind "frame"/);
});

test("a file cut inside its last line is refused naming that line, never read as a shorter recording", () => {
  const whole = text(header, facts(0, 1), requested(1), facts(2, 2));
  expect(() => parseRecording(whole.slice(0, -1))).toThrow(
    /^line 4: ends without its newline/,
  );
  expect(() => parseRecording(whole.slice(0, -20))).toThrow(
    /^line 4: ends without its newline/,
  );
  expect(() => parseRecording("")).toThrow(
    /^line 1: is missing: the recording is empty/,
  );
});

test("the first line is the header, and it names this build's recording format", () => {
  expect(() => parseRecording(text(facts(0, 1), requested(1)))).toThrow(
    /^line 1: is not a recording's header/,
  );
  // Another format's header, the shipped first format's among them, is
  // refused by its version before any line is read.
  for (const v of [RECORDING_VERSION - 1, RECORDING_VERSION + 1]) {
    const other = `${JSON.stringify({ kind: "recording", v, session: SESSION })}\n`;
    expect(() => parseRecording(other)).toThrow(RecordingVersionError);
    expect(() => parseRecording(other)).toThrow(
      `is a v${v} recording; this build reads v${RECORDING_VERSION}`,
    );
  }
});

test("a recording holding a document of another facts version is refused at that document's line", () => {
  const otherFacts = `${JSON.stringify({ kind: "facts", at: at(0), facts: { ...document(1), v: FACTS_VERSION + 1 } })}\n`;
  expect(() =>
    parseRecording(text(header) + otherFacts + text(requested(1), drawn(1))),
  ).toThrow(
    new RegExp(
      `^line 2 facts: is facts version ${FACTS_VERSION + 1}, and this build reads ${FACTS_VERSION}`,
    ),
  );
});

test("the header names the home the payloads were composed against, as an absolute path", () => {
  const headed = (home: unknown): string =>
    `${JSON.stringify({ kind: "recording", v: RECORDING_VERSION, session: SESSION, home })}\n` +
    text(facts(0, 1), requested(1), drawn(1));
  expect(parseRecording(headed(HOME)).home).toBe(HOME);
  for (const home of [undefined, null, "relative/home", 7]) {
    expect(() => parseRecording(headed(home))).toThrow(
      /^line 1: has no `home` that is an absolute path/,
    );
  }
});

test("a recording is one session's, read in the file's order, with a document before its first request", () => {
  const foreign: RecordingLine = {
    kind: "facts",
    at: at(1),
    facts: { ...document(2), session: sessionIdOf("another") },
  };
  expect(() => parseRecording(text(header, facts(0, 1), foreign))).toThrow(
    /^line 3: is session "another"'s document, and the recording is of "rec-session"/,
  );
  const elsewhere = request();
  const strayed: RecordingLine = {
    kind: "request",
    at: at(1),
    request: {
      ...elsewhere,
      hookData: { ...elsewhere.hookData, session_id: "another" },
    },
  };
  expect(() => parseRecording(text(header, facts(0, 1), strayed))).toThrow(
    /^line 3: is session "another"'s request, and the recording is of "rec-session"/,
  );
  // The file's order is the replay's, whatever the instants say: a held
  // view's document written for its draw can be older than the line ahead of
  // it, and a request's instant is read before its turn queues.
  const { lines } = parseRecording(
    text(
      header,
      facts(2, 1),
      requested(3),
      facts(1, 2),
      requested(2),
      drawn(3),
      drawn(2),
    ),
  );
  expect(lines.map((line) => line.kind)).toEqual([
    "request",
    "facts",
    "request",
    "draw",
    "draw",
  ]);
  expect(() => parseRecording(text(header))).toThrow(
    /^the recording: holds no document/,
  );
  expect(() => parseRecording(text(header, requested(0), facts(1, 1)))).toThrow(
    /^line 2: is a request before any document/,
  );
});

test("a draw answers a request before it that is not drawn already, and requests sharing an instant are drawn once each", () => {
  expect(() =>
    parseRecording(text(header, facts(0, 1), drawn(1), requested(1))),
  ).toThrow(
    /^line 3: draws the answer to a request at .*, and no request line before it arrived then/,
  );
  expect(() =>
    parseRecording(text(header, facts(0, 1), requested(1), drawn(1), drawn(1))),
  ).toThrow(/^line 5: draws the answer to a request at /);
  const twice = parseRecording(
    text(header, facts(0, 1), requested(1), requested(1), drawn(1), drawn(1)),
  );
  expect(twice.lines.filter((line) => line.kind === "draw")).toHaveLength(2);
  expect(() =>
    parseRecording(
      text(header, facts(0, 1), requested(1)) +
        `${JSON.stringify({ kind: "draw" })}\n`,
    ),
  ).toThrow(/^line 4: has no finite `request`/);
});

test("a declaration restates a request ahead of a draw: read back as itself, never an arrival, and refused before any request", () => {
  const declared: RecordingLine = { kind: "declared", request: request() };
  const { lines } = parseRecording(
    text(header, facts(0, 1), requested(1), declared, drawn(1)),
  );
  expect(lines[1]).toEqual(declared);
  // Not an arrival: a draw cannot answer it.
  expect(() =>
    parseRecording(
      text(header, facts(0, 1), requested(1), declared, drawn(1), drawn(1)),
    ),
  ).toThrow(/^line 6: draws the answer to a request at /);
  expect(() =>
    parseRecording(text(header, facts(0, 1), declared, requested(1), drawn(1))),
  ).toThrow(/^line 3: is a declaration before any request/);
});

test("a recording no answer was drawn in is refused: a replay draws one frame per answer", () => {
  for (const unanswered of [
    text(header, facts(0, 1), facts(1, 2)),
    text(header, facts(0, 1), requested(1), facts(2, 2)),
  ]) {
    expect(() => parseRecording(unanswered)).toThrow(
      /^the recording: holds no answered request: none was answered while it was recorded/,
    );
  }
});

test("a request line crosses the hook and hint checkpoints", () => {
  const raw = JSON.parse(formatLine(requested(1))) as Record<string, unknown>;
  const line = (patch: Record<string, unknown>): string =>
    text(header, facts(0, 1)) + `${JSON.stringify({ ...raw, ...patch })}\n`;
  expect(() => parseRecording(line({ hookData: { cwd: "/x" } }))).toThrow(
    /^line 3: has no hookData\.session_id/,
  );
  expect(() => parseRecording(line({ cwd: "relative" }))).toThrow(
    /^line 3: has a `cwd` that is not an absolute path/,
  );
  expect(() => parseRecording(line({ hints: 7 }))).toThrow(
    /^line 3: has no `hints` object/,
  );
  // A hint the checkpoint refuses is absent, as a live client's is.
  const parsed = parseRecording(
    line({ hints: { termCols: "wide", ssh: true } }) + formatLine(drawn(1)),
  );
  expect(parsed.lines[0].request.hints).toEqual({ ssh: true });
});

test("a partial document is refused naming the field", () => {
  const whole = document(1) as unknown as Record<string, unknown>;
  const { builtins: _builtins, ...withoutBuiltins } = whole;
  const head = text(header);
  expect(() =>
    parseRecording(
      `${head}${JSON.stringify({ kind: "facts", at: AT, facts: withoutBuiltins })}\n`,
    ),
  ).toThrow(/^line 2 facts: has no `builtins`/);
  const broken = {
    ...whole,
    builtins: { ...(whole.builtins as object), git: { kind: "ok", value: 1 } },
  };
  expect(() =>
    parseRecording(
      `${head}${JSON.stringify({ kind: "facts", at: AT, facts: broken })}\n`,
    ),
  ).toThrow(/^line 2 facts builtins.git: has no finite `at`/);
});

test("a document of another facts version is refused", () => {
  const other = { ...document(1), v: FACTS_VERSION + 1 };
  expect(() => parseSessionFacts(other, "line 1")).toThrow(
    new RegExp(
      `^line 1: is facts version ${FACTS_VERSION + 1}, and this build reads ${FACTS_VERSION}`,
    ),
  );
});

test("a pending that crossed as JSON is a pending, not a value", () => {
  const parsed = parseSessionFacts(
    JSON.parse(JSON.stringify(document(1))),
    "line 1",
  );
  expect(parsed.builtins.session).toEqual({ kind: "pending", why: "unread" });
  expect(parsed.builtins.git.kind).toBe("ok");
});

test("a replay's clock starts at the first request, however long the view sat before it, and its steps keep the file's order", () => {
  const reached: FactsLine[] = [];
  const play = playOf(
    parseRecording(
      text(
        header,
        facts(0, 1),
        requested(7200),
        requested(7201),
        facts(7201.5, 2),
        drawn(7200),
        drawn(7201),
      ),
    ),
    { reach: (line) => reached.push(line) },
  );
  expect(play.startMs).toBe(Math.round(at(7200) * 1000));
  expect(
    play.steps.map((step) =>
      step.kind === "request"
        ? `request +${step.offsetMs}`
        : step.kind === "draw"
          ? `draw of +${step.requestOffsetMs}`
          : "document",
    ),
  ).toEqual([
    "request +0",
    "request +1000",
    "document",
    "draw of +0",
    "draw of +1000",
  ]);
  // A document step reaches the arm when it is taken, not when it is built.
  expect(reached).toEqual([]);
  for (const step of play.steps) if (step.kind === "document") step.reach();
  expect(reached).toEqual([
    { kind: "facts", at: at(7201.5), facts: document(2) },
  ]);
});
