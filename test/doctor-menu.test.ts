// [LAW:verifiable-goals] brandon-doctor-b6a: the `🍫 › 🧰 tools › 🩺 doctor`
// route, driven through the real loader, the real spine (registerDslConfig +
// drawDsl), and the real verb handlers — with a fake DoctorEdge whose tmux
// probe answers `RGB`, and a settings.json in a temp Claude Code directory the
// session's `claudeConfigDir` hint names. A click asks the host for its run's
// reading; the rig's host reads it with the daemon's own read once the click's
// turn ends, and hands it back as the session's world state carries it.

import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { linkUrls } from "./helpers/frame";
import { RenderSightings } from "../src/daemon/render-sightings";
import { DoctorHost } from "./helpers/doctor-gather";
import { lastClickError } from "../src/daemon/foundations/click-error";
import { systemTimekeeper } from "../src/time";
import type { PostMortem } from "../src/daemon/foundations/memory-limit";
import type { Asked } from "../src/doctor/checks";
import { daemonSighted } from "../src/daemon/cache/doctor";
import { readDoctorNote } from "../src/renderer-interface/noted-doctor";
import { valueOf, type Field } from "../src/utils/logfmt";
import {
  emptyStores,
  healthyDaemonEdge,
  healthyDataEdge,
  noManagedSettings,
  noUrlHandlerEdge,
  HEALTHY_SERVING,
  HEALTHY_INSTALL_EDGE,
  HEALTHY_BUNDLE,
  healthyClient,
  renderSaid,
} from "./helpers/doctor-facts";
import type { ClientHint } from "../src/client-hint";
import {
  BUNDLED_GLYPHS,
  BUNDLED_GLYPHS_LOGGED,
  BUNDLED_GLYPHS_NAMED,
} from "./helpers/bundled-glyphs";
import { busy } from "../src/doctor/busy";
import { memoryStateFile } from "./helpers/state-file";
import { fileMarkBook } from "../src/doctor/mark-book";
import fs from "node:fs";
import { POWERLINE } from "./helpers/powerline";
import os from "node:os";
import path from "node:path";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SETTINGS_ANCHOR, SETTINGS_OPEN } from "../src/config/settings-menu";
import { SETTINGS_NS } from "../src/config/reserved-names";

import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSE,
} from "../src/config/disclosure";
import {
  clickUrl,
  effectsOf,
  landsSettingsOf,
  verbContextWith,
  withDoctor,
  bookedContext,
  hearRender,
  heardRequest,
} from "./helpers/click";
import { buildRig } from "./helpers/rig";
import {
  VERB_DOCTOR_FIX,
  VERB_DOCTOR_MARK,
  VERB_DOCTOR_RUN,
} from "../src/click/wire";
import { VERBS, BadVerbArgs } from "../src/renderer/verbs";
import type { VerbContext } from "../src/renderer/verbs";
import { TMUX_TRUECOLOR_VAR } from "../src/doctor/checks";
import type { ConfigLoad, DoctorEdge, DoctorStores } from "../src/doctor/ports";
import type { TmuxHint } from "../src/tmux-hint";
import type { TerminalEnvHint } from "../src/terminal-hint";
import { instantOf, type Instant } from "../src/utils/instant";

import { sessionIdOf } from "../src/daemon/foundations/session-id";

const S1 = sessionIdOf("s1");

const ALLOWED = new Set(listResolvablePaletteNames());
const TAB_KEY = `${SETTINGS_NS}tab`;

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
  fontInUse: async () => {
    throw new Error("fontInUse must not run in this case");
  },
};

// Where session s1 renders from (test/helpers/click.ts records its origin)
// and the Claude Code directory it runs with: the location its bar's settings
// chain is read at, the click's own.
const sessionAt = () => ({ projectDir: "/tmp/proj", claudeConfigDir: dir });

// Each report the record notes, as one line: its verdicts by check, then
// every field the run reasoned over that follows its note.
function reportedOn(record: readonly Field[]): string[] {
  const lines: string[] = [];
  for (const [key, value] of record) {
    if (key === "doctor") {
      const verdicts = readDoctorNote(value).map(
        ({ name, verdict }) =>
          `${name}=${verdict.ok ? "ok" : `failed(${1 + verdict.more.length})`}`,
      );
      lines.push(`doctor: ${verdicts.join(" ")}`);
    } else if (lines.length > 0)
      lines[lines.length - 1] += ` ${key}=${valueOf(value)}`;
  }
  return lines;
}

function doctorBar(
  tmux: TmuxHint | null,
  load: LoadOutcome = CLEAN_LOAD,
  terminal: TerminalFixture = GHOSTTY,
  clicked: ReturnType<
    typeof memoryStateFile<readonly string[]>
  > = memoryStateFile<readonly string[]>([]),
  // The `client` hint the session's last render carried, as the daemon's
  // sightings hold it; none is a client too old to report one.
  client: { readonly hint?: ClientHint } = { hint: healthyClient() },
  // The post-mortems the daemons' breaches left in the state directory.
  postMortems: Asked<readonly PostMortem[]> = { kind: "ok", value: [] },
) {
  const rig = buildRig({
    source: `{ globals: {}, root: { h: ['directory', 'model'] } }`,
    label: "<user>",
    base: DEFAULT_DSL_CONFIG,
  });
  const { config, sessionState } = rig;
  // The hints the session's client sends, as the host hands them to the
  // doctor's read; recorded too, as draw-bar.ts records them, for the click's
  // own reads.
  const hints = {
    tmux,
    claudeConfigDir: dir,
    terminalEnv: terminal.env,
    termCols: 148,
  };
  hearRender(
    sessionState,
    heardRequest(
      S1,
      bookedContext(sessionState, S1)!.durable.origin.cwd,
      hints,
    ),
  );
  const clients = new RenderSightings();
  clients.see(
    S1,
    renderSaid(client.hint, sessionAt()),
    instantOf(new Date()),
    0,
  );
  const renderRaw = (): Frame => rig.draw({ payload: PAYLOAD }).frame;
  const render = (): string => textOf(renderRaw());
  const settingsPath = path.join(dir, "settings.json");
  let probes = 0;
  const doctor: DoctorEdge = {
    ...healthyDaemonEdge(),
    ...healthyDataEdge(),
    ...noManagedSettings(),
    ...noUrlHandlerEdge(),
    postMortems: () => postMortems,
    probeTmux: async () => {
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
    remoteLogin: async () => {
      throw new Error("remoteLogin must not run in this case");
    },
    fontInUse: terminal.fontInUse,
  };
  const host = new DoctorHost(
    {
      edge: { ...doctor, install: HEALTHY_INSTALL_EDGE },
      sighted: (session, now) =>
        daemonSighted(
          session,
          clients.ofSession(session, now),
          HEALTHY_SERVING,
          HEALTHY_BUNDLE,
        ),
      clock: systemTimekeeper,
    },
    (session) => {
      const { live, durable } = bookedContext(sessionState, session)!;
      return { hints: live!.hints, origin: durable.origin };
    },
  );
  const logs: string[] = [];
  // [LAW:one-source-of-truth] A click's turn and a reading's turn note their
  // reports on one record here, in the order the turns ran.
  const ctx: VerbContext = withDoctor(
    verbContextWith(rig.ctx, {
      log: (level, message) =>
        logs.push(level === "warn" ? `warn: ${message}` : message),
      record: host.taken,
    }),
    { stores: { ...emptyStores(), clicked }, load: { ...load, config } },
  );
  landsSettingsOf(ctx, (session) => host.writable(session));
  // A click, then the end of its turn at the host: what the turn's
  // subscriptions ask of the doctor is read and handed back.
  const click = async (url: string): Promise<void> => {
    try {
      await clickUrl(url, ctx);
    } finally {
      await host.settle(ctx.doctorRuns);
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
    reported: () => reportedOn(host.taken),
    clicked,
    ctx,
    renderRaw,
    probes: () => probes,
  };
}

describe("🍫 › 🧰 tools › 🩺 doctor", () => {
  test("the tools tab holds the doctor button and no report until it runs", async () => {
    const rt = doctorBar(HINT);
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
    const rt = doctorBar(HINT);
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
    expect(
      lines[toolsRow + 1]!.startsWith(POWERLINE.lead + DISCLOSURE_GLYPH_CLOSE),
    ).toBe(true);
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
    const rt = doctorBar(null, {
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
    expect(rt.reported()).toEqual([
      `doctor: config=failed(2) install=ok daemon=ok urlHandler=ok links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=ok segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=ghostty@- font=- mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 processes=host:4100:160 postMortems=0/0 data=pr:-,rateLimits:- transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset`,
    ]);
  });

  // brandon-doctor-v62x.ryu: the 🩺 click is a link the terminal drew and the
  // user clicked, so the links row is ok in a terminal the CLI would fail —
  // and the click files its terminal, for the CLI to read.
  test("the links row is ok on a click, even in a terminal said to draw none, and the click is remembered", async () => {
    const rt = doctorBar(null, CLEAN_LOAD, {
      env: { TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455.1" },
      fontInUse: GHOSTTY.fontInUse,
    });
    await rt.openTools();
    expect(rt.clicked.value()).toEqual([]);
    await rt.clickVerb(VERB_DOCTOR_RUN);
    const out = rt.render();
    expect(out).toContain("✓ links");
    expect(out).toContain(
      "✗ Nerd Font — the doctor cannot read Terminal 455.1's font",
    );
    expect(rt.clicked.value()).toEqual(["Terminal"]);
    expect(rt.reported()).toEqual([
      `doctor: config=ok install=ok daemon=ok urlHandler=ok links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=failed(1) segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=apple-terminal@455.1 font=- mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 processes=host:4100:160 postMortems=0/0 data=pr:-,rateLimits:- transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset`,
    ]);
  });

  // brandon-doctor-v62x.1z2: the width is what the session's latest render
  // said — the record `cc-candybar doctor` reads too — not the persisted hints.
  test("the width row reads the session's latest render", async () => {
    const rt = doctorBar(null);
    rt.clients.see(
      S1,
      { ...renderSaid(healthyClient(), sessionAt()), termCols: 97 },
      instantOf(new Date()),
      1,
    );
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.reported().at(-1)).toMatch(/ termWidth=ok .* cols=97 widthOf=session /);
    expect(rt.render()).toContain("✓ terminal width");
  });

  test("a post-mortem the user has not read fails the daemon row, and [fix] files it read", async () => {
    const report = "/state/cc-candybar/memory-2026-10-19T18-01-12-345Z-77.txt";
    const rt = doctorBar(
      null,
      CLEAN_LOAD,
      GHOSTTY,
      memoryStateFile<readonly string[]>([]),
      { hint: healthyClient() },
      {
        kind: "ok",
        value: [
          {
            identity: "2026-10-19T18-01-12-345Z-77",
            artifacts: { memoryReport: report },
          },
        ],
      },
    );
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    const failed = rt.render();
    expect(failed).toContain("✗ daemon");
    expect(failed).toContain(
      `ran out of memory and restarted (2026-10-19T18-01-12-345Z-77) — post-mortem: ${report}`,
    );
    expect(rt.reported().at(-1)).toMatch(
      / daemon=failed\(1\) .* daemons=1 others=- memory=phys_footprint:120\/512 processes=host:4100:160 postMortems=1\/1 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset$/,
    );
    await rt.clickVerb(VERB_DOCTOR_FIX);
    expect(rt.logs).toContain(
      "doctor-fix: daemon → post-mortems-read through=2026-10-19T18-01-12-345Z-77 (session=s1)",
    );
    expect(rt.render()).toContain("✓ daemon");
    expect(rt.reported().at(-1)).toMatch(
      / daemon=ok .* postMortems=0\/1 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset$/,
    );
  });

  // brandon-doctor-v62x.tfb: the click judges the client that drew the bar
  // it came from — one too old to say what it is is the install's failure.
  test("a bar drawn by a client too old to say what it is fails the install row", async () => {
    const rt = doctorBar(
      null,
      CLEAN_LOAD,
      GHOSTTY,
      memoryStateFile<readonly string[]>([]),
      {},
    );
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain(
      "✗ install — the bar is drawn by a statusline client too old to say what it is",
    );
    expect(rt.reported().at(-1)).toMatch(
      / install=failed\(1\) .* clients=unreported\/-\/- daemons=1 others=- memory=phys_footprint:120\/512 processes=host:4100:160 postMortems=0\/0 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset$/,
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
    const rt = doctorBar(null, CLEAN_LOAD, GHOSTTY, unwritable);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain("✓ links");
    expect(rt.logs).toContain(
      'warn: doctor: clicked terminal not filed for "Ghostty": EROFS: read-only file system',
    );
    expect(rt.reported().at(-1)).toMatch(
      / clicked=no cols=148 widthOf=session clientUtf8=- clients=native\/same\/- daemons=1 others=- memory=phys_footprint:120\/512 processes=host:4100:160 postMortems=0\/0 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset$/,
    );
  });

  test("in tmux with RGB and the var unset: failed row with [fix]; the fix lands and the row says restart", async () => {
    const rt = doctorBar(HINT);
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
    // one probe for the run click, one for the run the fix starts, which
    // reads the row again after the change landed
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
  // A run that replaces a report takes its rows off the bar: no verdict or
  // [fix] stands for a run no longer the session's while the next is read.
  test("a doctor-run click takes the last report's rows off the bar until its own reading lands", async () => {
    const rt = doctorBar(HINT);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    const run = rt.urlOfVerb(VERB_DOCTOR_RUN)!;
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeDefined();
    await clickUrl(run, rt.ctx);
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeUndefined();
    // A second click while the run is on its way asks no other.
    const asked = rt.ctx.doctorRuns.subscriptions().get(S1);
    await clickUrl(run, rt.ctx);
    expect(rt.ctx.doctorRuns.subscriptions().get(S1)).toEqual(asked);
    await rt.click(run);
    expect(rt.urlOfVerb(VERB_DOCTOR_FIX)).toBeDefined();
  });

  test("a doctor-run click for a session that never rendered is refused", async () => {
    const rt = doctorBar(HINT);
    const url = `cc-candybar://${VERB_DOCTOR_RUN}/never-rendered`;
    await expect(rt.click(url)).rejects.toThrow(BadVerbArgs);
    await expect(rt.click(url)).rejects.toThrow(
      /never-rendered has not rendered yet/,
    );
  });

  // [LAW:no-silent-failure] A stale `[fix]` URL (the world moved since the
  // render that drew it) is refused loudly, never a silent second write.
  test("a second fix click is refused: nothing left to fix", async () => {
    const rt = doctorBar(HINT);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    const fixUrl = rt.urlOfVerb(VERB_DOCTOR_FIX)!;
    await rt.clickVerb(VERB_DOCTOR_FIX);
    const before = fs.readFileSync(rt.settingsPath, "utf8");
    await expect(rt.click(fixUrl)).rejects.toThrow(BadVerbArgs);
    expect(fs.readFileSync(rt.settingsPath, "utf8")).toBe(before);
  });

  // [LAW:single-enforcer] docs/design/host-and-renderer.md §7, A-3: a fix
  // applies only to the settings it diagnosed. A setting moved between the
  // diagnosis and the fix refuses the fix, writes nothing, says why on the
  // bar, and the row is read again over the settings as they now are.
  test("a setting changed between the diagnosis and the fix refuses the fix, and the row is read again", async () => {
    const rt = doctorBar(HINT);
    fs.writeFileSync(
      rt.settingsPath,
      `{\n  "env": { "FORCE_COLOR": "3" }\n}\n`,
    );
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain("✗ tmux truecolor");
    const fixUrl = rt.urlOfVerb(VERB_DOCTOR_FIX)!;
    // The user sets the variable themselves, to 0, after the doctor read it
    // unset.
    const moved = `{\n  "env": { "FORCE_COLOR": "3", "${TMUX_TRUECOLOR_VAR}": "0" }\n}\n`;
    fs.writeFileSync(rt.settingsPath, moved);
    await rt.click(fixUrl);
    expect(fs.readFileSync(rt.settingsPath, "utf8")).toBe(moved);
    expect(lastClickError(rt.sessionState, S1)?.text).toContain(
      `env.${TMUX_TRUECOLOR_VAR} in ${rt.settingsPath} changed since it was read`,
    );
    expect(rt.probes()).toBe(2);
    // The run the fix started read the variable as the user set it.
    expect(rt.reported().at(-1)).toMatch(/ truecolorEnv="user:\\"0\\""$/);
  });

  // brandon-effects-2gka.21e, brandon-doctor-v62x.tgp: the session's bar drew
  // a moving frame under a statusLine with no interval — the row fails with
  // [fix], and the fix lands the interval beside the statusLine's keys.
  test("a session whose bar moves, no refresh interval: failed row with [fix]; the fix lands and the row passes", async () => {
    const rt = doctorBar(null);
    fs.writeFileSync(
      rt.settingsPath,
      `{\n  "statusLine": { "type": "command", "command": "cc-candybar" }\n}\n`,
    );
    rt.clients.see(
      S1,
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
    expect(rt.reported().at(-1)).toMatch(
      / frames=1\/0\/0\/0\/0 chains=user:- truecolorEnv=unset$/,
    );

    await rt.clickVerb(VERB_DOCTOR_FIX);
    expect(JSON.parse(fs.readFileSync(rt.settingsPath, "utf8"))).toEqual({
      statusLine: {
        type: "command",
        command: "cc-candybar",
        refreshInterval: 1,
      },
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
    const rt = doctorBar(null);
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
      fontInUse: async (...args) => {
        fontCalls.push(args);
        return {
          kind: "ok",
          value: {
            font: "Menlo-Regular",
            from: 'iTerm2 profile "Default"',
            lacks: [...args[2]],
          },
        };
      },
    };
    beforeEach(() => {
      fontCalls.length = 0;
    });

    const markUrl = (rt: ReturnType<typeof doctorBar>, mark: string) =>
      rt.urlOfVerb(VERB_DOCTOR_MARK) === undefined
        ? undefined
        : linkUrls(rt.renderRaw()).find((u) =>
            effectsOf(u).some(
              (e) => e.verb === VERB_DOCTOR_MARK && e.args[2] === mark,
            ),
          );

    test("a font without the glyphs: the row names it, shows the glyphs, and offers ✓ and ✗", async () => {
      const rt = doctorBar(null, CLEAN_LOAD, ITERM_MENLO);
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
      expect(rt.reported()).toEqual([
        `doctor: config=ok install=ok daemon=ok urlHandler=ok links=ok tmuxTruecolor=ok utf8=ok termWidth=ok effectRefresh=ok nerdFont=failed(1) segmentData=ok sessionData=ok configTarget=search glyphs=${BUNDLED_GLYPHS_LOGGED} terminal=iterm2@3.7.2 font=Menlo-Regular:lacks${[...BUNDLED_GLYPHS].length} mark=- tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native/same/- daemons=1 others=- memory=phys_footprint:120/512 processes=host:4100:160 postMortems=0/0 data=pr:-,rateLimits:- transcripts=1/0/0 unparsed=0 frames=0/0/1/0/0 chains=absent truecolorEnv=unset`,
      ]);
    });

    test("marking ✓ records the mark on this sighting and the row is ok", async () => {
      const rt = doctorBar(null, CLEAN_LOAD, ITERM_MENLO);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      fontCalls.length = 0;
      await rt.click(markUrl(rt, "drawn")!);
      // A mark judges the run's reading: the font is not read again.
      expect(fontCalls).toEqual([]);
      const out = rt.render();
      expect(out).toContain("✓ Nerd Font");
      expect(out).not.toContain("[✓ shapes]");
      expect(rt.logs).toContain(
        `doctor-mark: nerdFont drawn on iTerm2 with Menlo-Regular (iTerm2 profile "Default")|${BUNDLED_GLYPHS_NAMED} (session=s1)`,
      );
      expect(rt.reported().at(-1)).toMatch(
        /nerdFont=ok .* mark=drawn tmuxLinks=- clicked=yes cols=148 widthOf=session clientUtf8=- clients=native\/same\/- daemons=1 others=- memory=phys_footprint:120\/512 processes=host:4100:160 postMortems=0\/0 data=\S+ transcripts=1\/0\/0 unparsed=0 frames=0\/0\/1\/0\/0 chains=absent truecolorEnv=unset$/,
      );
    });

    // A reading names the terminal that drew the bar when it was read, and a
    // mark is filed under that terminal for good: a report read long enough
    // ago that the session may have moved is read again before it is marked.
    test("a mark on a report read two minutes ago is refused, and the report is read again", async () => {
      const rt = doctorBar(null, CLEAN_LOAD, ITERM_MENLO);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      const url = markUrl(rt, "drawn")!;
      fontCalls.length = 0;
      const later = instantOf(new Date(Date.now() + 121_000));
      (rt.ctx as { now: () => Instant }).now = () => later;
      await expect(rt.click(url)).rejects.toThrow(/being read/);
      expect(fontCalls).toHaveLength(1);
      expect(rt.render()).toContain(`${BUNDLED_GLYPHS} [✓ shapes] [✗ boxes]`);
      expect(rt.logs.some((l) => l.startsWith("doctor-mark:"))).toBe(false);
    });

    test("marking ✗ keeps the row failed, says boxes, and leaves ✓ to mark later", async () => {
      const rt = doctorBar(null, CLEAN_LOAD, ITERM_MENLO);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      await rt.click(markUrl(rt, "boxes")!);
      const out = rt.render();
      expect(out).toContain(
        `✗ Nerd Font — iTerm2 3.7.2 draws ${BUNDLED_GLYPHS_NAMED} as boxes`,
      );
      expect(markUrl(rt, "drawn")).toBeDefined();
    });

    test("a mark on a check with nothing to look at is refused", async () => {
      const rt = doctorBar(null);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      expect(rt.render()).toContain("✓ Nerd Font");
      expect(markUrl(rt, "drawn")).toBeUndefined();
      expect(() =>
        VERBS.get(VERB_DOCTOR_MARK)!("s1/nerdFont/drawn", rt.ctx),
      ).toThrow(BadVerbArgs);
      expect(() =>
        VERBS.get(VERB_DOCTOR_MARK)!("s1/nerdFont/perhaps", rt.ctx),
      ).toThrow(/the mark is "perhaps"/);
    });

    test("a mark book that stops reading before the mark is filed refuses the click and keeps the file", async () => {
      const rt = doctorBar(null, CLEAN_LOAD, ITERM_MENLO);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-marks-"));
      try {
        const file = path.join(dir, "doctor-marks.json");
        fs.writeFileSync(file, "junk");
        // The book read when the run's report was written, and the file broke
        // before the filing: the real store's refusal is the click's.
        const marks: DoctorStores["marks"] = {
          read: () => ({ kind: "ok", value: {} }),
          update: fileMarkBook(dir).update,
          plan: fileMarkBook(dir).plan,
        };
        const ctx = {
          ...rt.ctx,
          doctorStores: { ...rt.ctx.doctorStores, marks },
        };
        const mark = async () =>
          await VERBS.get(VERB_DOCTOR_MARK)!("s1/nerdFont/drawn", ctx);
        await expect(mark).rejects.toThrow(BadVerbArgs);
        await expect(mark).rejects.toThrow(`doctor-mark: ${file} is not JSON`);
        expect(fs.readFileSync(file, "utf8")).toBe("junk");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a probe the rate limit refused fails the run with the reason on the bar, and writes no report", async () => {
      const limited: TerminalFixture = {
        ...ITERM_MENLO,
        fontInUse: async () => busy("the font"),
      };
      const rt = doctorBar(null, CLEAN_LOAD, limited);
      await rt.openTools();
      await rt.clickVerb(VERB_DOCTOR_RUN);
      expect(lastClickError(rt.sessionState, S1)?.text).toBe(
        "doctor: the doctor looked at the font less than a second ago — click again",
      );
      expect(rt.render()).not.toContain("Nerd Font");
      expect(rt.reported()).toEqual([]);
    });

    test("only a check that takes a mark is given the actions that make one", async () => {
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
    const rt = doctorBar(HINT);
    await rt.openTools();
    await rt.clickVerb(VERB_DOCTOR_RUN);
    expect(rt.render()).toContain("tmux truecolor");
    rt.sessionState.set(S1, SETTINGS_ANCHOR, DISCLOSURE_CLOSED);
    const closed = rt.render();
    expect(closed).not.toContain("🩺 doctor");
    expect(closed).not.toContain("tmux truecolor");
  });
});
