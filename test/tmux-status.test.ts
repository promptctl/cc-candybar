// The tmux status line lane's one writer (src/daemon/tmux-status.ts), over a
// fake tmux server: what it lays out, draws and puts back, and what it leaves
// alone because the user set it since.

import {
  BINDING_OPTION,
  PRIOR_OPTION,
  TmuxStatusLines,
  rowFormat,
  rowOption,
  tmuxArg,
  type TmuxStatusEdge,
} from "../src/daemon/tmux-status";
import type { Subscriber } from "../src/daemon/frame-feed";
import type { StatusLines } from "../src/daemon/pane-visibility";
import type { TmuxRun } from "../src/proc/tmux";
import { rangeOf } from "../src/tmux-status/frames";
import { barOf } from "./helpers/drawn-frame";

const SOCKET = "/tmp/tmux-test/default";
const OWNER = "/tmp/cc-candybar-test/socket";
const ok = (stdout = ""): TmuxRun => ({ kind: "ok", stdout });
const DEFAULT_BINDING = "bind-key -T root MouseDown1Status switch-client -t =";

// The words of a command list as tmux parses a string of them: double-quoted
// words with `\` escapes, `;` between commands.
function parseCommands(text: string): string[][] {
  const commands: string[][] = [[]];
  const re = /"((?:[^"\\]|\\.)*)"|(;)|(\S+)/g;
  for (const [, quoted, semi, bare] of text.matchAll(re)) {
    if (semi !== undefined) commands.push([]);
    else commands.at(-1)!.push(quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : bare!);
  }
  return commands;
}

// A tmux server as far as the owner asks it: session-level and global options,
// each session's `status` falling back to the global one, an array option
// unset whole by its bare name, the root table as `list-keys` prints it,
// `if-shell -F` over an option, and `display-message -p` of plain text. While
// `gate` is set, each invocation waits for it before it runs, as one in flight
// would.
class FakeTmux implements TmuxStatusEdge {
  readonly sessions = new Map<string, Map<string, string>>();
  readonly global = new Map<string, string>([["status", "on"]]);
  binding: string | null = DEFAULT_BINDING;
  gate: Promise<void> | null = null;
  // The spaces `list-keys` pads the key column with: the width of the
  // table's longest key, which any other root binding can change.
  pad = 10;
  // A command tmux refuses, while set.
  refuses: string | null = null;

  constructor(ids: readonly string[]) {
    for (const id of ids) this.sessions.set(id, new Map());
  }

  async run(socket: string, args: readonly string[], stdin?: string): Promise<TmuxRun> {
    if (this.gate !== null) await this.gate;
    return this.runSync(socket, args, stdin);
  }

  runSync(_socket: string, args: readonly string[], stdin?: string): TmuxRun {
    const commands: string[][] = [[]];
    for (const arg of args)
      if (arg === ";") commands.push([]);
      else commands.at(-1)!.push(arg.endsWith("\\;") ? `${arg.slice(0, -2)};` : arg);
    return this.list(commands, stdin);
  }

  private list(commands: readonly string[][], stdin?: string): TmuxRun {
    let out = "";
    for (const command of commands) {
      const run = this.one(command, stdin);
      if (run.kind !== "ok") return run;
      out += run.stdout;
    }
    return ok(out);
  }

  private one(command: readonly string[], stdin?: string): TmuxRun {
    const [name, ...rest] = command;
    if (name === this.refuses) return { kind: "failed", reason: `fake tmux refused ${name}` };
    const flags = new Set(rest.filter((a) => /^-[a-zA-Z]+$/.test(a)).flatMap((a) => [...a.slice(1)]));
    const target = rest[rest.indexOf("-t") + 1];
    const words = rest.filter(
      (a, i) => !/^-[a-zA-Z]+$/.test(a) && !["-t", "-T"].includes(rest[i - 1] ?? ""),
    );
    const scope = flags.has("g") ? this.global : this.sessions.get(target ?? "");
    switch (name) {
      case "set-option": {
        if (scope === undefined) return { kind: "failed", reason: `no session ${target}` };
        const [option, value] = words as [string, string?];
        if (flags.has("u")) {
          scope.delete(option);
          for (const key of [...scope.keys()])
            if (key.startsWith(`${option}[`)) scope.delete(key);
        } else scope.set(option, value ?? "");
        return ok();
      }
      case "show-options": {
        if (scope === undefined) return { kind: "failed", reason: `no session ${target}` };
        const [option] = words;
        if (option === undefined)
          return ok([...scope].map(([k, v]) => `${k} ${JSON.stringify(v)}\n`).join(""));
        const value = scope.get(option);
        return ok(value === undefined ? "" : `${value}\n`);
      }
      case "display-message": {
        const [text] = words;
        if (text !== "#{status}") return ok(`${text}\n`);
        const session = this.sessions.get(target ?? "")!;
        return ok(`${session.get("status") ?? this.global.get("status")}\n`);
      }
      case "if-shell": {
        const [condition, then] = words as [string, string];
        const option = /^#\{(@[\w-]+)\}$/.exec(condition)![1]!;
        return this.sessions.get(target ?? "")?.has(option)
          ? this.list(parseCommands(then))
          : ok();
      }
      case "list-sessions":
        return ok(
          [...this.sessions]
            .map(
              ([id, options]) =>
                `${id}\t${options.get(PRIOR_OPTION) ?? ""}\t${options.get("@cc-candybar-status-wrote") ?? ""}\n`,
            )
            .join(""),
        );
      case "list-keys":
        return ok(
          [
            "bind-key -T root MouseDown1Pane select-pane -t =",
            // A table's listing pads the key column, as tmux's does.
            ...(this.binding === null
              ? []
              : [this.binding.replace("MouseDown1Status ", `MouseDown1Status ${" ".repeat(this.pad)}`)]),
          ].join("\n") + "\n",
        );
      case "bind-key":
        this.binding = `bind-key ${rest.join(" ")}`;
        return ok();
      case "unbind-key":
        this.binding = null;
        return ok();
      case "source-file":
        // tmux parses the line it reads, so the listing's padding goes.
        this.binding = stdin!.trim().replace(/ +/g, " ");
        return ok();
      default:
        return { kind: "failed", reason: `fake tmux: ${name}` };
    }
  }
}

const frameOf = (text: string, link?: string) =>
  barOf(
    ...text
      .split("\n")
      .map((line) => [{ text: line, ...(link !== undefined && { link }) }]),
  );

function harness(ids: readonly string[] = ["$1"]) {
  const tmux = new FakeTmux(ids);
  const subs = new Map<string, Subscriber>();
  const unsubscribed: string[] = [];
  const newest = new Map<string, string>();
  const logs: string[] = [];
  const owner = new TmuxStatusLines({
    edge: tmux,
    subscribe: (sessionId, sub) => {
      subs.set(sessionId, sub);
      return () => unsubscribed.push(sessionId);
    },
    sessionInPane: (_socket, pane) => newest.get(pane) ?? null,
    handler: "cc-candybar url-handle",
    owner: OWNER,
    log: (_level, msg) => logs.push(msg),
  });
  const hold = (sessionId: string, pane: string): void => {
    newest.set(pane, sessionId);
    owner.observe(sessionId, { socket: SOCKET, pane, truecolor: null }, true);
  };
  const answer = async (sessionOf: Record<string, string>, shownBy: Record<string, string>) => {
    const view: StatusLines = {
      sessionOf: new Map(Object.entries(sessionOf)),
      shownBy: new Map(Object.entries(shownBy)),
    };
    owner.answered(SOCKET, view);
    await owner.settled();
  };
  const frame = async (sessionId: string, bar: ReturnType<typeof frameOf>) => {
    subs.get(sessionId)!.frame(bar, "");
    await owner.settled();
  };
  return { tmux, owner, subs, unsubscribed, newest, logs, hold, answer, frame };
}

const session = (h: ReturnType<typeof harness>, id = "$1") => h.tmux.sessions.get(id)!;

describe("TmuxStatusLines", () => {
  test("the shown pane's bar is drawn under the status line's own rows, its height following the bar's", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("one\ntwo"));
    const s = session(h);
    expect(s.get("status")).toBe("3");
    expect(s.get("status-format[1]")).toBe(rowFormat(0));
    expect(s.get("status-format[4]")).toBe(rowFormat(3));
    expect(s.get(rowOption(0))).toContain("one");
    expect(s.get(rowOption(1))).toContain("two");
    expect(JSON.parse(s.get(PRIOR_OPTION)!)).toMatchObject({ base: 1, status: null, formats: null });
    expect(h.tmux.binding).toContain("tmux-status-click");
    expect(h.tmux.binding).toContain("switch-client -t =");
  });

  // candybar-plugins-vf6g.qzx: a session outside tmux whose renderer is tmux
  // has no status line to draw in, so it keeps drawing in Claude Code's.
  test("a session switched on with no tmux pane holds no status line", async () => {
    const h = harness();
    h.owner.observe("s1", null, true);
    await h.answer({}, {});
    expect(h.subs.has("s1")).toBe(false);
    expect([...session(h)]).toEqual([]);
  });

  test("a held pane its status line does not show draws nothing, and the status line drops back to its own height", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1", "%2": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("bar"));
    expect(session(h).get("status")).toBe("2");
    await h.answer({ "%1": "$1", "%2": "$1" }, { $1: "%2" });
    expect(session(h).get("status")).toBe("on");
  });

  test("the last pane released puts every value back, the binding included", async () => {
    const h = harness();
    h.tmux.sessions.get("$1")!.set("status-format[2]", "mine");
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("bar"));
    await h.answer({}, {});
    expect([...session(h)]).toEqual([["status-format[2]", "mine"]]);
    expect(h.tmux.binding).toBe(DEFAULT_BINDING);
    expect(h.tmux.global.has(BINDING_OPTION)).toBe(false);
    expect(h.unsubscribed).toEqual(["s1"]);
    expect(h.logs).toContain('tmux-status: released sid="s1" pane=%1 — pane gone');
  });

  test("the rows above the bar are copied into the session's array, and the array is unset whole on release", async () => {
    const h = harness();
    h.tmux.global.set("status-format[0]", "WINDOWS");
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("bar"));
    expect(session(h).get("status-format[0]")).toBe("WINDOWS");
    await h.answer({}, {});
    expect([...session(h)]).toEqual([]);
  });

  test("a value the user set since is kept, and the restore says so", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("bar"));
    session(h).set("status-format[3]", "theirs");
    session(h).set("status", "5");
    h.owner.observe("s1", { socket: SOCKET, pane: "%1", truecolor: null }, false);
    await h.owner.settled();
    expect([...session(h)]).toEqual([
      ["status-format[3]", "theirs"],
      ["status", "5"],
    ]);
    expect(h.logs.find((l) => l.includes("restored session"))).toContain("kept=status-format,status");
  });

  test("a pane another session now renders from is released", async () => {
    const h = harness();
    h.hold("s1", "%1");
    h.newest.set("%1", "s2");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    expect(h.unsubscribed).toEqual(["s1"]);
  });

  test("what a daemon that died left behind is put back on the first answer from its server", async () => {
    const h = harness(["$1", "$2"]);
    const s = session(h, "$2");
    const wrote = { 1: rowFormat(0), 2: rowFormat(1), 3: rowFormat(2), 4: rowFormat(3) };
    s.set(PRIOR_OPTION, JSON.stringify({ owner: OWNER, base: 1, status: null, formats: { 2: "old" }, wrote }));
    s.set("@cc-candybar-status-wrote", "2");
    s.set("status", "2");
    for (const [i, value] of Object.entries(wrote)) s.set(`status-format[${i}]`, value);
    await h.answer({ "%9": "$2" }, {});
    expect([...s]).toEqual([["status-format[2]", "old"]]);
  });

  test("a binding the user replaced is left alone, and said once", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    h.tmux.binding = "bind-key -T root MouseDown1Status select-pane";
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.answer({}, {});
    expect(h.logs.filter((l) => l.includes("bound again since"))).toHaveLength(1);
    expect(h.tmux.binding).toBe("bind-key -T root MouseDown1Status select-pane");
  });

  test("a click resolves through the frame drawn now, and a range it no longer draws is refused", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    const url = "cc-candybar://copy/hi";
    await h.frame("s1", frameOf("x", url));
    const value = `${encodeURIComponent(SOCKET)}/1/${rangeOf(url)}`;
    expect(h.owner.linkAt(value)).toEqual({ kind: "link", url });
    await h.frame("s1", frameOf("y"));
    expect(h.owner.linkAt(value).kind).toBe("refused");
  });

  test("the daemon's shutdown puts back everything it laid out, at once", async () => {
    const h = harness(["$1", "$2"]);
    h.hold("s1", "%1");
    h.hold("s2", "%2");
    await h.answer({ "%1": "$1", "%2": "$2" }, { $1: "%1", $2: "%2" });
    await h.frame("s1", frameOf("a"));
    await h.frame("s2", frameOf("b"));
    h.owner.restoreAll((socket, args, stdin) => h.tmux.runSync(socket, args, stdin));
    expect([...session(h, "$1")]).toEqual([]);
    expect([...session(h, "$2")]).toEqual([]);
    expect(h.tmux.binding).toBe(DEFAULT_BINDING);
    expect(h.owner.stats()).toMatchObject({ sessions: 0, layouts: 0 });
  });

  test("a draw still in flight when the daemon shuts down lands on nothing", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("one"));
    let release = (): void => {};
    h.tmux.gate = new Promise((resolve) => (release = resolve));
    // The draw's write is in tmux's hands when the shutdown restores.
    const drawing = h.frame("s1", frameOf("two\nthree"));
    await new Promise((resolve) => setImmediate(resolve));
    h.owner.restoreAll((socket, args, stdin) => h.tmux.runSync(socket, args, stdin));
    h.tmux.gate = null;
    release();
    await drawing;
    expect([...session(h)]).toEqual([]);
  });

  // Review of PR #405 — each of the tests below pins one of its findings.

  test("a held pane draws its bar only while its status line shows it, so another pane's statusline keeps its own", async () => {
    const h = harness();
    h.hold("s1", "%1");
    h.hold("s2", "%2");
    await h.answer({ "%1": "$1", "%2": "$1" }, { $1: "%1" });
    expect(h.subs.get("s1")!.drawing()).toBe(true);
    expect(h.subs.get("s2")!.drawing()).toBe(false);
    await h.answer({ "%1": "$1", "%2": "$1" }, { $1: "%2" });
    expect(h.subs.get("s1")!.drawing()).toBe(false);
    expect(h.subs.get("s2")!.drawing()).toBe(true);
  });

  test("a session another daemon laid out is left alone, and said once", async () => {
    const h = harness();
    const theirs = JSON.stringify({ owner: "/tmp/elsewhere/socket", base: 1, status: null, formats: null, wrote: { 1: rowFormat(0) } });
    session(h).set(PRIOR_OPTION, theirs);
    session(h).set("status-format[1]", rowFormat(0));
    const before = [...session(h)];
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("bar"));
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    expect([...session(h)]).toEqual(before);
    expect(h.subs.get("s1")!.drawing()).toBe(false);
    expect(h.logs.filter((l) => l.includes("left as it is: the daemon at"))).toHaveLength(1);
    await h.answer({}, {});
    expect([...session(h)]).toEqual(before);
  });

  test("a layout record that does not read leaves its session alone rather than stopping the server's other sessions", async () => {
    const h = harness(["$1", "$2"]);
    session(h, "$1").set(PRIOR_OPTION, "{not json");
    h.hold("s1", "%1");
    h.hold("s2", "%2");
    await h.answer({ "%1": "$1", "%2": "$2" }, { $1: "%1", $2: "%2" });
    await h.frame("s2", frameOf("bar"));
    expect(session(h, "$2").get(rowOption(0))).toContain("bar");
    expect(h.logs.some((l) => l.includes("reconcile threw"))).toBe(false);
  });

  test("the binding stays the daemon's whatever padding the root table's listing puts before it", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    h.tmux.pad = 3;
    await h.answer({}, {});
    expect(h.tmux.binding).toBe(DEFAULT_BINDING);
  });

  test("a binding a daemon on this socket left is bound again as this daemon, over what it first replaced", async () => {
    const h = harness();
    h.tmux.binding = "bind-key -T root MouseDown1Status if-shell -F x run-shell -b old-node url-handle cc-candybar://tmux-status-click/y switch-client -t =";
    h.tmux.global.set(BINDING_OPTION, JSON.stringify({ owner: OWNER, prior: { line: DEFAULT_BINDING, command: "switch-client -t =" } }));
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    expect(h.tmux.binding).toContain("cc-candybar url-handle cc-candybar://tmux-status-click/");
    expect(h.tmux.binding).not.toContain("old-node");
    expect(h.tmux.binding).toContain("switch-client -t =");
    await h.answer({}, {});
    expect(h.tmux.binding).toBe(DEFAULT_BINDING);
  });

  test("another daemon's binding is left alone", async () => {
    const h = harness();
    const theirs = "bind-key -T root MouseDown1Status run-shell -b other url-handle cc-candybar://tmux-status-click/z";
    h.tmux.binding = theirs;
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.answer({}, {});
    expect(h.tmux.binding).toBe(theirs);
    expect(h.logs.some((l) => l.includes("another cc-candybar daemon's status-line clicks"))).toBe(true);
  });

  test("a draw tmux refused is written again", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    h.tmux.refuses = "if-shell";
    await h.frame("s1", frameOf("bar"));
    expect(session(h).has(rowOption(0))).toBe(false);
    h.tmux.refuses = null;
    await h.frame("s1", frameOf("bar"));
    expect(session(h).get(rowOption(0))).toContain("bar");
  });

  test("a layout still being asked for when the daemon shuts down is never written", async () => {
    const h = harness();
    // The server's first answer has been taken over, so the next one goes
    // straight to laying the session out.
    await h.answer({}, {});
    h.hold("s1", "%1");
    let release = (): void => {};
    h.tmux.gate = new Promise((resolve) => (release = resolve));
    h.owner.answered(SOCKET, { sessionOf: new Map([["%1", "$1"]]), shownBy: new Map([["$1", "%1"]]) });
    await new Promise((resolve) => setImmediate(resolve));
    h.owner.restoreAll((socket, args, stdin) => h.tmux.runSync(socket, args, stdin));
    h.tmux.gate = null;
    release();
    await h.owner.settled();
    expect([...session(h)]).toEqual([]);
    expect(h.tmux.binding).toBe(DEFAULT_BINDING);
    expect(h.tmux.global.has(BINDING_OPTION)).toBe(false);
  });

  test("an unchanged frame writes nothing", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("bar"));
    const before = h.owner.stats().writes;
    await h.frame("s1", frameOf("bar"));
    expect(h.owner.stats().writes).toBe(before);
  });
});

describe("tmuxArg", () => {
  test("a value ending in ; keeps it", () => {
    expect(tmuxArg("a;")).toBe("a\\;");
    expect(tmuxArg("a")).toBe("a");
  });
});
