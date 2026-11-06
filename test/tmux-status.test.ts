// The tmux status line lane's one writer (src/daemon/tmux-status.ts), over a
// fake tmux server: what it lays out, draws and puts back, and what it leaves
// alone because the user set it since.

import {
  OLDER_BINDING_RECORD,
  PRIOR_OPTION,
  TmuxStatusLines,
  rowFormat,
  rowOption,
  tmuxArg,
  type TmuxStatusEdge,
} from "../src/daemon/tmux-status";
import {
  boundOf,
  clickBinding,
  CLICK_OPTION,
  NAMED,
  RENDERER_OPTION,
} from "../src/tmux-status/click-binding";
import { linkSigner, type LinkSigner } from "../src/click/link-signer";
import type { Subscriber } from "../src/daemon/frame-feed";
import {
  MAIN_NAME,
  parseRendererAddress,
  type RendererAddress,
} from "../src/daemon/home";
import { laneEncoders, type LaneEncoder } from "../src/daemon/lane-frames";
import type { StatusLines } from "../src/daemon/pane-visibility";
import type { TmuxRun } from "../src/proc/tmux";
import { barOf } from "./helpers/drawn-frame";
import { countedIds } from "./helpers/link-ids";
import { TEST_SIGNER } from "./helpers/link-signer";

const SOCKET = "/tmp/tmux-test/default";
// What the binding's URL carries for a click on `range` of pane `%<pane>`.
const clickOn = (
  pane: string,
  range: string,
  mac = TEST_SIGNER.signBinding(SOCKET),
) => [SOCKET, mac, pane, range].map(encodeURIComponent).join("/");
const OWNER = "/tmp/cc-candybar-test/socket";
const ok = (stdout = ""): TmuxRun => ({ kind: "ok", stdout });
// The server's own MouseDown1Status command, as tmux prints it.
const DEFAULT_COMMAND = "switch-client -t =";
// A second renderer's key, so its macs are not the first one's.
const OTHER_SIGNER = linkSigner(Buffer.alloc(32, 9));

// The words of a command list as tmux parses a string of them: double- or
// single-quoted words with `\` escapes, `;` between commands, and a bare `\;`
// a `;` word left to the command, which a bind-key reads as its own list's
// separator.
function parseCommands(text: string): string[][] {
  const commands: string[][] = [[]];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(;)|(\S+)/g;
  for (const [, quoted, single, semi, bare] of text.matchAll(re)) {
    if (semi !== undefined) commands.push([]);
    else
      commands
        .at(-1)!
        .push(
          quoted !== undefined
            ? quoted.replace(/\\(.)/g, "$1")
            : (single ?? (bare === "\\;" ? ";" : bare!)),
        );
  }
  return commands;
}

// A word as tmux prints it in a listing (its args_escape): bare where it
// can be, else double-quoted with `\`, `"` and `$` escaped, or single-quoted.
function printed(word: string): string {
  if (word === "") return "''";
  const escaped = word
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  if (/[ #';${}%]/.test(word))
    return `"${escaped.replace(/["$]/g, (c) => `\\${c}`)}"`;
  if (/[ "]/.test(word)) return `'${escaped}'`;
  return escaped;
}

// A tmux server as far as the owner asks it: session-level and global options,
// each session's `status` falling back to the global one, an array option
// unset whole by its bare name, the root table as `list-keys` prints it,
// `if-shell -F` over a session's option or over whether any session sets one,
// and `display-message -p` of plain text. While `gate` is set, each invocation
// waits for it before it runs, as one in flight would.
class FakeTmux implements TmuxStatusEdge {
  readonly sessions = new Map<string, Map<string, string>>();
  readonly global = new Map<string, string>([["status", "on"]]);
  // The command MouseDown1Status runs, as `list-keys` prints it.
  binding: string | null = DEFAULT_COMMAND;
  gate: Promise<void> | null = null;
  // Run before each invocation, as another tmux client's command landing
  // first would.
  onRun: ((args: readonly string[]) => void) | null = null;
  // The spaces `list-keys` pads the key column with: the width of the
  // table's longest key, which any other root binding can change.
  pad = 10;
  // A command tmux refuses, while set.
  refuses: string | null = null;

  constructor(ids: readonly string[]) {
    for (const id of ids) this.sessions.set(id, new Map());
  }

  async run(socket: string, args: readonly string[]): Promise<TmuxRun> {
    if (this.gate !== null) await this.gate;
    return this.runSync(socket, args);
  }

  runSync(_socket: string, args: readonly string[]): TmuxRun {
    this.onRun?.(args);
    const commands: string[][] = [[]];
    for (const arg of args)
      if (arg === ";") commands.push([]);
      else
        commands
          .at(-1)!
          .push(arg.endsWith("\\;") ? `${arg.slice(0, -2)};` : arg);
    return this.list(commands);
  }

  private list(commands: readonly string[][]): TmuxRun {
    let out = "";
    for (const command of commands) {
      const run = this.one(command);
      if (run.kind !== "ok") return run;
      out += run.stdout;
    }
    return ok(out);
  }

  private one(command: readonly string[]): TmuxRun {
    const [name, ...rest] = command;
    if (name === this.refuses)
      return { kind: "failed", reason: `fake tmux refused ${name}` };
    const flags = new Set(
      rest
        .filter((a) => /^-[a-zA-Z]+$/.test(a))
        .flatMap((a) => [...a.slice(1)]),
    );
    const target = rest[rest.indexOf("-t") + 1];
    const words = rest.filter(
      (a, i) =>
        !/^-[a-zA-Z]+$/.test(a) && !["-t", "-T"].includes(rest[i - 1] ?? ""),
    );
    const scope = flags.has("g")
      ? this.global
      : this.sessions.get(target ?? "");
    switch (name) {
      case "set-option": {
        if (scope === undefined)
          return { kind: "failed", reason: `no session ${target}` };
        const [option, value] = words as [string, string?];
        if (flags.has("u")) {
          scope.delete(option);
          for (const key of [...scope.keys()])
            if (key.startsWith(`${option}[`)) scope.delete(key);
        } else scope.set(option, value ?? "");
        return ok();
      }
      case "show-options": {
        if (scope === undefined)
          return { kind: "failed", reason: `no session ${target}` };
        const [option] = words;
        if (option === undefined)
          return ok(
            [...scope].map(([k, v]) => `${k} ${JSON.stringify(v)}\n`).join(""),
          );
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
        const [condition, then, otherwise] = words as [string, string, string?];
        const own = /^#\{(@[\w-]+)\}$/.exec(condition);
        const named = [...this.sessions.values()].some(
          (s) => (s.get(RENDERER_OPTION) ?? "") !== "",
        );
        const guards: Record<string, boolean> = {
          [NAMED]: named,
          [`#{!:${NAMED}}`]: !named,
        };
        if (own === null && !(condition in guards))
          throw new Error(`fake tmux: if-shell -F ${condition}`);
        const holds =
          own !== null
            ? (this.sessions.get(target ?? "")?.has(own[1]!) ?? false)
            : guards[condition]!;
        const runs = holds ? then : otherwise;
        return runs === undefined ? ok() : this.list(parseCommands(runs));
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
              : [
                  `bind-key -T root MouseDown1Status ${" ".repeat(this.pad)}${this.binding}`,
                ]),
          ].join("\n") + "\n",
        );
      case "bind-key":
        expect(rest.slice(0, 3)).toEqual(["-T", "root", "MouseDown1Status"]);
        // A bind-key's `;` words separate the commands of its list, which
        // tmux prints back between `\;`.
        this.binding = rest
          .slice(3)
          .map((w) => (w === ";" ? "\\;" : printed(w)))
          .join(" ");
        return ok();
      case "unbind-key":
        this.binding = null;
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

// One renderer over a fake server: its own, or one another harness drew on.
interface Renderer {
  readonly tmux?: FakeTmux;
  readonly name?: RendererAddress;
  readonly owner?: string;
  readonly handler?: string;
  readonly signer?: LinkSigner;
}

function harness(ids: readonly string[] = ["$1"], renderer: Renderer = {}) {
  const tmux = renderer.tmux ?? new FakeTmux(ids);
  const subs = new Map<string, Subscriber<"tmuxStatus">>();
  // Each session's lane encoder, as its feed makes one (src/daemon/frame-feed.ts).
  const encoders = laneEncoders(countedIds());
  const encoding = new Map<string, LaneEncoder<"tmuxStatus">>();
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
    handler: renderer.handler ?? "cc-candybar url-handle",
    owner: renderer.owner ?? OWNER,
    name: renderer.name ?? MAIN_NAME,
    signer: renderer.signer ?? TEST_SIGNER,
    log: (_level, msg) => logs.push(msg),
  });
  const hold = (sessionId: string, pane: string): void => {
    newest.set(pane, sessionId);
    owner.observe(sessionId, { socket: SOCKET, pane, truecolor: null }, true);
  };
  const answer = async (
    sessionOf: Record<string, string>,
    shownBy: Record<string, string>,
  ) => {
    const view: StatusLines = {
      sessionOf: new Map(Object.entries(sessionOf)),
      shownBy: new Map(Object.entries(shownBy)),
    };
    owner.answered(SOCKET, view);
    await owner.settled();
  };
  // The bar as the session's lane encoded it, handed to its subscriber; what
  // it encoded to is the answer, so a case reads the ranges it was drawn with.
  const frame = async (sessionId: string, bar: ReturnType<typeof frameOf>) => {
    let encode = encoding.get(sessionId);
    if (encode === undefined) {
      encode = encoders.tmuxStatus();
      encoding.set(sessionId, encode);
    }
    const out = encode(bar, "");
    subs.get(sessionId)!.frame(out);
    await owner.settled();
    return out.value;
  };
  return { tmux, owner, subs, unsubscribed, newest, logs, hold, answer, frame };
}

const session = (h: ReturnType<typeof harness>, id = "$1") =>
  h.tmux.sessions.get(id)!;

// The server's binding as a renderer reads it from the root table.
const listing = (tmux: FakeTmux) =>
  (tmux.runSync(SOCKET, ["list-keys", "-T", "root"]) as { stdout: string })
    .stdout;
const userOf = (tmux: FakeTmux) => boundOf(listing(tmux)).user;
const oursOn = (tmux: FakeTmux) => boundOf(listing(tmux)).ours;

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
    expect(JSON.parse(s.get(PRIOR_OPTION)!)).toMatchObject({
      base: 1,
      status: null,
      formats: null,
    });
    expect(s.get(RENDERER_OPTION)).toBe("main");
    // The session carries the click its ranges run, addressed to the renderer
    // that draws it; the binding reads it and runs the user's command besides.
    const mac = TEST_SIGNER.signBinding(SOCKET);
    expect(s.get(CLICK_OPTION)).toBe(
      `cc-candybar url-handle cc-candybar://to/main/range/${encodeURIComponent(SOCKET)}/${mac}`,
    );
    expect(h.tmux.binding).toContain(
      `#{${CLICK_OPTION}}/#{s/%//:pane_id}/#{q:mouse_status_range}`,
    );
    expect(userOf(h.tmux)).toEqual([["switch-client", "-t", "="]]);
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
    expect(h.tmux.binding).toBe(DEFAULT_COMMAND);
    expect(h.tmux.global.has(OLDER_BINDING_RECORD)).toBe(false);
    expect(h.unsubscribed).toEqual(["s1"]);
    expect(h.logs).toContain(
      'tmux-status: released sid="s1" pane=%1 — pane gone',
    );
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
    h.owner.observe(
      "s1",
      { socket: SOCKET, pane: "%1", truecolor: null },
      false,
    );
    await h.owner.settled();
    expect([...session(h)]).toEqual([
      ["status-format[3]", "theirs"],
      ["status", "5"],
    ]);
    expect(h.logs.find((l) => l.includes("restored session"))).toContain(
      "kept=status-format,status",
    );
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
    const wrote = {
      1: rowFormat(0),
      2: rowFormat(1),
      3: rowFormat(2),
      4: rowFormat(3),
    };
    s.set(
      PRIOR_OPTION,
      JSON.stringify({
        owner: OWNER,
        base: 1,
        status: null,
        formats: { 2: "old" },
        wrote,
      }),
    );
    s.set("@cc-candybar-status-wrote", "2");
    s.set("status", "2");
    for (const [i, value] of Object.entries(wrote))
      s.set(`status-format[${i}]`, value);
    // Its binding too, though this daemon holds no pane there and never binds.
    h.tmux.binding = clickBinding([["select-pane"]])
      .slice(4)
      .map(printed)
      .join(" ");
    await h.answer({ "%9": "$2" }, {});
    expect([...s]).toEqual([["status-format[2]", "old"]]);
    expect(h.tmux.binding).toBe("select-pane");
  });

  test("a session a dead daemon on this socket laid out names this daemon once taken over, and names none once released", async () => {
    const h = harness();
    const s = session(h);
    const wrote = {
      1: rowFormat(0),
      2: rowFormat(1),
      3: rowFormat(2),
      4: rowFormat(3),
    };
    s.set(
      PRIOR_OPTION,
      JSON.stringify({
        owner: OWNER,
        base: 1,
        status: null,
        formats: null,
        wrote,
      }),
    );
    for (const [i, value] of Object.entries(wrote))
      s.set(`status-format[${i}]`, value);
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    expect(s.get(RENDERER_OPTION)).toBe("main");
    await h.answer({}, {});
    expect([...s]).toEqual([]);
  });

  test("a layout found on the session itself, when the server's listing is refused, names this daemon too", async () => {
    const h = harness();
    const s = session(h);
    s.set(
      PRIOR_OPTION,
      JSON.stringify({
        owner: OWNER,
        base: 1,
        status: null,
        formats: null,
        wrote: { 1: rowFormat(0) },
      }),
    );
    s.set("status-format[1]", rowFormat(0));
    h.tmux.refuses = "list-sessions";
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    expect(s.get(RENDERER_OPTION)).toBe("main");
    expect(
      h.logs.some((l) => l.includes("took over renderer=main session $1")),
    ).toBe(true);
  });

  test("a binding the user replaced is left alone, and said once", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    h.tmux.binding = "select-pane";
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.answer({}, {});
    await h.answer({}, {});
    expect(
      h.logs.filter((l) => l.includes("not a cc-candybar binding")),
    ).toHaveLength(1);
    expect(h.tmux.binding).toBe("select-pane");
  });

  test("a click resolves through the frame drawn now, and a range it no longer draws is refused", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    const url = "cc-candybar://to/main/copy/hi";
    const [range] = Object.keys((await h.frame("s1", frameOf("x", url))).links);
    const value = clickOn("1", range!);
    expect(h.owner.linkAt(value)).toEqual({ kind: "link", url });
    // Redrawn as it animates, the link keeps its range.
    await h.frame("s1", frameOf("x!", url));
    expect(h.owner.linkAt(value)).toEqual({ kind: "link", url });
    await h.frame("s1", frameOf("y"));
    expect(h.owner.linkAt(value).kind).toBe("refused");
  });

  test("a click on a range from a frame since replaced by another link at the same place finds nothing, never the link there now", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    const before = await h.frame(
      "s1",
      frameOf("x", "cc-candybar://to/main/copy/one"),
    );
    const after = await h.frame(
      "s1",
      frameOf("x", "cc-candybar://to/main/copy/two"),
    );
    const [old] = Object.keys(before.links);
    expect(Object.keys(after.links)).not.toContain(old);
    expect(h.owner.linkAt(clickOn("1", old!)).kind).toBe("refused");
  });

  // Any web page can open a `cc-candybar://` URL, and a range id is a counter
  // anyone can guess: the binding's mac is what a click proves it came from.
  test("a click is honoured only with the mac the binding carries, so a guessed range on a drawn link runs nothing", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    const url = "cc-candybar://to/main/copy/hi";
    const [range] = Object.keys((await h.frame("s1", frameOf("x", url))).links);
    const mac = TEST_SIGNER.signBinding(SOCKET);
    expect(session(h).get(CLICK_OPTION)).toMatch(new RegExp(`/${mac}$`));
    expect(h.owner.linkAt(clickOn("1", range!))).toEqual({ kind: "link", url });
    const forged = h.owner.linkAt(clickOn("1", range!, "0".repeat(64)));
    expect(forged).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/mac/),
    });
    // A mac signed for another server is not this one's.
    const elsewhere = TEST_SIGNER.signBinding("/tmp/tmux-test/other");
    expect(h.owner.linkAt(clickOn("1", range!, elsewhere)).kind).toBe(
      "refused",
    );
    // Without its mac the click has a segment too few.
    const bare = [SOCKET, "1", range!].map(encodeURIComponent).join("/");
    expect(h.owner.linkAt(bare).kind).toBe("refused");
  });

  test("a range that names a property every object has finds no link", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("x", "cc-candybar://to/main/copy/hi"));
    for (const range of ["constructor", "toString", "__proto__"])
      expect(h.owner.linkAt(clickOn("1", range)).kind).toBe("refused");
  });

  test("the daemon's shutdown puts back everything it laid out, at once", async () => {
    const h = harness(["$1", "$2"]);
    h.hold("s1", "%1");
    h.hold("s2", "%2");
    await h.answer({ "%1": "$1", "%2": "$2" }, { $1: "%1", $2: "%2" });
    await h.frame("s1", frameOf("a"));
    await h.frame("s2", frameOf("b"));
    h.owner.restoreAll((socket, args) => h.tmux.runSync(socket, args));
    expect([...session(h, "$1")]).toEqual([]);
    expect([...session(h, "$2")]).toEqual([]);
    expect(h.tmux.binding).toBe(DEFAULT_COMMAND);
    expect(h.owner.stats()).toMatchObject({ sessions: 0, layouts: 0 });
  });

  test("a bind still in flight when the daemon shuts down lands on nothing", async () => {
    const h = harness();
    h.hold("s1", "%1");
    let release = (): void => {};
    let gated = false;
    // The bind's write is in tmux's hands, behind its read of the root table.
    h.tmux.onRun = (args) => {
      if (gated || !args.includes("list-keys")) return;
      gated = true;
      h.tmux.gate = new Promise((resolve) => (release = resolve));
    };
    const answering = h.answer({ "%1": "$1" }, { $1: "%1" });
    while (!gated) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    h.owner.restoreAll((socket, args) => h.tmux.runSync(socket, args));
    h.tmux.gate = null;
    release();
    await answering;
    expect(h.tmux.binding).toBe(DEFAULT_COMMAND);
    expect(
      h.logs.some((l) => l.includes("left MouseDown1Status unbound")),
    ).toBe(true);
  });

  test("a binding restore tmux refused says so", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    h.tmux.refuses = "if-shell";
    await h.answer({}, {});
    expect(
      h.logs.some((l) => l.includes("MouseDown1Status not restored")),
    ).toBe(true);
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
    h.owner.restoreAll((socket, args) => h.tmux.runSync(socket, args));
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
    const theirs = JSON.stringify({
      owner: "/tmp/elsewhere/socket",
      base: 1,
      status: null,
      formats: null,
      wrote: { 1: rowFormat(0) },
    });
    session(h).set(PRIOR_OPTION, theirs);
    session(h).set("status-format[1]", rowFormat(0));
    const before = [...session(h)];
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.frame("s1", frameOf("bar"));
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    expect([...session(h)]).toEqual(before);
    expect(h.subs.get("s1")!.drawing()).toBe(false);
    expect(
      h.logs.filter((l) => l.includes("left as it is: the daemon at")),
    ).toHaveLength(1);
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
    expect(h.tmux.binding).toBe(DEFAULT_COMMAND);
  });

  // [LAW:one-source-of-truth] The binding names no renderer: what differs per
  // renderer rides on the session it draws.
  test("two renderers on one server bind the same text, and each session carries its own renderer's click", async () => {
    const a = harness(["$1", "$2"]);
    const b = harness([], {
      tmux: a.tmux,
      name: parseRendererAddress("dev"),
      owner: "/tmp/dev.sock",
      handler: "dev-node url-handle",
      signer: OTHER_SIGNER,
    });
    a.hold("s1", "%1");
    await a.answer({ "%1": "$1" }, { $1: "%1" });
    const bound = a.tmux.binding;
    b.hold("s2", "%2");
    await b.answer({ "%2": "$2" }, { $2: "%2" });
    expect(a.tmux.binding).toBe(bound);
    expect(userOf(a.tmux)).toEqual([["switch-client", "-t", "="]]);
    expect(session(a, "$1").get(CLICK_OPTION)).toBe(
      `cc-candybar url-handle cc-candybar://to/main/range/${encodeURIComponent(SOCKET)}/${TEST_SIGNER.signBinding(SOCKET)}`,
    );
    expect(session(a, "$2").get(CLICK_OPTION)).toBe(
      `dev-node url-handle cc-candybar://to/dev/range/${encodeURIComponent(SOCKET)}/${OTHER_SIGNER.signBinding(SOCKET)}`,
    );
    expect(session(a, "$2").get(RENDERER_OPTION)).toBe("dev");
  });

  test("the first renderer to release leaves the binding while another's session names it, and the last puts the user's back", async () => {
    const a = harness(["$1", "$2"]);
    const b = harness([], {
      tmux: a.tmux,
      name: parseRendererAddress("dev"),
      owner: "/tmp/dev.sock",
      signer: OTHER_SIGNER,
    });
    a.hold("s1", "%1");
    await a.answer({ "%1": "$1" }, { $1: "%1" });
    b.hold("s2", "%2");
    await b.answer({ "%2": "$2" }, { $2: "%2" });
    await a.answer({}, {});
    expect(oursOn(a.tmux)).toBe(true);
    expect(
      a.logs.some((l) =>
        l.includes(
          "left MouseDown1Status bound: a session still names a renderer",
        ),
      ),
    ).toBe(true);
    await b.answer({}, {});
    expect(a.tmux.binding).toBe(DEFAULT_COMMAND);
    expect(
      b.logs.some((l) =>
        l.includes(
          'restored MouseDown1Status to "\\"switch-client\\" \\"-t\\" \\"=\\""',
        ),
      ),
    ).toBe(true);
  });

  // [LAW:no-ambient-temporal-coupling] tmux decides the restore in the call
  // that writes it, so a renderer naming a session after the listing was read
  // keeps its binding.
  test("a restore racing another renderer's install keeps the binding", async () => {
    const h = harness(["$1", "$2"]);
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    h.tmux.onRun = (args) => {
      if (
        args[0] === "if-shell" &&
        args.includes(`display-message -p ccb:held`)
      )
        session(h, "$2").set(RENDERER_OPTION, "dev");
    };
    await h.answer({}, {});
    expect(oursOn(h.tmux)).toBe(true);
    expect(h.logs.some((l) => l.includes("left MouseDown1Status bound"))).toBe(
      true,
    );
  });

  // An older build's binding has this one's shape, with its own click and the
  // user's command as its else-branch.
  const older = (click: string, otherwise: string) =>
    [
      "if-shell",
      "-F",
      "#{m:ccb*,#{mouse_status_range}}",
      `run-shell -b ${click}`,
      otherwise,
    ]
      .map(printed)
      .join(" ");

  test.each([
    ["before names", "old-node url-handle cc-candybar://tmux-status-click/y"],
    [
      "named, with the old verb",
      "old-node url-handle cc-candybar://to/main/tmux-status-click/y",
    ],
  ])(
    "a binding an older build left (%s) is bound over its own else-branch, and the user's command comes back at the end",
    async (_form, click) => {
      const h = harness();
      h.tmux.binding = older(click, "select-pane \\; display-message hi");
      h.tmux.global.set(
        OLDER_BINDING_RECORD,
        JSON.stringify({ owner: OWNER, prior: null }),
      );
      h.hold("s1", "%1");
      await h.answer({ "%1": "$1" }, { $1: "%1" });
      expect(h.tmux.binding).not.toContain("old-node");
      expect(userOf(h.tmux)).toEqual([
        ["select-pane"],
        ["display-message", "hi"],
      ]);
      expect(h.tmux.global.has(OLDER_BINDING_RECORD)).toBe(false);
      await h.answer({}, {});
      expect(userOf(h.tmux)).toEqual([
        ["select-pane"],
        ["display-message", "hi"],
      ]);
      expect(oursOn(h.tmux)).toBe(false);
    },
  );

  test("an older build bound over this one's binding is peeled to the user's command, bound and restored", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    // An older renderer binds over this one: its else-branch is what it read.
    h.tmux.binding = older(
      "old-node url-handle cc-candybar://to/main/tmux-status-click/y",
      h.tmux.binding!,
    );
    await h.answer({}, {});
    expect(h.tmux.binding).toBe(DEFAULT_COMMAND);
  });

  test("a bound period ends once: a reconcile with nothing bound writes nothing", async () => {
    const h = harness();
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    await h.answer({}, {});
    const writes = h.owner.stats().writes;
    const restores = h.logs.filter((l) =>
      l.includes("MouseDown1Status"),
    ).length;
    await h.answer({}, {});
    await h.answer({}, {});
    expect(h.owner.stats().writes).toBe(writes);
    expect(h.logs.filter((l) => l.includes("MouseDown1Status")).length).toBe(
      restores,
    );
  });

  test("a shutdown's restore is held by the same guard while another session names a renderer", async () => {
    const h = harness(["$1", "$2"]);
    h.hold("s1", "%1");
    await h.answer({ "%1": "$1" }, { $1: "%1" });
    session(h, "$2").set(RENDERER_OPTION, "dev");
    h.owner.restoreAll((socket, args) => h.tmux.runSync(socket, args));
    expect(oursOn(h.tmux)).toBe(true);
    session(h, "$2").delete(RENDERER_OPTION);
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
    h.owner.answered(SOCKET, {
      sessionOf: new Map([["%1", "$1"]]),
      shownBy: new Map([["$1", "%1"]]),
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.owner.restoreAll((socket, args) => h.tmux.runSync(socket, args));
    h.tmux.gate = null;
    release();
    await h.owner.settled();
    expect([...session(h)]).toEqual([]);
    expect(h.tmux.binding).toBe(DEFAULT_COMMAND);
    expect(h.tmux.global.has(OLDER_BINDING_RECORD)).toBe(false);
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
