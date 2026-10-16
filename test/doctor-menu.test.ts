// [LAW:verifiable-goals] brandon-doctor-b6a: the `🍫 › 🧰 tools › 🩺 doctor`
// route, driven through the real loader, the real spine (registerDslConfig +
// renderDsl), and the real verb handlers — with a fake DoctorEdge whose tmux
// probe answers `RGB`, and a settings.json in a temp Claude Code directory the
// recorded `claudeConfigDir` hint names. The recorded client hints are seeded the way server.ts records them, so the click reads
// the facts of the session's "last render" exactly as production does.

import { memoryMarkBook } from "./helpers/mark-book";
import fs from "node:fs";
import { POWERLINE } from "./helpers/powerline";
import os from "node:os";
import path from "node:path";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/loader/reserved-namespace";

import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
} from "../src/config/disclosure";
import { recordRender, testVerbContext, effectsOf } from "./helpers/click";
import { parseHandlerUrl } from "../src/install/index";
import {
  parseEffects,
  VERB_DISPATCH,
  VERB_DOCTOR_FIX,
  VERB_DOCTOR_MARK,
  VERB_DOCTOR_RUN,
} from "../src/click/wire";
import { VERBS, SESSION_CLIENT_HINTS_KEY, BadVerbArgs } from "../src/daemon/verbs";
import type { VerbContext } from "../src/daemon/verbs";
import { TMUX_TRUECOLOR_VAR } from "../src/doctor/checks";
import type { ConfigLoad, DoctorEdge } from "../src/doctor/edge";
import type { TmuxHint } from "../src/tmux-hint";
import type { TerminalEnvHint } from "../src/terminal-hint";
import { linkUrls, stripAnsi } from "./helpers/ansi";
import { instantOf } from "../src/utils/instant";

const ALLOWED = new Set(listResolvablePaletteNames());
const TAB_KEY = `${SETTINGS_NS}tab`;

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};


const PAYLOAD = {
  session_id: "s1",
  project_dir: "/tmp/proj",
  workspace: { current_dir: "/tmp/proj" },
  model: { display_name: "Opus" },
};

const HINT: TmuxHint = { socket: "/s", pane: "%1", truecolor: null };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-menu-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The load's outcome; the config it carries is the one the runtime renders.
type LoadOutcome = Omit<ConfigLoad, "config">;
const CLEAN_LOAD: LoadOutcome = {
  layers: [],
  error: null,
  warning: null,
  unused: [],
};

// The session's terminal, as its client reported it, and the font the edge
// reads for a terminal that draws from one. By default Ghostty, which ships
// its own Nerd Font symbols, so a test about another check never reads a font.
interface TerminalFixture {
  readonly env: TerminalEnvHint;
  readonly fontInUse: DoctorEdge["fontInUse"];
}
const GHOSTTY: TerminalFixture = {
  env: { TERM_PROGRAM: "ghostty" },
  fontInUse: () => {
    throw new Error("fontInUse must not run in this case");
  },
};

function buildRuntime(
  tmux: TmuxHint | null,
  load: LoadOutcome = CLEAN_LOAD,
  terminal: TerminalFixture = GHOSTTY,
) {
  const config = parseAndValidate(
    "<user>",
    `{ globals: {}, root: { h: ['directory', 'model'] } }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  // What server.ts records on a render: the stamped hints, as JSON.
  sessionState.set(
    "s1",
    SESSION_CLIENT_HINTS_KEY,
    JSON.stringify({
      tmux,
      claudeConfigDir: dir,
      terminalEnv: terminal.env,
    }),
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, sessionState);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  const render = (): string =>
    stripAnsi(
      renderDsl(config, compiled, store, registry, PAYLOAD, instantOf(new Date()), OPTS),
    );
  const renderRaw = (): string =>
    renderDsl(config, compiled, store, registry, PAYLOAD, instantOf(new Date()), OPTS);
  recordRender(sessionState, "s1");
  const settingsPath = path.join(dir, "settings.json");
  let probes = 0;
  const doctor: DoctorEdge = {
    probeTmux: () => {
      probes += 1;
      return {
        kind: "ok",
        value: {
          features: ["osc7", "RGB", "sixel"],
          termtype: "ghostty 1.3.1",
          termname: "xterm-ghostty",
          pid: 4242,
        },
      };
    },
    remoteLogin: () => {
      throw new Error("remoteLogin must not run in this case");
    },
    marks: memoryMarkBook(),
    fontInUse: terminal.fontInUse,
    loadConfig: () => ({ ...load, config }),
  };
  const logs: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, undefined, config),
    doctor,
    dlog: (_level, message) => logs.push(message),
  };
  const click = (url: string): void => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) {
      const handler = VERBS.get(e.verb);
      if (!handler) throw new Error(`no handler for verb "${e.verb}"`);
      handler(e.value, ctx);
    }
  };
  const clickWriting = (key: string, value: string): void => {
    const url = linkUrls(renderRaw()).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    click(url);
  };
  const urlOfVerb = (verb: string): string | undefined =>
    linkUrls(renderRaw()).find((u) =>
      effectsOf(u).some((e) => e.verb === verb),
    );
  const clickVerb = (verb: string): void => {
    const url = urlOfVerb(verb);
    if (!url) throw new Error(`no affordance with verb ${verb} rendered`);
    click(url);
  };
  const openTools = (): void => {
    clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    clickWriting(TAB_KEY, "tools");
  };
  return {
    sessionState,
    settingsPath,
    render,
    click,
    clickVerb,
    urlOfVerb,
    openTools,
    logs,
    ctx,
    renderRaw,
    probes: () => probes,
  };
}

describe("🍫 › 🧰 tools › 🩺 doctor", () => {
  test("the tools tab holds the doctor button and no report until it runs", () => {
    const rt = buildRuntime(HINT);
    expect(rt.render()).not.toContain("🩺 doctor");
    rt.openTools();
    const out = rt.render();
    expect(out).toContain("▾ 🧰 tools");
    expect(out).toContain("🩺 doctor");
    expect(out).not.toMatch(/[✓✗] tmux truecolor/);
    expect(rt.urlOfVerb(VERB_DOCTOR_RUN)).toBeDefined();
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
  });

  test("the doctor's report rows are the body's own rows under the tools trigger", () => {
    const rt = buildRuntime(HINT);
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    const lines = rt.render().split("\n");
    const toolsRow = lines.findIndex((l) => l.includes("▾ 🧰 tools"));
    expect(toolsRow).toBeGreaterThanOrEqual(0);
    // A vertical body: the button on one row, then one row per check in
    // CHECKS order — a long reason never widens the settings band it hangs from.
    expect(lines[toolsRow + 1]).toContain("🩺 doctor");
    // The tools body leads with one ✕ (brandon-disclosure-43z), on its first
    // row; the report row leads with the blank of its width, a cell of its own
    // right after the row's lead cap, and its text follows the seam.
    expect(lines[toolsRow + 1]!.startsWith(POWERLINE.lead + DISCLOSURE_GLYPH_CLOSE)).toBe(true);
    const reports = lines.slice(toolsRow + 2, toolsRow + 5);
    for (const report of reports) {
      expect(report.startsWith(`${POWERLINE.lead} `)).toBe(true);
    }
    expect(reports[0]).toContain("✓ config");
    expect(reports[1]).toContain("✓ URL handler");
    expect(reports[2]).toContain("✗ tmux truecolor");
  });

  // brandon-doctor-v62x.e91: the config check's row, and the run's log line
  // carrying each check's verdict and how many problems a failed one found.
  test("a config with problems: its row names the first and counts the rest, with no [fix]", () => {
    const rt = buildRuntime(null, {
      ...CLEAN_LOAD,
      layers: ["/p/.cc-candybar.json5"],
      unused: [
        { kind: "variable", name: "v" },
        { kind: "action", name: "a" },
      ],
    });
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    const out = rt.render();
    expect(out).toContain(
      '✗ config — variable "v" is never read (+1 more — run `cc-candybar doctor`)',
    );
    expect(out).toContain("✓ tmux truecolor");
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
    expect(rt.logs.filter((line) => line.startsWith("doctor:"))).toEqual([
      "doctor: config=failed(2) urlHandler=ok tmuxTruecolor=ok effectRefresh=ok nerdFont=ok glyphs=e0b0,e0b1 terminal=ghostty@- font=- mark=- (session=s1)",
    ]);
  });

  test("in tmux with RGB and the var unset: failed row with [fix]; the fix lands and the row says restart", () => {
    const rt = buildRuntime(HINT);
    fs.writeFileSync(
      rt.settingsPath,
      `{\n  "env": { "FORCE_COLOR": "3" },\n  "model": "opus"\n}\n`,
    );
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    const failed = rt.render();
    expect(failed).toContain(
      "✗ tmux truecolor — Claude Code renders the bar in 256 colours inside tmux [fix]",
    );

    rt.clickVerb(VERB_DOCTOR_FIX);
    // one probe for the run click, one for the fix click — the post-fix
    // report re-reads only the settings env the fix changed
    expect(rt.probes()).toBe(2);
    expect(JSON.parse(fs.readFileSync(rt.settingsPath, "utf8"))).toEqual({
      env: { FORCE_COLOR: "3", [TMUX_TRUECOLOR_VAR]: "1" },
      model: "opus",
    });
    const fixed = rt.render();
    expect(fixed).toContain(
      `✗ tmux truecolor — ${TMUX_TRUECOLOR_VAR} is set in ${rt.settingsPath} — restart Claude Code to apply`,
    );
    expect(fixed).not.toContain("[fix]");
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
  });

  // [LAW:no-silent-failure] A session the daemon never rendered has no client
  // facts; the doctor refuses loudly rather than diagnose a guessed "not in
  // tmux".
  test("a doctor-run click for a session that never rendered is refused", () => {
    const rt = buildRuntime(HINT);
    const url = `cc-candybar://${VERB_DOCTOR_RUN}/never-rendered`;
    expect(() => rt.click(url)).toThrow(BadVerbArgs);
    expect(() => rt.click(url)).toThrow(/never-rendered has not rendered yet/);
  });

  // [LAW:no-silent-failure] A stale `[fix]` URL (the world moved since the
  // render that drew it) is refused loudly, never a silent second write.
  test("a second fix click is refused: nothing left to fix", () => {
    const rt = buildRuntime(HINT);
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    const fixUrl = rt.urlOfVerb(VERB_DOCTOR_FIX)!;
    rt.clickVerb(VERB_DOCTOR_FIX);
    const before = fs.readFileSync(rt.settingsPath, "utf8");
    expect(() => rt.click(fixUrl)).toThrow(BadVerbArgs);
    expect(fs.readFileSync(rt.settingsPath, "utf8")).toBe(before);
  });

  // brandon-effects-2gka.21e: the session's own effect pick, a statusLine with
  // no interval — the row fails with [fix], and the fix lands the interval
  // beside the statusLine's keys.
  test("a session wearing an effect, no refresh interval: failed row with [fix]; the fix lands and the row passes", () => {
    const rt = buildRuntime(null);
    fs.writeFileSync(
      rt.settingsPath,
      `{\n  "statusLine": { "type": "command", "command": "cc-candybar" }\n}\n`,
    );
    rt.sessionState.set("s1", "effect", "shimmer");
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain(
      "✗ effect refresh — the bar wears the shimmer effect, but Claude Code redraws it only on events [fix]",
    );

    rt.clickVerb(VERB_DOCTOR_FIX);
    expect(JSON.parse(fs.readFileSync(rt.settingsPath, "utf8"))).toEqual({
      statusLine: { type: "command", command: "cc-candybar", refreshInterval: 1 },
    });
    expect(rt.render()).toContain("✓ effect refresh");
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
    expect(rt.logs).toContain(
      'doctor-fix: effectRefresh → claude-settings statusLine.refreshInterval=1 (session=s1)',
    );
  });

  test("not in tmux: the check is ok", () => {
    const rt = buildRuntime(null);
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain("✓ tmux truecolor");
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
  });

  // brandon-doctor-v62x.2ww: the Nerd Font row, its glyphs to look at, and
  // the mark that settles what the doctor could not read.
  describe("the Nerd Font row", () => {
    const fontCalls: unknown[][] = [];
    const ITERM_MENLO: TerminalFixture = {
      env: { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.7.2" },
      fontInUse: (...args) => {
        fontCalls.push(args);
        return {
          kind: "ok",
          value: { font: "Menlo-Regular", from: 'iTerm2 profile "Default"', lacks: [...args[2]] },
        };
      },
    };
    beforeEach(() => {
      fontCalls.length = 0;
    });

    const markUrl = (rt: ReturnType<typeof buildRuntime>, mark: string) =>
      rt.urlOfVerb(VERB_DOCTOR_MARK) === undefined
        ? undefined
        : linkUrls(rt.renderRaw()).find((u) =>
            effectsOf(u).some(
              (e) => e.verb === VERB_DOCTOR_MARK && e.args[2] === mark,
            ),
          );

    test("a font without the glyphs: the row names it, shows the glyphs, and offers ✓ and ✗", () => {
      const rt = buildRuntime(null, CLEAN_LOAD, ITERM_MENLO);
      rt.openTools();
      rt.clickVerb(VERB_DOCTOR_RUN);
      const out = rt.render();
      expect(out).toContain(
        '✗ Nerd Font — iTerm2 3.7.2 draws with Menlo-Regular (iTerm2 profile "Default"), which has no U+E0B0 U+E0B1',
      );
      expect(out).toContain("\ue0b0\ue0b1 [✓ shapes] [✗ boxes]");
      // The font edge was asked about exactly the glyphs the bar draws.
      expect(fontCalls).toEqual([
        [{ name: "iterm2", version: "3.7.2" }, ITERM_MENLO.env, "\ue0b0\ue0b1"],
      ]);
      expect(rt.logs.filter((l) => l.startsWith("doctor:"))).toEqual([
        'doctor: config=ok urlHandler=ok tmuxTruecolor=ok effectRefresh=ok nerdFont=failed(1) glyphs=e0b0,e0b1 terminal=iterm2@3.7.2 font="Menlo-Regular":lacks2 mark=- (session=s1)',
      ]);
    });

    test("marking ✓ records the mark on this sighting and the row is ok", () => {
      const rt = buildRuntime(null, CLEAN_LOAD, ITERM_MENLO);
      rt.openTools();
      rt.clickVerb(VERB_DOCTOR_RUN);
      fontCalls.length = 0;
      rt.click(markUrl(rt, "drawn")!);
      // One gathering per click: the rate-limited font spawn runs once.
      expect(fontCalls).toHaveLength(1);
      const out = rt.render();
      expect(out).toContain("✓ Nerd Font");
      expect(out).not.toContain("[✓ shapes]");
      expect(rt.logs).toContain(
        "doctor-mark: nerdFont drawn on iTerm2 3.7.2 with Menlo-Regular|U+E0B0 U+E0B1 (session=s1)",
      );
      expect(rt.logs.at(-1)).toMatch(/nerdFont=ok .* mark=drawn \(session=s1\)$/);
    });

    test("marking ✗ keeps the row failed, says boxes, and leaves ✓ to mark later", () => {
      const rt = buildRuntime(null, CLEAN_LOAD, ITERM_MENLO);
      rt.openTools();
      rt.clickVerb(VERB_DOCTOR_RUN);
      rt.click(markUrl(rt, "boxes")!);
      const out = rt.render();
      expect(out).toContain("✗ Nerd Font — iTerm2 3.7.2 draws U+E0B0 U+E0B1 as boxes");
      expect(markUrl(rt, "drawn")).toBeDefined();
    });

    test("a mark on a check with nothing to look at is refused", () => {
      const rt = buildRuntime(null);
      rt.openTools();
      rt.clickVerb(VERB_DOCTOR_RUN);
      expect(rt.render()).toContain("✓ Nerd Font");
      expect(markUrl(rt, "drawn")).toBeUndefined();
      expect(() =>
        VERBS.get(VERB_DOCTOR_MARK)!("s1/nerdFont/drawn", rt.ctx),
      ).toThrow(BadVerbArgs);
      expect(() =>
        VERBS.get(VERB_DOCTOR_MARK)!("s1/nerdFont/perhaps", rt.ctx),
      ).toThrow(/the mark is "perhaps"/);
    });

    test("only a check that takes a mark is given the actions that make one", () => {
      const { actions } = parseAndValidate(
        "<user>",
        `{ globals: {} }`,
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      );
      const marked = Object.values(actions).flatMap((a) =>
        "doctor" in a && a.doctor === "mark" ? [`${a.check}:${a.mark}`] : [],
      );
      expect(marked.sort()).toEqual(["nerdFont:boxes", "nerdFont:drawn"]);
    });
  });

  test("closing 🍫 hides the tools body even when it was left open", () => {
    const rt = buildRuntime(HINT);
    rt.openTools();
    rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain("tmux truecolor");
    rt.sessionState.set("s1", SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
    const closed = rt.render();
    expect(closed).not.toContain("🩺 doctor");
    expect(closed).not.toContain("tmux truecolor");
  });
});
