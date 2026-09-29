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
import { VERB_SLASH, effectsUrl } from "../src/click/wire";
import {
  SESSION_CLIENT_HINTS_KEY,
  SESSION_RENDER_ORIGIN_KEY,
  encodeRenderOrigin,
} from "../src/daemon/verbs";
import { productionClaudeInputEdge } from "../src/claude-input/edge";
import { promptState } from "../src/claude-input/prompt-screen";
import { parseSlashLine } from "../src/claude-input/slash-line";
import { linkUrls } from "./helpers/ansi";
import type { TmuxHint } from "../src/tmux-hint";

const ALLOWED = new Set(listResolvablePaletteNames());
const OPTS = {
  style: "powerline" as const,
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
const HINT: TmuxHint = { socket: "/tmp/tmux-501/default", pane: "%7", truecolor: null };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-slash-"));
  // One line per argument, a line of `@@` after each invocation; a `display`
  // prints the pane mode and the served screen, as the real pair does.
  fs.writeFileSync(
    path.join(dir, "tmux"),
    [
      "#!/bin/sh",
      `for a in "$@"; do printf '%s\\n' "$a"; done >> "${dir}/argv"`,
      `echo @@ >> "${dir}/argv"`,
      `if [ "$3" = display ]; then cat "${dir}/mode" "${dir}/screen"; fi`,
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
      actions: { compact: { slash: "/compact" }, pickModel: { slash: "/model opus" } },
      segments: { cmds: { template: '{{ action "compact" "⊘" }} {{ action "pickModel" "✱" }}' } },
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
        "set-buffer", "-b", "cc-candybar-slash", "--", "/model opus", ";",
        "send-keys", "-t", "%7", "C-s", ";",
        "paste-buffer", "-p", "-d", "-b", "cc-candybar-slash", "-t", "%7", ";",
        "send-keys", "-t", "%7", "Enter",
      ],
    ]);
    expect(rt.logged).toContain("slash: typed /model opus into %7 (session=s1)");
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
    ["copy mode", SCREENS.idle, true, /copy mode/],
  ])("%s: read, refused, nothing typed", (_, screen, inMode, reason) => {
    serve(screen, inMode);
    const rt = runtime(HINT);
    expect(() => clickUrl(rt.urls[0]!, rt.ctx)).toThrow(reason);
    expect(invocations().map((argv) => argv[2])).toEqual(["display"]);
  });

  test("a line no action declares is refused before tmux is asked", () => {
    const rt = runtime(HINT);
    const forged = effectsUrl([{ verb: VERB_SLASH, args: ["s1", "/clear"] }]);
    expect(() => clickUrl(forged, rt.ctx)).toThrow(
      /"\/clear" is not a command this config declares \(it declares: \/compact, \/model opus\)/,
    );
    expect(invocations()).toEqual([]);
  });
});
