// [LAW:verifiable-goals] brandon-doctor-b6a: the `🍫 › 🧰 tools › 🩺 doctor`
// route, driven through the real loader, the real spine (registerDslConfig +
// renderDsl), and the real verb handlers — with a fake DoctorEdge whose tmux
// probe answers `RGB`, and a settings.json in a temp Claude Code directory the
// recorded `claudeConfigDir` hint names. The recorded client hints are seeded the way draw-bar.ts records them, so the click reads
// the facts of the session's "last render" exactly as production does.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { RenderSightings } from "../src/daemon/render-sightings";
import type { ServingDaemon } from "../src/daemon/limits";
import { emptyStores, healthyDaemonEdge, healthyDataEdge, noManagedSettings, HEALTHY_SERVING, HEALTHY_INSTALL_EDGE, healthyClient, renderSaid } from "./helpers/doctor-facts";
import type { ClientHint } from "../src/client-hint";
import {
  BUNDLED_GLYPHS,
  BUNDLED_GLYPHS_LOGGED,
  BUNDLED_GLYPHS_NAMED,
} from "./helpers/bundled-glyphs";
import { DoctorBusy } from "../src/doctor/busy";
import { memoryStateFile } from "./helpers/state-file";
import { fileMarkBook } from "../src/doctor/mark-book";
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
import type { ConfigLoad, DoctorEdge, DoctorStores } from "../src/doctor/edge";
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

// Where session s1 renders from (test/helpers/click.ts records its origin)
// and the Claude Code directory it runs with: the location its bar's settings
// chain is read at, the click's own.
const sessionAt = () => ({ projectDir: "/tmp/proj", claudeConfigDir: dir });

function buildRuntime(
  tmux: TmuxHint | null,
  load: LoadOutcome = CLEAN_LOAD,
  terminal: TerminalFixture = GHOSTTY,
  clicked: ReturnType<typeof memoryStateFile<readonly string[]>> = memoryStateFile<readonly string[]>([]),
  // The `client` hint the session's last render carried, as the daemon's
  // sightings hold it; none is a client too old to report one.
  client: { readonly hint?: ClientHint } = { hint: healthyClient() },
  // The daemon serving the bar, as it reports itself.
  serving: ServingDaemon = HEALTHY_SERVING,
) {
  const config = parseAndValidate(
    "<user>",
    `{ globals: {}, root: { h: ['directory', 'model'] } }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const sessionState = new SessionState();
  // What draw-bar.ts records on a render: the stamped hints, as JSON.
  sessionState.set(
    "s1",
    SESSION_CLIENT_HINTS_KEY,
    JSON.stringify({
      tmux,
      claudeConfigDir: dir,
      terminalEnv: terminal.env,
      termCols: 148,
    }),
  );
  const clients = new RenderSightings();
  clients.see("s1", renderSaid(client.hint, sessionAt()), instantOf(new Date()), 0);
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp/proj" });
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
    install: HEALTHY_INSTALL_EDGE,
    ...healthyDaemonEdge(),
    ...healthyDataEdge(),
    ...noManagedSettings(),
    probeTmux: () => {
      probes += 1;
      return {
        kind: "ok",
        value: {
          features: ["osc7", "RGB", "sixel"],
          termtype: "ghostty 1.3.1",
          termname: "xterm-ghostty",
          pid: 4242,
          utf8: true,
        },
      };
    },
    remoteLogin: () => {
      throw new Error("remoteLogin must not run in this case");
    },
    fontInUse: terminal.fontInUse,
    loadConfig: () => ({ ...load, config }),
  };
  const logs: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, undefined, config),
    doctor,
    doctorStores: { ...emptyStores(), clicked },
    clients,
    serving: () => serving,
    log: (level, message) => logs.push(level === "warn" ? `warn: ${message}` : message),
  };
  const click = async (url: string): Promise<void> => {
    const { verb, value } = parseHandlerUrl(url);
    const effects =
      verb === VERB_DISPATCH ? parseEffects(value) : [{ verb, value }];
    for (const e of effects) {
      const handler = VERBS.get(e.verb);
      if (!handler) throw new Error(`no handler for verb "${e.verb}"`);
      await handler(e.value, ctx);
    }
  };
  const clickWriting = async (key: string, value: string): Promise<void> => {
    const url = linkUrls(renderRaw()).find((u) =>
      effectsOf(u).some((e) => e.args[1] === key && e.args[2] === value),
    );
    if (!url) throw new Error(`no affordance writing ${key}=${value} rendered`);
    await click(url);
  };
  const urlOfVerb = (verb: string): string | undefined =>
    linkUrls(renderRaw()).find((u) =>
      effectsOf(u).some((e) => e.verb === verb),
    );
  const clickVerb = async (verb: string): Promise<void> => {
    const url = urlOfVerb(verb);
    if (!url) throw new Error(`no affordance with verb ${verb} rendered`);
    await click(url);
  };
  const openTools = async (): Promise<void> => {
    await clickWriting(SETTINGS_ANCHOR, SETTINGS_OPEN);
    await clickWriting(TAB_KEY, "tools");
  };
  return {
    sessionState,
    clients,
    settingsPath,
    render,
    click,
    clickVerb,
    urlOfVerb,
    openTools,
    logs,
    clicked,
    ctx,
    renderRaw,
    probes: () => probes,
  };
}

describe("🍫 › 🧰 tools › 🩺 doctor", () => {
  test("the tools tab holds the doctor button and no report until it runs", async () => {
    const rt = buildRuntime(HINT);
    expect(rt.render()).not.toContain("🩺 doctor");
    await rt.openTools();
    const out = rt.render();
    expect(out).toContain("▾ 🧰 tools");
    expect(out).toContain("🩺 doctor");
    expect(out).not.toMatch(/[✓✗] tmux truecolor/);
    expect(rt.urlOfVerb(VERB_DOCTOR_RUN)).toBeDefined();
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
  });

  test("the doctor's report rows are the body's own rows under the tools trigger", async () => {
    const rt = buildRuntime(HINT);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
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
    const reports = lines.slice(toolsRow + 2, toolsRow + 8);
    for (const report of reports) {
      expect(report.startsWith(`${POWERLINE.lead} `)).toBe(true);
    }
    expect(reports[0]).toContain("✓ config");
    expect(reports[1]).toContain("✓ install");
    expect(reports[2]).toContain("✓ daemon");
    expect(reports[3]).toContain("✓ URL handler");
    expect(reports[4]).toContain("✓ links");
    expect(reports[5]).toContain("✗ tmux truecolor");
  });

  // brandon-doctor-v62x.e91: the config check's row, and the run's log line
  // carrying each check's verdict and how many problems a failed one found.
  test("a config with problems: its row names the first and counts the rest, with no [fix]", async () => {
    const rt = buildRuntime(null, {
      ...CLEAN_LOAD,
      layers: ["/p/.cc-candybar.json5"],
      unused: [
        { kind: "variable", name: "v" },
        { kind: "action", name: "a" },
      ],
    });
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    const out = rt.render();
    expect(out).toContain(
      '✗ config — /p/.cc-candybar.json5 (searched): variable "v" is never read (+1 more — run `cc-candybar doctor`)',
    );
    expect(out).toContain("✓ tmux truecolor");
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
    expect(rt.logs.filter((line) => line.startsWith("doctor:"))).toEqual([
      `doctor: config=failed(2) install=ok daemon=ok urlHandler=ok links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=ok segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=ghostty@- font=- mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 postMortems=0/0 data=pr:-,rateLimits:- transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset (session=s1)`,
    ]);
  });

  // brandon-doctor-v62x.ryu: the 🩺 click is a link the terminal drew and the
  // user clicked, so the links row is ok in a terminal the CLI would fail —
  // and the click files its terminal, for the CLI to read.
  test("the links row is ok on a click, even in a terminal said to draw none, and the click is remembered", async () => {
    const rt = buildRuntime(null, CLEAN_LOAD, {
      env: { TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455.1" },
      fontInUse: GHOSTTY.fontInUse,
    });
    await rt.openTools();
    expect(rt.clicked.value()).toEqual([]);
    await rt.clickVerb(VERB_DOCTOR_RUN);
    const out = rt.render();
    expect(out).toContain("✓ links");
    expect(out).toContain("✗ Nerd Font — the doctor cannot read Terminal 455.1's font");
    expect(rt.clicked.value()).toEqual(["Terminal"]);
    expect(rt.logs.filter((line) => line.startsWith("doctor:"))).toEqual([
      `doctor: config=ok install=ok daemon=ok urlHandler=ok links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=failed(1) segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=apple-terminal@455.1 font=- mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 postMortems=0/0 data=pr:-,rateLimits:- transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset (session=s1)`,
    ]);
  });

  // brandon-doctor-v62x.1z2: the width is what the session's latest render
  // said — the record `cc-candybar doctor` reads too — not the persisted hints.
  test("the width row reads the session's latest render", async () => {
    const rt = buildRuntime(null);
    rt.clients.see("s1", { ...renderSaid(healthyClient(), sessionAt()), termCols: 97 }, instantOf(new Date()), 1);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.logs.at(-1)).toMatch(/ termWidth=ok .* cols=97 widthOf=session /);
    expect(rt.render()).toContain("✓ terminal width");
  });

  test("a post-mortem the user has not read fails the daemon row, and [fix] files it read", async () => {
    const report = "/state/cc-candybar/memory-2026-10-19T18-01-12-345Z-77.txt";
    const rt = buildRuntime(null, CLEAN_LOAD, GHOSTTY, memoryStateFile<readonly string[]>([]), { hint: healthyClient() }, {
      ...HEALTHY_SERVING,
      postMortems: {
        kind: "ok",
        value: [{ identity: "2026-10-19T18-01-12-345Z-77", artifacts: { memoryReport: report } }],
      },
    });
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    const failed = rt.render();
    expect(failed).toContain("✗ daemon");
    expect(failed).toContain(`ran out of memory and restarted (2026-10-19T18-01-12-345Z-77) — post-mortem: ${report}`);
    expect(rt.logs.at(-1)).toMatch(/ daemon=failed\(1\) .* daemons=1 others=- memory=phys_footprint:120\/512 postMortems=1\/1 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset \(session=s1\)$/);
    await rt.clickVerb(VERB_DOCTOR_FIX);
    expect(rt.logs).toContain(
      "doctor-fix: daemon → post-mortems-read through=2026-10-19T18-01-12-345Z-77 (session=s1)",
    );
    expect(rt.render()).toContain("✓ daemon");
    expect(rt.logs.at(-1)).toMatch(/ daemon=ok .* postMortems=0\/1 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset \(session=s1\)$/);
  });

  // brandon-doctor-v62x.tfb: the click judges the client that drew the bar
  // it came from — one too old to say what it is is the install's failure.
  test("a bar drawn by a client too old to say what it is fails the install row", async () => {
    const rt = buildRuntime(null, CLEAN_LOAD, GHOSTTY, memoryStateFile<readonly string[]>([]), {});
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain(
      "✗ install — the bar is drawn by a statusline client too old to say what it is",
    );
    expect(rt.logs.find((line) => line.startsWith("doctor:"))).toMatch(
      / install=failed\(1\) .* clients=unreported\/-\/- daemons=1 others=- memory=phys_footprint:120\/512 postMortems=0\/0 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset \(session=s1\)$/,
    );
  });

  // Filing the click rides along with the run: a list that cannot be written
  // is logged, and the doctor still reports.
  test("a clicked-terminals list that cannot be written does not stop the run, and says so in the log", async () => {
    const unwritable = {
      ...memoryStateFile<readonly string[]>([]),
      update: () => {
        throw new Error("EROFS: read-only file system");
      },
    };
    const rt = buildRuntime(null, CLEAN_LOAD, GHOSTTY, unwritable);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain("✓ links");
    expect(rt.logs).toContain(
      'warn: doctor: clicked terminal not filed for "Ghostty": EROFS: read-only file system',
    );
    expect(rt.logs.find((line) => line.startsWith("doctor:"))).toMatch(/ clicked=no cols=148 widthOf=session clientUtf8=- clients=native\/same\/- daemons=1 others=- memory=phys_footprint:120\/512 postMortems=0\/0 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset \(session=s1\)$/);
  });

  test("in tmux with RGB and the var unset: failed row with [fix]; the fix lands and the row says restart", async () => {
    const rt = buildRuntime(HINT);
    fs.writeFileSync(
      rt.settingsPath,
      `{\n  "env": { "FORCE_COLOR": "3" },\n  "model": "opus"\n}\n`,
    );
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    const failed = rt.render();
    expect(failed).toContain(
      "✗ tmux truecolor — Claude Code renders the bar in 256 colours inside tmux [fix]",
    );

    await rt.clickVerb(VERB_DOCTOR_FIX);
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
  test("a doctor-run click for a session that never rendered is refused", async () => {
    const rt = buildRuntime(HINT);
    const url = `cc-candybar://${VERB_DOCTOR_RUN}/never-rendered`;
    await expect(rt.click(url)).rejects.toThrow(BadVerbArgs);
    await expect(rt.click(url)).rejects.toThrow(/never-rendered has not rendered yet/);
  });

  // [LAW:no-silent-failure] A stale `[fix]` URL (the world moved since the
  // render that drew it) is refused loudly, never a silent second write.
  test("a second fix click is refused: nothing left to fix", async () => {
    const rt = buildRuntime(HINT);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    const fixUrl = rt.urlOfVerb(VERB_DOCTOR_FIX)!;
    await rt.clickVerb(VERB_DOCTOR_FIX);
    const before = fs.readFileSync(rt.settingsPath, "utf8");
    await expect(rt.click(fixUrl)).rejects.toThrow(BadVerbArgs);
    expect(fs.readFileSync(rt.settingsPath, "utf8")).toBe(before);
  });

  // brandon-effects-2gka.21e, brandon-doctor-v62x.tgp: the session's bar drew
  // a moving frame under a statusLine with no interval — the row fails with
  // [fix], and the fix lands the interval beside the statusLine's keys.
  test("a session whose bar moves, no refresh interval: failed row with [fix]; the fix lands and the row passes", async () => {
    const rt = buildRuntime(null);
    fs.writeFileSync(
      rt.settingsPath,
      `{\n  "statusLine": { "type": "command", "command": "cc-candybar" }\n}\n`,
    );
    rt.clients.see(
      "s1",
      { ...renderSaid(healthyClient(), sessionAt()), frame: "moves" },
      instantOf(new Date()),
      1,
    );
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain(
      `✗ effect refresh — the bar moves (an effect, a fade, an animated segment, or an open menu counting down to its close), but its statusLine sets no refreshInterval, so Claude Code redraws it only on events (statusLine from ${rt.settingsPath}) [fix]`,
    );

    // The event names the scope the statusLine was read from.
    expect(rt.logs.find((line) => line.startsWith("doctor:"))).toMatch(
      / frames=1\/0\/0\/0\/0 chains=user:- truecolorEnv=unset \(session=s1\)$/,
    );

    await rt.clickVerb(VERB_DOCTOR_FIX);
    expect(JSON.parse(fs.readFileSync(rt.settingsPath, "utf8"))).toEqual({
      statusLine: { type: "command", command: "cc-candybar", refreshInterval: 1 },
    });
    // A pass names the file the interval is set in.
    expect(rt.render()).toContain(
      `✓ effect refresh — statusLine.refreshInterval is 1 in ${rt.settingsPath}`,
    );
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
    expect(rt.logs).toContain(
      `doctor-fix: effectRefresh → claude-settings statusLine.refreshInterval=1 file=${JSON.stringify(rt.settingsPath)} scope=user (session=s1)`,
    );
  });

  test("not in tmux: the check is ok", async () => {
    const rt = buildRuntime(null);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
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

    test("a font without the glyphs: the row names it, shows the glyphs, and offers ✓ and ✗", async () => {
      const rt = buildRuntime(null, CLEAN_LOAD, ITERM_MENLO);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      const out = rt.render();
      expect(out).toContain(
        `✗ Nerd Font — iTerm2 3.7.2 draws with Menlo-Regular (iTerm2 profile "Default"), which has no ${BUNDLED_GLYPHS_NAMED}`,
      );
      expect(out).toContain(`${BUNDLED_GLYPHS} [✓ shapes] [✗ boxes]`);
      // The font edge was asked about exactly the glyphs the bar draws.
      expect(fontCalls).toEqual([
        [{ name: "iterm2", version: "3.7.2" }, ITERM_MENLO.env, BUNDLED_GLYPHS],
      ]);
      expect(rt.logs.filter((l) => l.startsWith("doctor:"))).toEqual([
        `doctor: config=ok install=ok daemon=ok urlHandler=ok links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=failed(1) segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=iterm2@3.7.2 font="Menlo-Regular":lacks${[...BUNDLED_GLYPHS].length} mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 postMortems=0/0 data=pr:-,rateLimits:- transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset (session=s1)`,
      ]);
    });

    test("marking ✓ records the mark on this sighting and the row is ok", async () => {
      const rt = buildRuntime(null, CLEAN_LOAD, ITERM_MENLO);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      fontCalls.length = 0;
      await rt.click(markUrl(rt, "drawn")!);
      // One gathering per click: the rate-limited font spawn runs once.
      expect(fontCalls).toHaveLength(1);
      const out = rt.render();
      expect(out).toContain("✓ Nerd Font");
      expect(out).not.toContain("[✓ shapes]");
      expect(rt.logs).toContain(
        `doctor-mark: nerdFont drawn on iTerm2 with Menlo-Regular (iTerm2 profile "Default")|${BUNDLED_GLYPHS_NAMED} (session=s1)`,
      );
      expect(rt.logs.at(-1)).toMatch(/nerdFont=ok .* mark=drawn tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native\/same\/- daemons=1 others=- memory=phys_footprint:120\/512 postMortems=0\/0 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset \(session=s1\)$/);
    });

    test("marking ✗ keeps the row failed, says boxes, and leaves ✓ to mark later", async () => {
      const rt = buildRuntime(null, CLEAN_LOAD, ITERM_MENLO);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      await rt.click(markUrl(rt, "boxes")!);
      const out = rt.render();
      expect(out).toContain(`✗ Nerd Font — iTerm2 3.7.2 draws ${BUNDLED_GLYPHS_NAMED} as boxes`);
      expect(markUrl(rt, "drawn")).toBeDefined();
    });

    test("a mark on a check with nothing to look at is refused", async () => {
      const rt = buildRuntime(null);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      expect(rt.render()).toContain("✓ Nerd Font");
      expect(markUrl(rt, "drawn")).toBeUndefined();
      await expect(VERBS.get(VERB_DOCTOR_MARK)!("s1/nerdFont/drawn", rt.ctx),
      ).rejects.toThrow(BadVerbArgs);
      await expect(VERBS.get(VERB_DOCTOR_MARK)!("s1/nerdFont/perhaps", rt.ctx),
      ).rejects.toThrow(/the mark is "perhaps"/);
    });

    test("a mark book that stops reading before the mark is filed refuses the click and keeps the file", async () => {
      const rt = buildRuntime(null, CLEAN_LOAD, ITERM_MENLO);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-marks-"));
      try {
        const file = path.join(dir, "doctor-marks.json");
        fs.writeFileSync(file, "junk");
        // The book read when the click gathered its facts, and the file broke
        // before the filing: the real store's refusal is the click's.
        const marks: DoctorStores["marks"] = {
          read: () => ({ kind: "ok", value: {} }),
          update: fileMarkBook(dir).update,
        };
        const ctx = { ...rt.ctx, doctorStores: { ...rt.ctx.doctorStores, marks } };
        const mark = async () => await VERBS.get(VERB_DOCTOR_MARK)!("s1/nerdFont/drawn", ctx);
        await expect(mark).rejects.toThrow(BadVerbArgs);
        await expect(mark).rejects.toThrow(
          `doctor-mark: ${file} is not JSON`,
        );
        expect(fs.readFileSync(file, "utf8")).toBe("junk");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a probe the rate limit refused refuses the click, and the report stands", async () => {
      const busy: TerminalFixture = {
        ...ITERM_MENLO,
        fontInUse: () => {
          throw new DoctorBusy("the font");
        },
      };
      const rt = buildRuntime(null, CLEAN_LOAD, busy);
      await rt.openTools();
      await expect(VERBS.get(VERB_DOCTOR_RUN)!("s1", rt.ctx)).rejects.toThrow(
        new BadVerbArgs("the doctor looked at the font less than a second ago — click again"),
      );
      expect(rt.render()).not.toContain("Nerd Font");
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

  test("closing 🍫 hides the tools body even when it was left open", async () => {
    const rt = buildRuntime(HINT);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain("tmux truecolor");
    rt.sessionState.set("s1", SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
    const closed = rt.render();
    expect(closed).not.toContain("🩺 doctor");
    expect(closed).not.toContain("tmux truecolor");
  });
});
