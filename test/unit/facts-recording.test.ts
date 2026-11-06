// [LAW:parse-dont-validate] A recording's text crosses one unit into a typed
// recording: a line that is not one is refused naming its number, a recording
// of another version or of no request is refused whole, and what the recorder
// writes reads back as itself.

import { restamp } from "../../src/facts/fact";
import {
  formatLine,
  parseRecording,
  parseSessionFacts,
  RecordingVersionError,
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

const header: RecordingLine = { kind: "recording", session: SESSION };
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
const text = (...lines: RecordingLine[]): string =>
  lines.map(formatLine).join("");

test("what the recorder writes reads back as itself", () => {
  expect(
    parseRecording(text(header, facts(0, 1), requested(0.5), facts(1.5, 2))),
  ).toEqual({
    session: SESSION,
    facts: [
      { at: at(0), facts: document(1) },
      { at: at(1.5), facts: document(2) },
    ],
    requests: [{ at: at(0.5), request: request() }],
  });
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

test("the first line is the header, and it names this build's facts version", () => {
  expect(() => parseRecording(text(facts(0, 1), requested(1)))).toThrow(
    /^line 1: is not a recording's header/,
  );
  const other = `${JSON.stringify({ kind: "recording", v: FACTS_VERSION + 1, session: SESSION })}\n`;
  expect(() => parseRecording(other)).toThrow(RecordingVersionError);
  expect(() => parseRecording(other)).toThrow(
    `is a facts v${FACTS_VERSION + 1} recording; this build reads v${FACTS_VERSION}`,
  );
});

test("a recording is one session's, each kind of line in time order, with a document before its first request", () => {
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
  expect(() =>
    parseRecording(text(header, facts(2, 1), requested(3), facts(1, 2))),
  ).toThrow(
    /^line 4: \(at .*\) is before line 2 .*facts lines are in time order/,
  );
  expect(() =>
    parseRecording(text(header, facts(0, 1), requested(3), requested(2))),
  ).toThrow(
    /^line 4: \(at .*\) is before line 3 .*request lines are in time order/,
  );
  // A document stamped after a request it came out of is in order: each
  // kind keeps its own time.
  expect(() =>
    parseRecording(text(header, facts(0, 1), facts(2, 2), requested(1))),
  ).not.toThrow();
  expect(() => parseRecording(text(header, requested(1)))).toThrow(
    /^the recording: holds no document/,
  );
  expect(() => parseRecording(text(header, requested(0), facts(1, 1)))).toThrow(
    /^the recording: has a request .* before its first document/,
  );
});

test("a recording no request arrived in is refused: a replay draws one frame per request", () => {
  expect(() => parseRecording(text(header, facts(0, 1), facts(1, 2)))).toThrow(
    /^the recording: holds no request: none arrived while it was recorded/,
  );
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
    line({ hints: { termCols: "wide", ssh: true } }) + formatLine(facts(2, 2)),
  );
  expect(parsed.requests[0].request.hints).toEqual({ ssh: true });
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

test("a replay's clock starts at the first request, however long the view sat before it", () => {
  const play = playOf(
    parseRecording(text(header, facts(0, 1), requested(7200), requested(7201))),
  );
  expect(play.startMs).toBe(Math.round(at(7200) * 1000));
  expect(play.ticks.map((t) => t.offsetMs)).toEqual([0, 1000]);
});
