// [LAW:parse-dont-validate] A recording's text crosses one unit into a typed
// recording: a line that is not one is refused naming its number, a recording
// of another version, of no answered request or opening on anything but a turn
// is refused whole, and what the recorder writes reads back as itself.

import { restamp } from "../../src/facts/fact";
import {
  formatLine,
  parseRecording,
  parseSessionFacts,
  RECORDING_VERSION,
  RecordingVersionError,
  type ClickState,
  type DrawState,
  type FactsLine,
  type RecordingLine,
  type RequestLine,
} from "../../src/facts/recording";
import { FACTS_VERSION } from "../../src/facts/session-facts";
import { playOf, type DemoStep } from "../../src/demo/play";
import { parseClientHints } from "../../src/daemon/protocol";
import { sessionIdOf } from "../../src/daemon/session-id";
import { instantOf, type Instant } from "../../src/utils/instant";
import { ok } from "../../src/utils/outcome";
import {
  collectDiagnostics,
  type DiagnosticList,
} from "../../src/render/diagnostics";
import { pendingFacts } from "../helpers/facts";
import { TEST_LINKS } from "../helpers/link-signer";
import {
  ANSWERING,
  UNFOLLOWED_FEEDS,
  type LaneFeeds,
} from "../../src/config/lanes";

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
// What a draw built for its reader: an error and a warning, the error's first
// line carrying its copy click.
const DIAGNOSTICS: DiagnosticList = collectDiagnostics(
  TEST_LINKS.to,
  SESSION,
  "request",
  [{ about: "load", text: "the config failed to load", copy: "fix it" }],
  [],
  [{ about: "facts", text: "the bar is drawn from older facts", copy: "x" }],
);
// What each lane's feed was doing: the pane lane followed by one subscriber,
// sent 24 frames in the last second while its pane is on a screen.
const FEEDS: LaneFeeds = {
  ...UNFOLLOWED_FEEDS,
  pane: { subscribers: 1, fps: 24, shown: true },
};
// An answer to the request at `s`.
const drawn = (
  s: number,
  state: DrawState = STATE,
  diagnostics: DiagnosticList = DIAGNOSTICS,
): RecordingLine => ({
  kind: "draw",
  at: at(s),
  drawing: ANSWERING,
  feeds: FEEDS,
  state,
  diagnostics,
});
// A frame the pane lane's feed drew at `s`, between whole milliseconds as a
// feed's frames are.
const framed = (s: number): RecordingLine => ({
  kind: "draw",
  at: at(s),
  drawing: { by: "feed", fps: 30 },
  feeds: FEEDS,
  state: STATE,
  diagnostics: DIAGNOSTICS,
});
// The clicks' state a turn was taken over.
const CLICKS: ClickState = {
  values: STATE.values,
  revision: STATE.revision,
  history: STATE.history,
  back: STATE.back,
};
// The turn the bar is drawn from, held on or not.
const turned = (s: number, seq: number, held = false): RecordingLine => ({
  kind: "turn",
  held,
  document: { at: at(s), facts: document(seq) },
  request: request(),
  state: CLICKS,
});
const text = (...lines: RecordingLine[]): string =>
  lines.map(formatLine).join("");

test("what the recorder writes reads back as itself, opening on the turn the bar is drawn from", () => {
  expect(
    parseRecording(
      text(
        header,
        turned(0, 1),
        facts(0.2, 2),
        requested(0.5),
        facts(1.5, 3),
        drawn(0.5),
        turned(2, 3, true),
      ),
    ),
  ).toEqual({
    session: SESSION,
    home: HOME,
    opening: {
      held: false,
      document: { at: at(0), facts: document(1) },
      request: request(),
      state: CLICKS,
    },
    lines: [
      { kind: "facts", at: at(0.2), facts: document(2) },
      { kind: "request", at: at(0.5), request: request() },
      { kind: "facts", at: at(1.5), facts: document(3) },
      {
        kind: "draw",
        at: at(0.5),
        drawing: ANSWERING,
        feeds: FEEDS,
        state: STATE,
        diagnostics: DIAGNOSTICS,
      },
      {
        kind: "turn",
        held: true,
        document: { at: at(2), facts: document(3) },
        request: request(),
        state: CLICKS,
      },
    ],
  });
});

test("a state line reads back as itself, and is refused when its state is not one or reads a revision over other values", () => {
  const moved: ClickState = {
    ...CLICKS,
    values: { ...CLICKS.values, "seam.detail": "on" },
    revision: CLICKS.revision + 1,
  };
  const state: RecordingLine = { kind: "state", state: moved };
  expect(
    parseRecording(
      text(header, turned(0, 1), state, facts(0.2, 2), requested(1), drawn(1)),
    ).lines.slice(0, 2),
  ).toEqual([state, { kind: "facts", at: at(0.2), facts: document(2) }]);
  expect(() =>
    parseRecording(
      text(header, turned(0, 1)) +
        `${JSON.stringify({ kind: "state", state: "on" })}\n`,
    ),
  ).toThrow(/^line 3: has no `state` object/);
  expect(() =>
    parseRecording(
      text(header, turned(0, 1), {
        kind: "state",
        state: { ...moved, revision: CLICKS.revision },
      }),
    ),
  ).toThrow(
    /^line 3: reads revision \d+ over other values than a line before it read there/,
  );
});

test("a recording opens on a turn, and a turn line is refused by its line when it is not one", () => {
  expect(() =>
    parseRecording(text(header, facts(0, 1), requested(1), drawn(1))),
  ).toThrow(
    /^line 2: is not a turn: a recording opens on the turn its bar is drawn from/,
  );
  expect(() => parseRecording(text(header))).toThrow(
    /^the recording: holds no turn/,
  );
  const raw = JSON.parse(formatLine(turned(0, 1))) as Record<string, unknown>;
  const opening = (patch: Record<string, unknown>): string =>
    text(header) +
    `${JSON.stringify({ ...raw, ...patch })}\n` +
    text(requested(1), drawn(1));
  expect(() => parseRecording(opening({ held: "yes" }))).toThrow(
    /^line 2: has no `held` that is true or false/,
  );
  expect(() => parseRecording(opening({ state: undefined }))).toThrow(
    /^line 2: has no `state` object/,
  );
  expect(() => parseRecording(opening({ cwd: "relative" }))).toThrow(
    /^line 2: has no `cwd` that is an absolute path/,
  );
  expect(() => parseRecording(opening({ facts: undefined }))).toThrow(
    /^line 2 facts: is not an object/,
  );
});

test("one revision is one state across turns and draws: a turn over other values than a draw read there is refused", () => {
  expect(() =>
    parseRecording(
      text(
        header,
        turned(0, 1),
        requested(1),
        drawn(1, { ...STATE, values: { preset: "dracula" } }),
      ),
    ),
  ).toThrow(/^line 4: reads revision 7 over other values/);
});

test("a draw carries the diagnostics it built, read back as data, and refused by its line when malformed", () => {
  const { lines } = parseRecording(
    text(header, turned(0, 1), requested(1), drawn(1)),
  );
  expect(lines.at(-1)).toMatchObject({ diagnostics: DIAGNOSTICS });
  const raw = JSON.parse(formatLine(drawn(1))) as Record<string, unknown>;
  const message = DIAGNOSTICS[0] as unknown as Record<string, unknown>;
  const drawWith = (diagnostics: unknown): string =>
    text(header, turned(0, 1), requested(1)) +
    `${JSON.stringify({ ...raw, diagnostics })}\n`;
  expect(() => parseRecording(drawWith(undefined))).toThrow(
    /^line 4: has no `diagnostics` list/,
  );
  expect(() =>
    parseRecording(
      drawWith([{ ...message, severity: { level: "error", glyph: "!" } }]),
    ),
  ).toThrow(
    /^line 4 diagnostics\[0\] severity: has no `colors` with `fg` and `bg`/,
  );
  expect(() =>
    parseRecording(
      drawWith([
        {
          ...message,
          severity: { ...(message.severity as object), level: "fatal" },
        },
      ]),
    ),
  ).toThrow(
    /^line 4 diagnostics\[0\] severity: has no `level` that is error or warning/,
  );
  expect(() => parseRecording(drawWith([{ ...message, lines: [] }]))).toThrow(
    /^line 4 diagnostics\[0\]: has no `lines`/,
  );
  expect(() =>
    parseRecording(
      drawWith([{ ...message, lines: [[{ text: 1, link: null }]] }]),
    ),
  ).toThrow(/^line 4 diagnostics\[0\] lines\[0\]\[0\]: has no text `text`/);
  expect(() => parseRecording(drawWith([{ ...message, copy: 7 }]))).toThrow(
    /^line 4 diagnostics\[0\]: has no text `copy`/,
  );
});

test("a draw carries the session's state it read, and an idle period not begun reads back as none", () => {
  const idle = { ...STATE, idleSince: undefined };
  const { lines } = parseRecording(
    text(header, turned(0, 1), requested(1), drawn(1, idle)),
  );
  expect(lines.at(-1)).toEqual({
    kind: "draw",
    at: at(1),
    drawing: ANSWERING,
    feeds: FEEDS,
    state: idle,
    diagnostics: DIAGNOSTICS,
  });
});

test("a draw whose state is missing or malformed is refused by its line, naming what is wrong", () => {
  const drawWith = (state: unknown): string =>
    text(header, turned(0, 1), requested(1)) +
    `${JSON.stringify({ kind: "draw", at: at(1), drawing: ANSWERING, state })}\n`;
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

test("a draw's state the store could not have held is refused by its line", () => {
  // The store is at revision 0 exactly while it holds nothing for the
  // session, and one revision is one state.
  expect(() =>
    parseRecording(
      text(
        header,
        turned(0, 1),
        requested(1),
        drawn(1, { ...STATE, revision: 0 }),
      ),
    ),
  ).toThrow(/^line 4: has `state.revision` 0 over 2 values/);
  expect(() =>
    parseRecording(
      text(
        header,
        turned(0, 1),
        requested(1),
        drawn(1, { ...STATE, values: {} }),
      ),
    ),
  ).toThrow(/^line 4: has `state.revision` 7 over 0 values/);
  expect(() =>
    parseRecording(
      text(
        header,
        turned(0, 1),
        requested(1),
        drawn(1),
        requested(2),
        drawn(2, { ...STATE, values: { preset: "dracula" } }),
      ),
    ),
  ).toThrow(/^line 6: reads revision 7 over other values/);
});

test("a line that is not JSON, or not a line, is refused by its number", () => {
  const good = text(header, turned(0, 1));
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
  const whole = text(header, turned(0, 1), requested(1), facts(2, 2));
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
    parseRecording(
      text(header, turned(0, 1)) + otherFacts + text(requested(1), drawn(1)),
    ),
  ).toThrow(
    new RegExp(
      `^line 3 facts: is facts version ${FACTS_VERSION + 1}, and this build reads ${FACTS_VERSION}`,
    ),
  );
});

test("the header names the home the payloads were composed against, as an absolute path", () => {
  const headed = (home: unknown): string =>
    `${JSON.stringify({ kind: "recording", v: RECORDING_VERSION, session: SESSION, home })}\n` +
    text(turned(0, 1), requested(1), drawn(1));
  expect(parseRecording(headed(HOME)).home).toBe(HOME);
  for (const home of [undefined, null, "relative/home", 7]) {
    expect(() => parseRecording(headed(home))).toThrow(
      /^line 1: has no `home` that is an absolute path/,
    );
  }
});

test("a recording is one session's, read in the file's order", () => {
  const foreign: RecordingLine = {
    kind: "facts",
    at: at(1),
    facts: { ...document(2), session: sessionIdOf("another") },
  };
  expect(() => parseRecording(text(header, turned(0, 1), foreign))).toThrow(
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
  expect(() => parseRecording(text(header, turned(0, 1), strayed))).toThrow(
    /^line 3: is session "another"'s request, and the recording is of "rec-session"/,
  );
  // The file's order is the replay's, whatever the instants say: a held
  // view's document written for its draw can be older than the line ahead of
  // it, and a request's instant is read before its turn queues.
  const { lines } = parseRecording(
    text(
      header,
      turned(2, 1),
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
  const foreignTurn: RecordingLine = {
    kind: "turn",
    held: false,
    document: {
      at: at(0),
      facts: { ...document(1), session: sessionIdOf("another") },
    },
    request: request(),
    state: CLICKS,
  };
  expect(() => parseRecording(text(header, foreignTurn))).toThrow(
    /^line 2: is session "another"'s document/,
  );
});

test("a draw answers a request before it that is not drawn already, and requests sharing an instant are drawn once each", () => {
  expect(() =>
    parseRecording(text(header, turned(0, 1), drawn(1), requested(1))),
  ).toThrow(
    /^line 3: draws the answer to a request at .*, and no request line before it arrived then/,
  );
  expect(() =>
    parseRecording(
      text(header, turned(0, 1), requested(1), drawn(1), drawn(1)),
    ),
  ).toThrow(/^line 5: draws the answer to a request at /);
  const twice = parseRecording(
    text(header, turned(0, 1), requested(1), requested(1), drawn(1), drawn(1)),
  );
  expect(twice.lines.filter((line) => line.kind === "draw")).toHaveLength(2);
  expect(() =>
    parseRecording(
      text(header, turned(0, 1), requested(1)) +
        `${JSON.stringify({ kind: "draw" })}\n`,
    ),
  ).toThrow(/^line 4: has no finite `at`/);
});

test("a lane's frame answers no request: it needs none before it, and an answer at its instant still has its request to draw", () => {
  const alone = parseRecording(text(header, turned(0, 1), framed(0.0337)));
  expect(alone.lines).toEqual([
    {
      kind: "draw",
      at: at(0.0337),
      drawing: { by: "feed", fps: 30 },
      feeds: FEEDS,
      state: STATE,
      diagnostics: DIAGNOSTICS,
    },
  ]);
  const beside = parseRecording(
    text(header, turned(0, 1), requested(1), framed(1), drawn(1)),
  );
  expect(beside.lines.filter((line) => line.kind === "draw")).toHaveLength(2);
});

test("what a draw was handed is refused by its line when malformed, naming the field", () => {
  const raw = JSON.parse(formatLine(framed(1))) as Record<string, unknown>;
  const line = (patch: Record<string, unknown>): string =>
    text(header, turned(0, 1)) + `${JSON.stringify({ ...raw, ...patch })}\n`;
  expect(() => parseRecording(line({ drawing: undefined }))).toThrow(
    /^line 3: has no `drawing` object/,
  );
  expect(() => parseRecording(line({ drawing: { by: "tmux" } }))).toThrow(
    /^line 3: has no `drawing.by` that is request or feed/,
  );
  expect(() =>
    parseRecording(line({ drawing: { by: "feed", fps: 0.5 } })),
  ).toThrow(/^line 3: has no count `drawing.fps`/);
  expect(() => parseRecording(line({ feeds: undefined }))).toThrow(
    /^line 3: has no `feeds` object/,
  );
  expect(() =>
    parseRecording(line({ feeds: { ...FEEDS, sidecar: FEEDS.pane } })),
  ).toThrow(
    /^line 3: has a feed of lane "sidecar", which this build does not draw/,
  );
  const { band: _band, ...noBand } = FEEDS;
  expect(() => parseRecording(line({ feeds: noBand }))).toThrow(
    /^line 3: has no `feeds.band` object/,
  );
  expect(() =>
    parseRecording(
      line({ feeds: { ...FEEDS, pane: { ...FEEDS.pane, subscribers: -1 } } }),
    ),
  ).toThrow(/^line 3: has no count `feeds.pane.subscribers`/);
  expect(() =>
    parseRecording(
      line({ feeds: { ...FEEDS, pane: { ...FEEDS.pane, shown: 1 } } }),
    ),
  ).toThrow(/^line 3: has no `feeds.pane.shown` that is true or false/);
});

test("a declaration restates a request ahead of a draw: read back as itself, never an arrival, and ahead of a lane's frame before any request", () => {
  const declared: RecordingLine = { kind: "declared", request: request() };
  const { lines } = parseRecording(
    text(header, turned(0, 1), requested(1), declared, drawn(1)),
  );
  expect(lines[1]).toEqual(declared);
  // Not an arrival: a draw cannot answer it.
  expect(() =>
    parseRecording(
      text(header, turned(0, 1), requested(1), declared, drawn(1), drawn(1)),
    ),
  ).toThrow(/^line 6: draws the answer to a request at /);
  // A lane's frame can restate its view's declaration before any request.
  expect(
    parseRecording(text(header, turned(0, 1), declared, framed(0.5))).lines,
  ).toEqual([declared, framed(0.5)]);
});

test("a recording nothing was drawn in is refused: a replay draws one frame per draw", () => {
  for (const undrawn of [
    text(header, turned(0, 1), facts(1, 2)),
    text(header, turned(0, 1), requested(1), facts(2, 2)),
  ]) {
    expect(() => parseRecording(undrawn)).toThrow(
      /^the recording: holds no draw: no request was answered and no lane drew a frame while it was recorded/,
    );
  }
});

test("a request line crosses the hook and hint checkpoints", () => {
  const raw = JSON.parse(formatLine(requested(1))) as Record<string, unknown>;
  const line = (patch: Record<string, unknown>): string =>
    text(header, turned(0, 1)) + `${JSON.stringify({ ...raw, ...patch })}\n`;
  expect(() => parseRecording(line({ hookData: { cwd: "/x" } }))).toThrow(
    /^line 3: has no hookData\.session_id/,
  );
  // A replay opens the view where the request came from.
  for (const cwd of ["relative", undefined]) {
    expect(() => parseRecording(line({ cwd }))).toThrow(
      /^line 3: has no `cwd` that is an absolute path/,
    );
  }
  expect(() => parseRecording(line({ hints: 7 }))).toThrow(
    /^line 3: has no `hints` object/,
  );
  // A hint the checkpoint refuses is absent, as a live client's is.
  const parsed = parseRecording(
    line({ hints: { termCols: "wide", ssh: true } }) + formatLine(drawn(1)),
  );
  expect(parsed.lines[0]).toMatchObject({ request: { hints: { ssh: true } } });
});

test("a partial document is refused naming the field", () => {
  const whole = document(1) as unknown as Record<string, unknown>;
  const { builtins: _builtins, ...withoutBuiltins } = whole;
  const head = text(header, turned(0, 1));
  expect(() =>
    parseRecording(
      `${head}${JSON.stringify({ kind: "facts", at: AT, facts: withoutBuiltins })}\n`,
    ),
  ).toThrow(/^line 3 facts: has no `builtins`/);
  const broken = {
    ...whole,
    builtins: { ...(whole.builtins as object), git: { kind: "ok", value: 1 } },
  };
  expect(() =>
    parseRecording(
      `${head}${JSON.stringify({ kind: "facts", at: AT, facts: broken })}\n`,
    ),
  ).toThrow(/^line 3 facts builtins.git: has no finite `at`/);
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

// Where a play's step is drawn or arrives, from the clock's start.
const stepOf = (step: DemoStep): string =>
  step.kind === "request"
    ? `request +${step.offsetMs}`
    : step.kind === "draw"
      ? "instant" in step.at
        ? `${step.handed.drawing.by} at ${step.at.instant}`
        : `answer of +${step.at.request}`
      : step.kind === "turn"
        ? `turn${step.turn.held ? " held" : ""}`
        : step.kind === "state"
          ? "state"
          : "document";

test("a replay's clock starts at the first request, however long the view sat before it, and its steps keep the file's order, a turn's among them", () => {
  const reached: FactsLine[] = [];
  const play = playOf(
    parseRecording(
      text(
        header,
        turned(0, 1),
        requested(7200),
        requested(7201),
        facts(7201.5, 2),
        drawn(7200),
        turned(7201.7, 2, true),
        drawn(7201),
      ),
    ),
    { reach: (line) => reached.push(line) },
  );
  // The view opens on the opening turn, before any step.
  expect(play.opening).toMatchObject({ held: false, state: CLICKS });
  expect(play.startMs).toBe(Math.round(at(7200) * 1000));
  expect(play.steps.map(stepOf)).toEqual([
    "request +0",
    "request +1000",
    "document",
    `request at ${at(7200)}`,
    "turn held",
    `request at ${at(7201)}`,
  ]);
  // A document step reaches the arm when it is taken, not when it is built.
  expect(reached).toEqual([]);
  for (const step of play.steps) {
    if (step.kind === "document" || step.kind === "turn") step.reach();
  }
  expect(reached).toEqual([
    { kind: "facts", at: at(7201.5), facts: document(2) },
    { at: at(7201.7), facts: document(2) },
  ]);
});

test("a lane's frame is drawn at its own instant, exactly, and a recording that opens on one starts its clock there", () => {
  const play = playOf(
    parseRecording(
      text(
        header,
        turned(0, 1),
        framed(7199.9337),
        requested(7200),
        drawn(7200),
      ),
    ),
    { reach: () => {} },
  );
  expect(play.startMs).toBe(Math.round(at(7199.9337) * 1000));
  expect(play.steps.map(stepOf)).toEqual([
    `feed at ${at(7199.9337)}`,
    "request +66",
    `request at ${at(7200)}`,
  ]);
});
