// [LAW:behavior-not-structure] The gate for brandon-lit-widget-3xo.btb: which lit
// ticket the bar says this session is working, where its workflow is, and its
// epic's progress — for a given transcript. Real JSONL in, the provider's record
// or the rendered cell out.

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ActivityProvider } from "../src/segments/activity";
import { clearParseCache } from "../src/utils/claude";
import { RAW_DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { narrowToSegment } from "./helpers/narrow-to-segment";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { stripAnsi } from "./helpers/ansi";

let clock = 0;
let seq = 0;
let dir: string;

const stamp = (): string =>
  new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

let lastCall = "";

const call = (name: string, input: Record<string, unknown>): string => {
  lastCall = `c${clock}`;
  return JSON.stringify({
    timestamp: stamp(),
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: lastCall, name, input }],
    },
  });
};

const bash = (command: string): string => call("Bash", { command });
const skill = (name: string): string => call("Skill", { skill: name });

// The result of the newest call, so a `lit start` settles the way lit answers.
const result = (content: unknown, isError = false): string =>
  JSON.stringify({
    timestamp: stamp(),
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: lastCall, content, is_error: isError },
      ],
    },
  });

// A `lit start` lit accepted: the call and lit's own acceptance line.
const start = (command: string): string => {
  const line = bash(command);
  const id = /lit\s+start\s+(?:--?\S+\s+)*(\S+)/.exec(command)?.[1];
  return [line, result(`${id} [in_progress/feature/x/normal] T\nmore`)].join("\n");
};

const sentinel = (state: unknown): string => `lit:state ${JSON.stringify(state)}`;

async function ticketOf(...lines: string[]) {
  const session = `s${seq++}`;
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  const outcome = await new ActivityProvider().getActivityInfo(session, {
    hook_event_name: "Status",
    session_id: session,
    transcript_path: path,
    cwd: "/t",
    model: { id: "m", display_name: "m" },
    workspace: { current_dir: "/t", project_dir: "/t", added_dirs: [] },
    version: "1.0.0",
  });
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome.value.ticket;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lit-ticket-"));
  clock = 0;
  clearParseCache();
});

describe("the ticket a session is working", () => {
  test("no `lit start` in the session is no ticket", async () => {
    expect(await ticketOf(bash("lit ls"), bash("git status"))).toBeNull();
  });

  test("`lit start <id>` names the ticket, in prep, with no epic yet", async () => {
    expect(
      await ticketOf(start("cd /r && lit start proj-ab1.c2 2>&1 | tail -3")),
    ).toEqual({ id: "proj-ab1.c2", phase: "prep", epic: null, unread: null });
  });

  test("a later `lit start` replaces the ticket", async () => {
    const t = await ticketOf(start("lit start a-1"), start("lit start b-2"));
    expect(t?.id).toBe("b-2");
  });

  test("a word merely containing lit is not lit", async () => {
    expect(await ticketOf(bash("split start x-1"))).toBeNull();
  });

  test("the phase follows the work: impl, review, groom, handoff", async () => {
    const steps = [
      start("lit start t-1"),
      call("Edit", { file_path: "/f" }),
    ];
    expect((await ticketOf(...steps))?.phase).toBe("impl");
    steps.push(bash("git push && gh pr create --fill"));
    expect((await ticketOf(...steps))?.phase).toBe("review");
    steps.push(skill("code-review"));
    expect((await ticketOf(...steps))?.phase).toBe("review");
    steps.push(bash("lit done t-1"));
    expect((await ticketOf(...steps))?.phase).toBe("groom");
    steps.push(skill("memento:message-in-a-bottle"));
    expect((await ticketOf(...steps))?.phase).toBe("handoff");
  });

  test("lit's sentinel for the ticket in hand carries its epic", async () => {
    expect(
      await ticketOf(
        start("lit start t-1"),
        result(
          `t-1 [in_progress]\n${sentinel({ id: "t-1", status: "in_progress", epic: { id: "e", done: 4, total: 10 } })}\nmore`,
        ),
      ),
    ).toEqual({ id: "t-1", phase: "prep", epic: { id: "e", done: 4, total: 10 }, unread: null });
  });

  test("a sentinel in a text-block result reads the same", async () => {
    const t = await ticketOf(
      start("lit start t-1"),
      result([
        { type: "text", text: sentinel({ id: "t-1", status: "in_progress", epic: { id: "e", done: 1, total: 2 } }) },
      ]),
    );
    expect(t?.epic).toEqual({ id: "e", done: 1, total: 2 });
  });

  test("a sentinel about another ticket does not move this one", async () => {
    const t = await ticketOf(
      start("lit start t-1"),
      result(sentinel({ id: "other", status: "in_progress", epic: { id: "e", done: 9, total: 9 } })),
    );
    expect(t?.epic).toBeNull();
  });

  test("a line claiming the prefix that does not parse is carried as unreadable", async () => {
    const t = await ticketOf(start("lit start t-1"), result("lit:state {nope}"));
    expect(t?.epic).toBeNull();
    expect(t?.unread).toBe("lit:state {nope}");
  });

  test("a start lit refused claims nothing, whatever the exit status", async () => {
    expect(
      await ticketOf(bash("lit start bogus"), result("no such ticket", true)),
    ).toBeNull();
    // `| tail -3` masks lit's exit: the result is not an error, lit still refused.
    const t = await ticketOf(
      start("lit start t-1"),
      bash("lit start taken-2 2>&1 | tail -3"),
      result("error (code=1): claimed here: /elsewhere · a minute ago"),
    );
    expect(t?.id).toBe("t-1");
  });

  test("an accepted start holds though a later command in the call failed", async () => {
    const t = await ticketOf(
      bash("lit start t-2 && git checkout -b t-2"),
      result("Exit code 128\nt-2 [in_progress/bug/x/normal] T\nfatal: exists", true),
    );
    expect(t?.id).toBe("t-2");
  });

  test("a start whose result has not come back is not yet the ticket", async () => {
    const t = await ticketOf(start("lit start t-1"), bash("lit start t-2"));
    expect(t?.id).toBe("t-1");
  });

  test("the sentinel lit prints on start settles the epic at once", async () => {
    const t = await ticketOf(
      bash("lit start t-1"),
      result(sentinel({ id: "t-1", status: "in_progress", epic: { id: "e", done: 2, total: 5 } })),
    );
    expect(t).toEqual({ id: "t-1", phase: "prep", epic: { id: "e", done: 2, total: 5 }, unread: null });
  });

  test("starting the ticket in hand again keeps its epic", async () => {
    const t = await ticketOf(
      bash("lit start t-1"),
      result(sentinel({ id: "t-1", status: "in_progress", epic: { id: "e", done: 3, total: 7 } })),
      start("lit start t-1"),
    );
    expect(t?.epic).toEqual({ id: "e", done: 3, total: 7 });
  });

  test("lit named inside quoted text or a heredoc runs nothing", async () => {
    const t = await ticketOf(
      start("lit start t-1"),
      call("Edit", { file_path: "/f" }),
      start('git commit -m "show it after a lit start in this session"'),
      start("gh pr view --body 'then lit done x'"),
      start("cat <<'EOF' > n.md\nlit start nope\nEOF"),
    );
    expect(t).toEqual({ id: "t-1", phase: "impl", epic: null, unread: null });
  });

  test("`lit done` / `lit close` of the ticket in hand clears it, once lit says so", async () => {
    expect(
      await ticketOf(
        start("lit start t-1"),
        bash("lit done t-1 2>&1 | tail -5"),
        result("Ticket t-1 has been closed. Before moving on, review related tickets."),
      ),
    ).toBeNull();
    expect(
      await ticketOf(
        start("lit start t-1"),
        bash("lit close --reason 'dup' t-1"),
        result("t-1 [closed/bug/x/normal] T"),
      ),
    ).toBeNull();
    // Refused, or a different ticket closed: the ticket in hand stays.
    const t = await ticketOf(
      start("lit start t-1"),
      bash("lit done t-1"),
      result("error (code=1): not in progress", true),
      bash("lit done other-2"),
      result("Ticket other-2 has been closed."),
    );
    expect(t?.id).toBe("t-1");
  });

  test("flags may sit between `lit start` and the id", async () => {
    const t = await ticketOf(start("lit start --take t-9"));
    expect(t?.id).toBe("t-9");
  });

  test("a sentinel about the id in another status does not settle a start", async () => {
    const t = await ticketOf(
      bash("lit start x-1 || lit show x-1"),
      result(sentinel({ id: "x-1", status: "open", epic: null })),
    );
    expect(t).toBeNull();
  });

  test("a namespaced review skill and MultiEdit name their phases", async () => {
    const t = (...s: string[]) => ticketOf(start("lit start t-1"), ...s);
    expect((await t(call("MultiEdit", { file_path: "/f" })))?.phase).toBe("impl");
    expect((await t(skill("plugin:code-review")))?.phase).toBe("review");
    expect((await t(skill("x-groom-backlog")))?.phase).toBe("prep");
  });

  test("a phase before any `lit start` lands on nothing", async () => {
    expect(await ticketOf(call("Edit", { file_path: "/f" }))).toBeNull();
  });
});

describe("the bundled ticket segment", () => {
  const render = (
    ticket: Record<string, unknown> | undefined,
    detail: "collapsed" | "expanded" = "collapsed",
  ): string => {
    const narrowed = narrowToSegment(
      parseAndValidate("<default>", JSON.stringify(RAW_DEFAULT_DSL_CONFIG)),
      "ticket",
    );
    const store = new VariableStore();
    const state = new SessionState();
    state.set("x", "ticket-detail", detail);
    const registry = new SourceRegistry(store, "", undefined, state);
    try {
      const compiled = registerDslConfig(narrowed, registry, { cwd: "/tmp" });
      return stripAnsi(
        renderDsl(
          narrowed,
          compiled,
          store,
          registry,
          {
            hook_event_name: "Status",
            session_id: "x",
            cwd: "/tmp",
            model: { id: "x", display_name: "x" },
            workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
            ...(ticket !== undefined && { activity: { ticket } }),
          },
          {
            endcaps: "plain" as const,
            colorCompatibility: "truecolor" as const,
            wrap: true,
            padding: 1,
            charset: "unicode" as const,
            width: Number.POSITIVE_INFINITY,
          },
        ),
      );
    } finally {
      registry.dispose();
    }
  };

  const T = { id: "t-1", phase: "impl", epic: { id: "e", done: 4, total: 10 }, unread: null };

  test("no ticket renders no cell", () => {
    expect(render(undefined)).toBe("");
  });

  test("collapsed, it is the id and the expand arrow", () => {
    expect(render(T)).toContain("🎫 t-1 ▸");
    expect(render(T)).not.toContain("impl");
  });

  test("expanded, it adds the phase and the epic's progress", () => {
    expect(render(T, "expanded")).toContain("🎫 t-1 · impl · epic 4/10 ◂");
  });

  test("expanded with no epic reported, it shows no count", () => {
    expect(render({ id: "t-1", phase: "prep" }, "expanded")).toContain(
      "🎫 t-1 · prep ◂",
    );
  });
});
