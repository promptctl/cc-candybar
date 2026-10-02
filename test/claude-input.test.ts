// [LAW:verifiable-goals] brandon-context-ceiling-xta.7xt: a `slash` action
// types its declared command into the clicked session's Claude Code pane.
// Driven through the real loader, the real spine (registerDslConfig +
// renderDsl), the real verb table AND the production tmux edge, with a stub
// `tmux` on PATH that records its argv and serves a captured screen — so the
// assertions are the exact commands tmux would run. The screens are the ones
// Claude Code 2.1.284 drew in the measurements prompt-screen.ts records.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { testVerbContext, effectsOf, clickUrl } from "./helpers/click";
import { VERB_SET_STATE, VERB_SLASH, effectsUrl } from "../src/click/wire";
import {
  deriveActionValidators,
  registerStateValidator,
} from "../src/daemon/verbs/state-validators";
import {
  SESSION_CLIENT_HINTS_KEY,
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
} from "../src/daemon/verbs";
import { productionClaudeInputEdge } from "../src/claude-input/edge";
import { promptState } from "../src/claude-input/prompt-screen";
import { parseSlashLine } from "../src/claude-input/slash-line";
import { linkUrls } from "./helpers/ansi";
import { __resetRateLimitsForTest } from "../src/proc/launch";
import type { TmuxHint } from "../src/tmux-hint";
import { AUTOCOMPACT_WINDOWS } from "../src/segments/autocompact";

const ALLOWED = new Set(listResolvablePaletteNames());
const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

const RULE = "─".repeat(60);
const BAR = ["   🍫  proj  ⎇ main ▸ ", "  ⏸ manual mode on"];
const box = (prompt: string, hint = ""): string[] => [
  "⏺ Done.",
  "",
  hint,
  `${RULE} probe ─`,
  prompt,
  RULE,
  ...BAR,
];
const SCREENS = {
  idle: box("❯ "),
  draft: box("❯ half a thought I have not sent"),
  queued: box("❯ Press up to edit queued messages", "  ctrl+x ctrl+s to send now"),
  multiline: [...box("❯ first line of a draft").slice(0, 5), "  second line", RULE, ...BAR],
  stashed: box("❯ ", "Ctrl+Y to paste deleted text · › stashed"),
  // Measured: a stash held while messages queue keeps its own hint row
  // directly above the box, the queue's hint above that.
  queuedStashed: [
    "❯ queued one",
    "  ctrl+x ctrl+s to send now",
    `${" ".repeat(40)}› stashed`,
    RULE,
    "❯ Press up to edit queued messages",
    RULE,
    ...BAR,
  ],
  permission: [
    "❯ Run exactly this bash command: python3 -c 'print(42)' > out.txt",
    "",
    RULE,
    " Bash command",
    "",
    "   python3 -c 'print(42)' > out.txt",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to this directory",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend",
  ],
};

describe("promptState: typing lands only in Claude Code's bare input box", () => {
  test.each([
    ["an empty prompt", SCREENS.idle],
    ["a draft (ctrl+s stashes it, the submit restores it)", SCREENS.draft],
    ["a turn in progress", SCREENS.queued],
    ["a multi-line draft", SCREENS.multiline],
  ])("%s is ready", (_, screen) => {
    expect(promptState({ inMode: false, screen })).toEqual({ kind: "ready" });
  });

  test("a stash the user holds is refused: ctrl+s would pop it into the input", () => {
    expect(promptState({ inMode: false, screen: SCREENS.stashed })).toEqual({
      kind: "stashed",
    });
  });

  test("a permission dialog is refused: the Enter would approve the tool call", () => {
    expect(promptState({ inMode: false, screen: SCREENS.permission })).toEqual({
      kind: "no-prompt",
    });
  });

  test("a screen with no input box is refused, never typed into blind", () => {
    expect(promptState({ inMode: false, screen: ["$ ", ""] })).toEqual({
      kind: "no-prompt",
    });
  });

  test("a pane in tmux copy mode is refused, whatever it shows", () => {
    expect(promptState({ inMode: true, screen: SCREENS.idle })).toEqual({
      kind: "in-mode",
    });
  });
});

describe("parseSlashLine: a line is one slash command, and only text", () => {
  test.each(["/compact", "/model opus", "/compact focus on the auth refactor"])(
    "%j is a line",
    (raw) => expect(parseSlashLine(raw)).toEqual({ kind: "line", line: raw }),
  );
  test.each([
    ["compact"],
    ["/"],
    ["/ compact"],
    ["//x"],
    ["/compact\n/clear"],
    ["/compact\r"],
    ["/model \u001b[A"],
    [42],
  ])("%j is refused", (raw) => {
    expect(parseSlashLine(raw).kind).toBe("refused");
  });

  test("the loader refuses a bad line and a stray key, naming both", () => {
    expect(() =>
      parseAndValidate(
        "<user>",
        `{ actions: { a: { slash: "compact" }, b: { slash: "/clear", to: "x" } } }`,
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      ),
    ).toThrow(/actions\.a\.slash[\s\S]*actions\.b\.to/);
  });
});

// ─── The click, end to end through a stub tmux ────────────────────────────────

let dir: string;
let savedPath: string | undefined;
// A socket inside the test's own directory: were the stub ever bypassed, a
// real tmux would find no server there instead of typing into a live pane.
let HINT: TmuxHint;

beforeEach(() => {
  __resetRateLimitsForTest();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-slash-"));
  HINT = { socket: path.join(dir, "tmux.sock"), pane: "%7", truecolor: null };
  // One line per argument, a line of `@@` after each invocation; a `display`
  // prints the pane mode and the served screen, as the real pair does, and a
  // `load-buffer` keeps what arrived on stdin.
  fs.writeFileSync(
    path.join(dir, "tmux"),
    [
      "#!/bin/sh",
      `for a in "$@"; do printf '%s\\n' "$a"; done >> "${dir}/argv"`,
      `echo @@ >> "${dir}/argv"`,
      `if [ "$3" = display ]; then cat "${dir}/mode" "${dir}/screen"; fi`,
      `if [ "$3" = load-buffer ]; then cat > "${dir}/stdin"; fi`,
    ].join("\n"),
    { mode: 0o755 },
  );
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath ?? ""}`;
});
afterEach(() => {
  process.env.PATH = savedPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

function serve(screen: readonly string[], inMode = false): void {
  fs.writeFileSync(path.join(dir, "mode"), inMode ? "1\n" : "0\n");
  fs.writeFileSync(path.join(dir, "screen"), screen.join("\n"));
}

const invocations = (): string[][] =>
  fs.existsSync(path.join(dir, "argv"))
    ? fs
        .readFileSync(path.join(dir, "argv"), "utf8")
        .split("@@\n")
        .filter((s) => s !== "")
        .map((s) => s.trimEnd().split("\n"))
    : [];

function runtime(tmux: TmuxHint | null) {
  const config = parseAndValidate(
    "<user>",
    `{
      actions: {
        compact: { slash: "/compact" },
        pickModel: { slash: "/model opus" },
        keepApi: { slash: "/compact keep the api;" },
      },
      segments: { cmds: { template: '{{ action "compact" "⊘" }} {{ action "pickModel" "✱" }} {{ action "keepApi" "⌘" }}' } },
      globals: {},
      root: { h: ['cmds'] },
    }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  sessionState.set(
    "s1",
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({ projectDir: "/tmp/proj", cwd: "/tmp/proj", configFile: null }),
  );
  sessionState.set("s1", SESSION_CLIENT_HINTS_KEY, JSON.stringify({ tmux }));
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const raw = renderDsl(config, compiled, store, registry, { session_id: "s1" }, OPTS);
  const logged: string[] = [];
  const ctx = {
    ...testVerbContext(sessionState, undefined, config),
    dlog: (_level: string, msg: string) => logged.push(msg),
    claudeInput: productionClaudeInputEdge(),
  };
  const urls = linkUrls(raw).filter((u) =>
    effectsOf(u).some((e) => e.verb === VERB_SLASH),
  );
  return { urls, ctx, sessionState, logged };
}

describe("a slash click", () => {
  test("renders one effect per action carrying the declared line", () => {
    const rt = runtime(HINT);
    expect(rt.urls.map((u) => effectsOf(u))).toEqual([
      [{ verb: VERB_SLASH, args: ["s1", "/compact"] }],
      [{ verb: VERB_SLASH, args: ["s1", "/model opus"] }],
      [{ verb: VERB_SLASH, args: ["s1", "/compact keep the api;"] }],
    ]);
  });

  test("types into the session's pane: read it, then stash, paste, Enter in one tmux call", () => {
    serve(SCREENS.draft);
    const rt = runtime(HINT);
    clickUrl(rt.urls[1]!, rt.ctx);
    expect(invocations()).toEqual([
      ["-S", HINT.socket, "display", "-p", "-t", "%7", "#{pane_in_mode}", ";", "capture-pane", "-p", "-t", "%7"],
      [
        "-S", HINT.socket,
        "load-buffer", "-b", "cc-candybar-slash", "-", ";",
        "send-keys", "-t", "%7", "C-s", ";",
        "paste-buffer", "-p", "-d", "-b", "cc-candybar-slash", "-t", "%7", ";",
        "send-keys", "-t", "%7", "Enter",
      ],
    ]);
    expect(fs.readFileSync(path.join(dir, "stdin"), "utf8")).toBe("/model opus");
    expect(rt.logged).toContain("slash: typed /model opus into %7 (session=s1)");
  });

  test("a line ending in `;` is typed whole: tmux never parses it as a separator", () => {
    serve(SCREENS.idle);
    const rt = runtime(HINT);
    clickUrl(rt.urls[2]!, rt.ctx);
    expect(fs.readFileSync(path.join(dir, "stdin"), "utf8")).toBe("/compact keep the api;");
    expect(invocations()[1]).not.toContain("/compact keep the api;");
  });

  test("a double-click types once: the second is refused in the bar, typing nothing", () => {
    serve(SCREENS.idle);
    const rt = runtime(HINT);
    clickUrl(rt.urls[0]!, rt.ctx);
    expect(() => clickUrl(rt.urls[0]!, rt.ctx)).toThrow(/typed a command moments ago/);
    expect(rt.sessionState.get("s1", "click.error")).toMatch(/\/compact was not typed/);
    expect(invocations().map((argv) => argv[2])).toEqual(["display", "load-buffer", "display"]);
  });

  test("a click the pane refused types nothing, so clicking again at once goes through", () => {
    serve(SCREENS.permission);
    const rt = runtime(HINT);
    expect(() => clickUrl(rt.urls[0]!, rt.ctx)).toThrow(/not at its prompt/);
    serve(SCREENS.idle);
    clickUrl(rt.urls[0]!, rt.ctx);
    expect(invocations().map((argv) => argv[2])).toEqual(["display", "display", "load-buffer"]);
  });

  test("outside tmux: refused in the bar, and tmux is never run", () => {
    const rt = runtime(null);
    expect(() => clickUrl(rt.urls[0]!, rt.ctx)).toThrow(/not running inside tmux/);
    expect(rt.sessionState.get("s1", "click.error")).toMatch(
      /\/compact was not typed: this Claude Code is not running inside tmux/,
    );
    expect(invocations()).toEqual([]);
  });

  test.each([
    ["a permission dialog", SCREENS.permission, false, /not at its prompt/],
    ["a held stash", SCREENS.stashed, false, /stashed prompt/],
    ["a held stash behind queued messages", SCREENS.queuedStashed, false, /stashed prompt/],
    ["copy mode", SCREENS.idle, true, /copy mode/],
  ])("%s: read, refused, nothing typed", (_, screen, inMode, reason) => {
    serve(screen, inMode);
    const rt = runtime(HINT);
    expect(() => clickUrl(rt.urls[0]!, rt.ctx)).toThrow(reason);
    expect(invocations().map((argv) => argv[2])).toEqual(["display"]);
  });

  test("a line no action declares is refused before tmux is asked", () => {
    const rt = runtime(HINT);
    const forged = effectsUrl([{ verb: VERB_SLASH, args: ["s1", "/exit"] }]);
    // The declared lines in full, each once: the bundled command tray and
    // autocompact controls (merged under the config), then this config's own
    // (the settings menu's tray instance declares the tray's lines again).
    const declared = [
      "/compact",
      "/model",
      "/clear",
      "/autocompact auto",
      ...AUTOCOMPACT_WINDOWS.map((w) => `/autocompact ${w}`),
      "/model opus",
      "/compact keep the api;",
    ];
    expect(() => clickUrl(forged, rt.ctx)).toThrow(
      `"/exit" is not a command this config declares (it declares: ${declared.join(", ")})`,
    );
    expect(invocations()).toEqual([]);
  });
});

// ─── The command tray (brandon-context-ceiling-xta.qhj) ───────────────────────

// The bundled `commands` segment, placed as the bar's one segment: the same
// tray the settings menu's `candybar.commands` instances under its prefix.
function tray(tmux: TmuxHint | null) {
  const config = parseAndValidate(
    "<user>",
    "{ root: { h: ['commands'] } }",
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  sessionState.set(
    "s1",
    SESSION_RENDER_ORIGIN_KEY,
    encodeRenderOrigin({ projectDir: "/tmp/proj", cwd: "/tmp/proj", configFile: null }),
  );
  sessionState.set("s1", SESSION_CLIENT_HINTS_KEY, JSON.stringify({ tmux }));
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const disposers = deriveActionValidators(config).map(({ key, spec }) =>
    registerStateValidator(key, spec),
  );
  const ctx = {
    ...testVerbContext(sessionState, undefined, config),
    claudeInput: productionClaudeInputEdge(),
  };
  // The tray's links by what they do, in render order.
  const links = () =>
    linkUrls(renderDsl(config, compiled, store, registry, { session_id: "s1" }, OPTS)).map(
      (u) => ({ url: u, effects: effectsOf(u) }),
    );
  return { config, links, ctx, sessionState, dispose: () => disposers.forEach((d) => d()) };
}

const typedLines = (effects: { verb: string; args: string[] }[]) =>
  effects.filter((e) => e.verb === VERB_SLASH).map((e) => e.args[1]);

describe("the command tray: /compact, /model, /clear from the bar", () => {
  test.each(["/compact", "/model"])("%s is one click: typed into the session's pane", (line) => {
    serve(SCREENS.idle);
    const rt = tray(HINT);
    const button = rt.links().find((l) => typedLines(l.effects).includes(line))!;
    expect(button.effects).toEqual([{ verb: VERB_SLASH, args: ["s1", line] }]);
    clickUrl(button.url, rt.ctx);
    expect(invocations().map((argv) => argv[2])).toEqual(["display", "load-buffer"]);
    expect(fs.readFileSync(path.join(dir, "stdin"), "utf8")).toBe(line);
    rt.dispose();
  });

  test("/clear takes a second click: the first arms it and types nothing", () => {
    serve(SCREENS.idle);
    const rt = tray(HINT);
    // The bar tray's own /clear links: its arm key, or the line itself.
    const clearLinks = () =>
      rt.links().filter((l) =>
        l.effects.some((e) => e.args[1] === "commands.clear" || e.args[1] === "/clear"),
      );
    // Disarmed, no link in the tray can type /clear.
    const [arm] = clearLinks();
    expect(clearLinks()).toHaveLength(1);
    expect(arm!.effects).toEqual([
      { verb: VERB_SET_STATE, args: ["s1", "commands.clear", "armed"] },
    ]);
    clickUrl(arm!.url, rt.ctx);
    expect(invocations()).toEqual([]);

    // Armed: a confirm that disarms and types /clear, and a ✕ that only disarms.
    const [confirm, cancel] = clearLinks();
    expect(confirm!.effects).toEqual([
      { verb: VERB_SET_STATE, args: ["s1", "commands.clear", "disarmed"] },
      { verb: VERB_SLASH, args: ["s1", "/clear"] },
    ]);
    expect(cancel!.effects).toEqual([
      { verb: VERB_SET_STATE, args: ["s1", "commands.clear", "disarmed"] },
    ]);
    clickUrl(confirm!.url, rt.ctx);
    expect(fs.readFileSync(path.join(dir, "stdin"), "utf8")).toBe("/clear");
    expect(rt.sessionState.get("s1", "commands.clear")).toBe("disarmed");
    expect(typedLines(clearLinks().flatMap((l) => l.effects))).toEqual([]);
    rt.dispose();
  });

  test("outside tmux the confirm says so in the bar and disarms, typing nothing", () => {
    const rt = tray(null);
    const armed = () => rt.links().find((l) => typedLines(l.effects).includes("/clear"));
    clickUrl(
      rt.links().find((l) => l.effects.some((e) => e.args[1] === "commands.clear"))!.url,
      rt.ctx,
    );
    expect(() => clickUrl(armed()!.url, rt.ctx)).toThrow(/not running inside tmux/);
    expect(rt.sessionState.get("s1", "click.error")).toMatch(
      /\/clear was not typed: this Claude Code is not running inside tmux/,
    );
    expect(rt.sessionState.get("s1", "commands.clear")).toBe("disarmed");
    expect(invocations()).toEqual([]);
    rt.dispose();
  });

  test("the settings door and every tab disarm the menu's /clear, so a confirm is never clicked in a view it was not armed in", () => {
    const rt = tray(HINT);
    expect(rt.config.actions["candybar.menu"]).toEqual({
      do: ["candybar.menu.toggle", "candybar.resetAll.disarm", "candybar.commands.clear.disarm"],
    });
    // A tab click hides or shows the tray: arming /clear on ⚡ session, then
    // leaving it, must not come back to an armed confirm. `⟲` sits on the
    // door's first line, in view whichever tab is open, so a tab leaves it armed.
    for (const tab of ["session", "look", "layout", "config", "tools"]) {
      expect(rt.config.actions[`candybar.tab.${tab}`]).toEqual({
        do: [`candybar.tab.${tab}.toggle`, "candybar.commands.clear.disarm"],
      });
    }
    expect(rt.config.actions["candybar.commands.clear.disarm"]).toEqual({
      set: "candybar.commands.clear",
      to: "disarmed",
    });
    rt.dispose();
  });
});
