import { textOf } from "../src/render/frame";
// [LAW:behavior-not-structure] The gate for brandon-activity-ue7: what the bar
// SAYS Claude is doing, for a given transcript. Every test writes real JSONL and
// reads either the provider's record, the payload the daemon would send, or the
// rendered cell — never the fold's internal state.

import { drawPayload } from "./helpers/draw-payload";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ActivityProvider, type ActivityInfo } from "../src/segments/activity";
import type { RenderPayloadDeps } from "../src/daemon/render-payload";
import { type EffectiveGlobals } from "../src/config/effective-globals";
import { globalsFor } from "./helpers/selection";
import { ABSENT, ok } from "../src/utils/outcome";
import { entryActivity } from "../src/utils/transcript-activity";
import { userEntryOf, type ClaudeHookData } from "../src/utils/claude";
import {
  RAW_DEFAULT_DSL_CONFIG,
  DEFAULT_DSL_CONFIG,
} from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { narrowToSegment } from "./helpers/narrow-to-segment";
import { registerDslConfig } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { NO_CONFIG_FILE } from "./helpers/config-file-facts";
import { instantOf } from "../src/utils/instant";
import {
  absentOwners,
  fakeActivity,
  fakeContext,
  fakeGit,
  fakeMetrics,
  fakeTmux,
  fakeUsage,
  requestPayload,
} from "./helpers/payload-owners";

// ─── fixtures ────────────────────────────────────────────────────────────────

let clock = 0;
const stamp = (): string =>
  new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

const userText = (text: string): string =>
  JSON.stringify({
    timestamp: stamp(),
    type: "user",
    message: { role: "user", content: text },
  });

// A "user" entry Claude Code writes itself (`isMeta: true`), never typed by a
// person — here the nudge it sends after an empty response, seen mid-turn in
// a real transcript (brandon-effects-2gka.2rm).
const metaUser = (text: string): string =>
  JSON.stringify({
    timestamp: stamp(),
    type: "user",
    isMeta: true,
    message: { role: "user", content: [{ type: "text", text }] },
  });

// A task notification: Claude Code wakes Claude for another turn of the same
// prompt when a background task finishes. Not isMeta — its `origin` says who.
const taskNotification = (): string =>
  JSON.stringify({
    timestamp: stamp(),
    type: "user",
    origin: { kind: "task-notification", producer: "session-task" },
    promptSource: "system",
    message: {
      role: "user",
      content: "<task-notification>done</task-notification>",
    },
  });

// A slash command Claude answers (a skill), as Claude Code writes it — leading
// with `<command-message>`. A built-in command leads with `<command-name>`.
const skill = (name: string): string =>
  userText(
    `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`,
  );

const toolUse = (
  ...calls: Array<{ id: string; name: string; input?: unknown }>
): string =>
  JSON.stringify({
    timestamp: stamp(),
    type: "assistant",
    message: {
      role: "assistant",
      content: calls.map((c) => ({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: c.input ?? {},
      })),
    },
  });

const toolResult = (...ids: string[]): string =>
  JSON.stringify({
    timestamp: stamp(),
    type: "user",
    message: {
      role: "user",
      content: ids.map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: "ok",
      })),
    },
  });

const todoWrite = (
  id: string,
  todos: Array<{ content: string; status: string; activeForm?: string }>,
): string => toolUse({ id, name: "TodoWrite", input: { todos } });

const EFFECTIVE_GLOBALS: EffectiveGlobals = globalsFor(DEFAULT_DSL_CONFIG);

let dir: string;
let seq = 0;

// A fresh path per transcript: the provider keys its fold by session id, and a
// reused path would let one test's mtime fast-path answer another's read.
function transcript(...lines: string[]): { path: string; session: string } {
  const session = `s${seq++}`;
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return { path, session };
}

function hook(path: string, session: string): ClaudeHookData {
  return {
    hook_event_name: "Status",
    session_id: session,
    transcript_path: path,
    cwd: "/test/cwd",
    model: { id: "claude-opus-4-1", display_name: "Opus" },
    workspace: {
      current_dir: "/test/workspace",
      project_dir: "/test/project",
      added_dirs: [],
    },
    version: "1.0.0",
  };
}

async function activityOf(...lines: string[]) {
  const { path, session } = transcript(...lines);
  const outcome = await new ActivityProvider().getActivityInfo(
    session,
    hook(path, session),
  );
  if (outcome.kind !== "ok")
    throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "activity-"));
  clock = 0;
});

// ─── the per-entry projection ────────────────────────────────────────────────

// The projection as the parse site runs it: classified first, then projected.
const project = (
  parsed: Record<string, unknown>,
): ReturnType<typeof entryActivity> =>
  entryActivity(parsed, userEntryOf(parsed));

describe("the entry projection carries the scalars and never the content array", () => {
  test("a tool call keeps its id and name; the input is not retained", () => {
    const parsed = JSON.parse(
      toolUse({ id: "t1", name: "Bash", input: { command: "x".repeat(5000) } }),
    );
    expect(project(parsed)).toEqual({
      started: [{ id: "t1", name: "Bash" }],
    });
  });

  test("a TodoWrite is BOTH a started tool and a todo list", () => {
    const parsed = JSON.parse(
      todoWrite("t1", [
        {
          content: "Write the gate",
          status: "in_progress",
          activeForm: "Writing the gate",
        },
      ]),
    );
    expect(project(parsed)).toEqual({
      started: [{ id: "t1", name: "TodoWrite" }],
      todos: [{ text: "Writing the gate", active: true, done: false }],
    });
  });

  test("an in-progress item reads in the active grammar, others in the plain one", () => {
    const parsed = JSON.parse(
      todoWrite("t1", [
        {
          content: "Write the gate",
          status: "completed",
          activeForm: "Writing the gate",
        },
        {
          content: "Mutate it",
          status: "in_progress",
          activeForm: "Mutating it",
        },
      ]),
    );
    expect(project(parsed)?.todos).toEqual([
      { text: "Write the gate", active: false, done: true },
      { text: "Mutating it", active: true, done: false },
    ]);
  });

  // [LAW:types-are-the-program] The projection claims only the two predicates it
  // reads, so a status Claude Code has not shipped yet stays representable.
  test("an unrecognised status is neither active nor done", () => {
    const parsed = JSON.parse(
      todoWrite("t1", [{ content: "Later", status: "deferred" }]),
    );
    expect(project(parsed)?.todos).toEqual([
      { text: "Later", active: false, done: false },
    ]);
  });

  test("a user turn's slash command is projected, from either content shape", () => {
    expect(
      project(
        JSON.parse(
          userText(
            "<command-message>next</command-message>\n<command-name>/next</command-name>\n<command-args></command-args>",
          ),
        ),
      ),
    ).toEqual({ command: "/next" });
    expect(
      project(
        JSON.parse(
          JSON.stringify({
            timestamp: stamp(),
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "<command-message>loop</command-message>\n<command-name>/loop</command-name>",
                },
              ],
            },
          }),
        ),
      ),
    ).toEqual({ command: "/loop" });
  });

  // The ONE user check, pinned on both shapes an assistant could use. A mutation
  // proved why both: with only the block shape tested, dropping the check on the
  // string shape broke nothing, and the guard read as belt-and-braces rather than
  // as the thing standing between an assistant's prose and the bar claiming a
  // command ran. Claude Code writes no assistant string content today — which is
  // exactly the premise a test has to hold, since it is not ours to keep.
  test.each(["string", "block"] as const)(
    "an assistant echoing the tag in %s content is not a command",
    (shape) => {
      const text = "you ran <command-name>/next</command-name>";
      const echoed = JSON.parse(
        JSON.stringify({
          timestamp: stamp(),
          type: "assistant",
          message: {
            role: "assistant",
            content: shape === "string" ? text : [{ type: "text", text }],
          },
        }),
      );
      expect(project(echoed)).toBeUndefined();
    },
  );

  test("a command tag in an entry Claude Code wrote itself is not a command", () => {
    expect(
      project(JSON.parse(metaUser("<command-name>/next</command-name>"))),
    ).toBeUndefined();
  });

  test("an entry with nothing to say projects nothing at all", () => {
    expect(project(JSON.parse(userText("just a question")))).toBeUndefined();
  });
});

// ─── the fold ────────────────────────────────────────────────────────────────

describe("the fold reports what is happening now", () => {
  test("a started tool is running; its result moves it to done", async () => {
    expect(
      await activityOf(userText("go"), toolUse({ id: "t1", name: "Bash" })),
    ).toMatchObject({
      running: [{ name: "Bash", count: 1 }],
      done: [],
    });
    expect(
      await activityOf(
        userText("go"),
        toolUse({ id: "t1", name: "Bash" }),
        toolResult("t1"),
      ),
    ).toMatchObject({ running: [], done: [{ name: "Bash", count: 1 }] });
  });

  test("parallel calls of one tool tally by name, not by repetition", async () => {
    const info = await activityOf(
      userText("go"),
      toolUse(
        { id: "a", name: "Bash" },
        { id: "b", name: "Bash" },
        { id: "c", name: "Read" },
      ),
      toolResult("a"),
    );
    expect(info.running).toEqual([
      { name: "Bash", count: 1 },
      { name: "Read", count: 1 },
    ]);
    expect(info.done).toEqual([{ name: "Bash", count: 1 }]);
  });

  test("a tool_result is not a turn boundary, so tool activity accumulates", async () => {
    const info = await activityOf(
      userText("go"),
      toolUse({ id: "a", name: "Read" }),
      toolResult("a"),
      toolUse({ id: "b", name: "Read" }),
      toolResult("b"),
      toolUse({ id: "c", name: "Bash" }),
      toolResult("c"),
    );
    expect(info.done).toEqual([
      { name: "Read", count: 2 },
      { name: "Bash", count: 1 },
    ]);
  });

  test("a meta user entry is not a turn boundary, so the tally and the command survive it", async () => {
    const info = await activityOf(
      skill("next"),
      metaUser("Base directory for this skill: …"),
      toolUse({ id: "a", name: "Bash" }),
      toolResult("a"),
      metaUser(
        "Your previous response had no visible output. Please continue and produce a user-visible response.",
      ),
    );
    expect(info.command).toBe("/next");
    expect(info.done).toEqual([{ name: "Bash", count: 1 }]);
  });

  test("a task notification is another turn of the same prompt, so the tally and the command survive it", async () => {
    const info = await activityOf(
      skill("next"),
      toolUse({ id: "a", name: "Agent" }),
      toolResult("a"),
      taskNotification(),
      toolUse({ id: "b", name: "Bash" }),
    );
    expect(info.command).toBe("/next");
    expect(info.done).toEqual([{ name: "Agent", count: 1 }]);
    expect(info.running).toEqual([{ name: "Bash", count: 1 }]);
  });

  test("a built-in command, a shell command and their output are not prompts, so the turn before them stands", async () => {
    const info = await activityOf(
      skill("next"),
      toolUse({ id: "a", name: "Bash" }),
      toolResult("a"),
      userText("<command-name>/model</command-name>"),
      userText(
        "<local-command-stdout>Set model to Opus</local-command-stdout>",
      ),
      userText("<bash-input>ls</bash-input>"),
      userText("<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>"),
    );
    expect(info.command).toBe("/next");
    expect(info.done).toEqual([{ name: "Bash", count: 1 }]);
  });

  test("an interrupt ends the turn without starting one: its tally and command stay, nothing is left running", async () => {
    const info = await activityOf(
      skill("next"),
      toolUse({ id: "a", name: "Bash" }),
      toolResult("a"),
      toolUse({ id: "b", name: "Read" }),
      userText("[Request interrupted by user]"),
    );
    expect(info.command).toBe("/next");
    expect(info.done).toEqual([{ name: "Bash", count: 1 }]);
    expect(info.running).toEqual([]);
  });

  test("a real user message resets the tool activity but keeps the todo list", async () => {
    const info = await activityOf(
      userText("first"),
      todoWrite("t0", [
        {
          content: "Ship it",
          status: "in_progress",
          activeForm: "Shipping it",
        },
      ]),
      toolResult("t0"),
      toolUse({ id: "a", name: "Bash" }),
      toolResult("a"),
      userText("second"),
    );
    expect(info).toEqual({
      command: null,
      todos: [{ text: "Shipping it", active: true, done: false }],
      running: [],
      done: [],
    });
  });

  test("the slash command that opened the turn is reported, and plain text clears it", async () => {
    expect((await activityOf(skill("next"))).command).toBe("/next");
    expect(
      (await activityOf(skill("next"), userText("now do this"))).command,
    ).toBeNull();
  });

  test("a later TodoWrite replaces the list rather than adding to it", async () => {
    const info = await activityOf(
      userText("go"),
      todoWrite("t0", [
        { content: "One", status: "pending" },
        { content: "Two", status: "pending" },
      ]),
      todoWrite("t1", [{ content: "Only", status: "completed" }]),
    );
    expect(info.todos).toEqual([{ text: "Only", active: false, done: true }]);
  });

  test("a subagent's tool calls are not the main session's activity", async () => {
    const side = JSON.stringify({
      timestamp: stamp(),
      type: "assistant",
      isSidechain: true,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "sx", name: "Grep", input: {} }],
      },
    });
    expect((await activityOf(userText("go"), side)).running).toEqual([]);
  });

  test("folding the appended bytes gives the same answer as folding the whole file", async () => {
    const { path, session } = transcript(
      userText("go"),
      toolUse({ id: "a", name: "Bash" }),
    );
    const provider = new ActivityProvider();
    const first = await provider.getActivityInfo(session, hook(path, session));
    expect(first.kind === "ok" && first.value.running).toEqual([
      { name: "Bash", count: 1 },
    ]);

    appendFileSync(
      path,
      toolResult("a") + "\n" + toolUse({ id: "b", name: "Read" }) + "\n",
    );
    // Force a distinct mtime so the fast path does not answer with the prior fold.
    const future = new Date(Date.now() + 2000);
    utimesSync(path, future, future);

    const second = await provider.getActivityInfo(session, hook(path, session));
    expect(second.kind === "ok" && second.value).toMatchObject({
      running: [{ name: "Read", count: 1 }],
      done: [{ name: "Bash", count: 1 }],
    });

    const whole = await new ActivityProvider().getActivityInfo(
      session,
      hook(path, session),
    );
    expect(whole.kind === "ok" && whole.value).toEqual(
      second.kind === "ok" && second.value,
    );
  });

  test("a session with no transcript yet is an empty record, not a failure", async () => {
    const session = "missing";
    const outcome = await new ActivityProvider().getActivityInfo(
      session,
      hook(join(dir, "nope.jsonl"), session),
    );
    expect(outcome).toEqual({
      kind: "ok",
      value: { command: null, todos: [], running: [], done: [] },
    });
  });
});

// ─── the payload projection ──────────────────────────────────────────────────
//
// [LAW:types-are-the-program] The seam: tool ids never cross it (they exist only
// to pair a result to its call), a tally crosses as one `"<name>:<count>"`
// string, and a family with nothing real to say is DROPPED rather than emitting
// zeros an author would have to distinguish from real ones.

describe("the payload projection", () => {
  const payloadFor = async (info: ActivityInfo) => {
    const deps = {
      ...absentOwners(),
      gitProvider: fakeGit(async () => ABSENT),
      usageStore: fakeUsage({
        usage: async () => ABSENT,
        today: () => ABSENT,
        speed: async () => ABSENT,
      }),
      contextProvider: fakeContext(async () => ABSENT),
      metricsProvider: fakeMetrics(async () => ABSENT),
      activityProvider: fakeActivity(async () => ok(info)),
      tmuxService: fakeTmux(async () => ABSENT),
      log: () => {},
      history: () => EMPTY_HISTORY_DEPTH,
      navigation: () => 0,
      feeds: () => UNFOLLOWED_FEEDS,
    } as unknown as RenderPayloadDeps;
    const built = await requestPayload(
      hook(join(dir, "t.jsonl"), "p"),
      instantOf(new Date()),
      deps,
      undefined,
      new Set(["activity"]),
      EFFECTIVE_GLOBALS,
      {},
      NO_CONFIG_FILE,
    );
    return built.activity;
  };

  const INFO = (over: Partial<ActivityInfo> = {}): ActivityInfo => ({
    command: null,
    todos: [],
    running: [],
    done: [],
    ...over,
  });

  test("an empty record carries no activity family at all", async () => {
    expect(await payloadFor(INFO())).toBeUndefined();
  });

  test("a tally crosses as one name:count string, and no tool id crosses", async () => {
    expect(
      await payloadFor(
        INFO({
          running: [
            { name: "Bash", count: 3 },
            { name: "Read", count: 1 },
          ],
          done: [{ name: "Grep", count: 2 }],
        }),
      ),
    ).toEqual({ tool: { running: "Bash:3,Read:1", done: "Grep:2" } });
  });

  test("the in-progress item's 1-based position and text ride beside the totals", async () => {
    expect(
      await payloadFor(
        INFO({
          todos: [
            { text: "One", active: false, done: true },
            { text: "Two", active: false, done: true },
            { text: "Doing three", active: true, done: false },
            { text: "Four", active: false, done: false },
          ],
        }),
      ),
    ).toEqual({
      todo: { total: 4, completed: 2, position: 3, active: "Doing three" },
    });
  });

  test("a list with no item in progress carries neither position nor text", async () => {
    expect(
      await payloadFor(
        INFO({ todos: [{ text: "One", active: false, done: true }] }),
      ),
    ).toEqual({ todo: { total: 1, completed: 1 } });
  });

  test("a slash command crosses verbatim", async () => {
    expect(await payloadFor(INFO({ command: "/next" }))).toEqual({
      command: "/next",
    });
  });
});

// ─── the bundled segment reads it ─────────────────────────────────────────────
//
// Through the REAL path: the bundled config, narrowed to this one segment, its
// helper block compiled by registerDslConfig and the payload bound as its
// view's source (bindView) — so the `when` gate, the shared `formatToolTally` helper,
// and the var-system defaults for an absent family are all the production ones.

describe("the bundled activity segment renders the payload", () => {
  const render = (activity?: Record<string, unknown>): Frame => {
    const narrowed = narrowToSegment(
      parseAndValidate("<default>", JSON.stringify(RAW_DEFAULT_DSL_CONFIG)),
      "activity",
    );
    const store = new VariableStore();
    const registry = new SourceRegistry(
      processLauncher,
      store,
      "",
      new SessionState(),
    );
    try {
      const compiled = registerDslConfig(narrowed, registry, {
        signer: TEST_SIGNER,
        cwd: process.cwd(),
      });
      return drawPayload(
        narrowed,
        compiled,
        store,
        registry,
        {
          hook_event_name: "Status",
          session_id: "x",
          cwd: "/tmp",
          model: { id: "x", display_name: "x" },
          workspace: {
            current_dir: "/tmp",
            project_dir: "/tmp",
            added_dirs: [],
          },
          ...(activity !== undefined && { activity }),
        },
        instantOf(new Date()),
        {
          // Plain, because what is under test is the cell's TEXT: the
          // powerline joiner's end-cap glyphs are not whitespace, so they
          // would ride into every expectation as chrome this gate never
          // meant to pin (test/decor-wiring.test.ts owns the chrome).
          endcaps: "plain" as const,
          colorCompatibility: "truecolor" as const,
          wrap: true,
          padding: 1,
          width: Number.POSITIVE_INFINITY,
        },
      ).frame;
    } finally {
      registry.dispose();
    }
  };

  // No `.trim()`: a hidden segment renders NOTHING, while a segment whose `when`
  // let it through with an empty body renders its padding — and a trim would have
  // read those two as the same answer. (It did, until the bundled-config
  // equivalence pin caught the `when` that was visible on an idle session.)
  test("an idle session renders no cell at all", () => {
    expect(textOf(render())).toBe("");
  });

  test("the in-progress todo reads as its position over the total", () => {
    expect(
      textOf(render({
        todo: {
          total: 7,
          completed: 2,
          position: 3,
          active: "Writing the gate",
        },
      })).trim(),
    ).toBe("☐ 3/7 Writing the gate");
  });

  // `completed`, not `position`, is what tells a finished list from an
  // all-pending one: both have no item in progress, and both readings are true.
  test("a list with nothing in progress reads as completed over total", () => {
    expect(textOf(render({ todo: { total: 7, completed: 7 } })).trim()).toBe("☑ 7/7");
    expect(textOf(render({ todo: { total: 7, completed: 0 } })).trim()).toBe("☑ 0/7");
  });

  test("a long task is abbreviated rather than widening the bar without bound", () => {
    const out = textOf(render({
      todo: {
        total: 1,
        completed: 0,
        position: 1,
        active: "Writing the open-source voice replacement spec",
      },
    })).trim();
    // sprig's `abbrev` ellipsis is three dots, not U+2026.
    expect(out).toContain("...");
    expect(out.length).toBeLessThan(45);
  });

  test("a tool tally reads by name, a count of one carrying no multiplier", () => {
    expect(textOf(render({ tool: { running: "Bash:3,Read:1" } })).trim()).toBe(
      "⟳ Bash×3 Read",
    );
  });

  test("a tally past two names is capped with an overflow count", () => {
    expect(textOf(render({ tool: { running: "A:1,B:1,C:1,D:2" } })).trim()).toBe(
      "⟳ A B +2",
    );
  });

  test("running and completed tools read through the same helper", () => {
    expect(textOf(render({ tool: { running: "Bash:1", done: "Read:4" } })).trim()).toBe(
      "⟳ Bash ✓ Read×4",
    );
  });

  test("the slash command leads the cell", () => {
    expect(textOf(render({ command: "/next" })).trim()).toBe("⌘ /next");
  });

  test("every part composes in one cell", () => {
    expect(
      textOf(render({
        command: "/next",
        todo: { total: 4, completed: 1, position: 2, active: "Mutating it" },
        tool: { running: "Bash:2", done: "Read:3" },
      })).trim(),
    ).toBe("⌘ /next ☐ 2/4 Mutating it ⟳ Bash×2 ✓ Read×3");
  });
});
