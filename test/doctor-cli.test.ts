// [LAW:verifiable-goals] `cc-candybar doctor`'s contract, read off the plan
// the argv binding performs: the exit code and the streams for an unreadable
// settings file, a clean setup, and a failed check carrying a fix.

import { BUNDLED_GLYPHS } from "./helpers/bundled-glyphs";
import { EMPTY_STORES, healthyDaemonEdge, healthyDataEdge, noManagedSettings, HEALTHY_SERVING, HEALTHY_INSTALL_EDGE, healthyDaemonIn, HEALTHY_FACTS, CARRIED, NAMED, STILL, sightedIn, reportedFrame } from "./helpers/doctor-facts";
import { glyphSighting } from "../src/doctor/checks";
import { withMark } from "../src/doctor/mark-book";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctorPlan, loadConfigOnce, parseDoctorArgs } from "../src/doctor/cli";
import { doctorReportKeys, doctorReportPairs } from "../src/doctor/report";
import { runDoctor } from "../src/doctor/checks";
import { gatherFacts } from "../src/doctor/edge";
import { ownProject } from "../src/doctor/sightings";
import { DOOR_GLYPH } from "../src/config/disclosure";
import type { DoctorEdge, StoresRead } from "../src/doctor/edge";
import type { HandlerProbeEdge } from "../src/doctor/handler-probe";
import { TMUX_TRUECOLOR_VAR } from "../src/doctor/checks";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { DaemonAnswer } from "../src/doctor/daemon-answer";
import type { FrameSeen } from "../src/daemon/render-sightings";
import { answerRepo } from "./helpers/repo-approval";

// The daemon a healthy bar answers from: its session runs with the Claude
// Code directory this test's command reports (CLAUDE_CONFIG_DIR, `inDir`).
const DAEMON = () => healthyDaemonIn(dir)();
// That daemon, answering what the doctor's stores hold.
const daemonHolding =
  (stores: Partial<StoresRead>) => async (): Promise<DaemonAnswer> => ({
    ...(await DAEMON()),
    stores: { ...EMPTY_STORES, ...stores },
  });

const IN_TMUX = { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%1" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-cli-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const EDGE: DoctorEdge = {
  install: HEALTHY_INSTALL_EDGE,
  ...healthyDaemonEdge(),
  ...healthyDataEdge(),
  ...noManagedSettings(),
  probeTmux: () => ({
    kind: "ok",
    // A terminal that ships its own Nerd Font symbols and draws links, which
    // tmux passes through, so the Nerd Font and links checks are ok and
    // these tests are about the others.
    value: {
      features: ["hyperlinks", "osc7", "RGB", "sixel"],
      termtype: "ghostty 1.3.1",
      termname: "xterm-ghostty",
      pid: 4242,
      utf8: true,
    },
  }),
  remoteLogin: () => {
    throw new Error("remoteLogin must not run in this case");
  },
  fontInUse: () => {
    throw new Error("fontInUse must not run in this case");
  },
  loadConfig: () => ({
    layers: [],
    error: null,
    warning: null,
    unused: [],
    config: DEFAULT_DSL_CONFIG,
  }),
};
// A platform with no URL handler: the probe has nothing to send, and these
// tests are about the other checks (test/doctor-url-handler.test.ts has it).
const refuse = (): never => {
  throw new Error("no URL handler edge in this test");
};
const NO_HANDLER: HandlerProbeEdge = {
  platform: "linux",
  sockets: { own: "/s", handler: "/s" },
  now: refuse,
  nonce: refuse,
  daemon: refuse,
  open: refuse,
  pause: refuse,
  opener: refuse,
  script: refuse,
  exists: refuse,
};
// The settings file the CLI reads is the one its own CLAUDE_CONFIG_DIR names.
const settingsPath = (): string => path.join(dir, "settings.json");
// Ghostty outside tmux too (EDGE's tmux client is Ghostty inside it).
const inDir = (env: Record<string, string>) => ({
  TERM_PROGRAM: "ghostty",
  ...env,
  CLAUDE_CONFIG_DIR: dir,
});

describe("doctorPlan", () => {
  // brandon-doctor-v62x.49w: a settings file that does not read fails the
  // rows that read the settings chain, naming it — every other row still runs.
  test("an unreadable settings.json fails the settings rows naming the file, and the rest still run", async () => {
    fs.writeFileSync(settingsPath(), '{ "env": [1] }');
    const plan = await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir(IN_TMUX), "/", () => ({ columns: 120 }));
    expect(plan.code).toBe(1);
    expect(plan.stderr).toBe("");
    expect(plan.stdout).toContain(
      `✗ tmux truecolor — cannot read ${settingsPath()}: \`env\` is not an object\n`,
    );
    expect(plan.stdout).toContain("✓ config — bundled default (no config file loaded)\n");
    expect(plan.stdout).toContain("✓ session data\n");
  });

  // Claude Code parses settings.json strictly; a file it would refuse is not
  // readable, whatever a looser parser makes of it.
  test("a settings.json that is JSON5 but not JSON fails the settings rows naming the file", async () => {
    fs.writeFileSync(settingsPath(), '{ "env": { "A": "1", }, }');
    const plan = await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir(IN_TMUX), "/", () => ({ columns: 120 }));
    expect(plan.code).toBe(1);
    expect(plan.stdout).toContain(`✗ tmux truecolor — cannot read ${settingsPath()}: `);
  });

  test("every check ok is exit 0, one ✓ line per check", async () => {
    expect(await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir({}), "/", () => ({ columns: 120 }))).toEqual({
      stdout: "✓ config — bundled default (no config file loaded)\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width — 120 columns, as this command's terminal measured\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n",
      stderr: "",
      code: 0,
    });
  });

  // brandon-doctor-v62x.1ku: the command measures the terminal it runs in —
  // COLUMNS, else the terminal's own geometry.
  test("a terminal the command cannot measure fails terminal width, exit 1", async () => {
    const plan = await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir({}), "/", () => ({}));
    expect(plan.code).toBe(1);
    expect(plan.stdout).toContain(
      "\n✗ terminal width — this command's terminal measured no width",
    );
    expect(
      (await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir({ COLUMNS: "90" }), "/", () => ({}))).code,
    ).toBe(0);
  });

  // brandon-doctor-v62x.1z2: in a Claude Code session's shell the row judges
  // the width that session's own client measured, as the daemon recorded it
  // (the fixture daemon's session s1 drew at 148) — not this shell's, which
  // here has no terminal at all.
  test("in a Claude Code session, terminal width is the session's bar's", async () => {
    const plan = await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir({ CLAUDE_CODE_SESSION_ID: "s1" }), "/", () => ({}));
    expect(plan.stdout).toContain("\n✓ terminal width — 148 columns, as session s1's statusline client measured\n");
    expect(plan.code).toBe(0);
  });

  test("a session the daemon has drawn no bar for fails terminal width, naming it", async () => {
    const plan = await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir({ CLAUDE_CODE_SESSION_ID: "s2", COLUMNS: "90" }), "/", () => ({}));
    expect(plan.stdout).toContain(
      "\n✗ terminal width — the daemon holds no statusline render of session s2",
    );
    expect(plan.code).toBe(1);
  });

  test("a measurement that throws is a doctor: line, exit 2, no checks", async () => {
    const plan = await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir({}), "/", () => {
      throw new Error("EBADF: bad file descriptor");
    });
    expect(plan).toEqual({
      stdout: "",
      stderr: "doctor: EBADF: bad file descriptor\n",
      code: 2,
    });
  });

  // brandon-doctor-v62x.ryu: the command has no click to prove links work, so
  // it reads tmux's word on its client and the terminal's own name.
  test("tmux without hyperlinks for its client fails links, naming the line to add", async () => {
    const edge: DoctorEdge = {
      ...EDGE,
      probeTmux: (hint) => {
        const asked = EDGE.probeTmux(hint);
        if (asked.kind !== "ok" || asked.value === null) throw new Error("EDGE answers a client");
        return {
          kind: "ok",
          value: { ...asked.value, features: asked.value.features.filter((f) => f !== "hyperlinks") },
        };
      },
    };
    const plan = await doctorPlan(edge, NO_HANDLER, DAEMON, inDir(IN_TMUX), "/", () => ({ columns: 120 }));
    expect(plan.stdout).toContain(
      '\n✗ links — tmux does not pass links through to Ghostty — add `set -as terminal-features ",xterm-ghostty:hyperlinks"` to tmux.conf, then detach and reattach (tmux 3.4 or later)\n',
    );
  });

  test("outside tmux the terminal's own name decides links", async () => {
    const plan = await doctorPlan(
      EDGE,
      NO_HANDLER, DAEMON,
      inDir({ TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455.1" }),
      "/",
      () => ({ columns: 120 }),
    );
    expect(plan.code).toBe(1);
    expect(plan.stdout).toMatch(/\n✗ links — Terminal draws no links \(OSC 8\)/);
  });

  // kitty names itself only in TERM, which carries no release; the bar's
  // doctor, clicked in kitty, files the proof this command reads.
  test("a terminal whose release went unsaid is settled by a doctor click remembered for it", async () => {
    const kitty = inDir({ TERM_PROGRAM: "", TERM: "xterm-kitty" });
    const unsettled = await doctorPlan(EDGE, NO_HANDLER, DAEMON, kitty, "/", () => ({ columns: 120 }));
    expect(unsettled.stdout).toMatch(/\n✗ links — kitty draws links \(OSC 8\) since 0\.19\.0, and did not say which release this is — click 🩺 doctor/);
    const settled = await doctorPlan(
      EDGE,
      NO_HANDLER,
      daemonHolding({ clicked: { kind: "ok", value: ["kitty"] } }),
      kitty,
      "/",
      () => ({ columns: 120 }),
    );
    expect(settled.stdout).toContain("\n✓ links\n");
  });

  // The CLI cannot take a mark: it shows the glyphs, and the bar's doctor
  // where one is made — and reads the marks made there.
  test("a check that shows glyphs to look at prints them, and where to mark them", async () => {
    const plan = await doctorPlan(
      EDGE,
      NO_HANDLER, DAEMON,
      inDir({ TERM_PROGRAM: "Hyper" }),
      "/",
      () => ({ columns: 120 }),
    );
    expect(plan.code).toBe(1);
    expect(plan.stdout).toMatch(
      new RegExp(
        "\n✗ Nerd Font — the doctor cannot read Hyper's font\n" +
          `    look: ${BUNDLED_GLYPHS} — mark them ✓ shapes or ✗ boxes in the bar's doctor, ` +
          "and this command reads your mark: " +
          `the settings menu \\(${DOOR_GLYPH} by default\\) › 🧰 tools › 🩺 doctor\n✓ segment data\n✓ session data\n$`,
        "u",
      ),
    );
  });

  // brandon-doctor-v62x.2ww: the mark is the machine's, so the CLI reads a
  // mark made in the bar's doctor and passes on it.
  test("a ✓ the bar's doctor filed in the mark book settles the check here too", async () => {
    const id = glyphSighting({ glyphs: BUNDLED_GLYPHS, terminal: { kind: "unknown", called: "Hyper" } })!.id;
    const plan = await doctorPlan(
      EDGE,
      NO_HANDLER,
      daemonHolding({ marks: { kind: "ok", value: withMark({}, "nerdFont", id, "drawn") } }),
      inDir({ TERM_PROGRAM: "Hyper" }),
      "/",
      () => ({ columns: 120 }),
    );
    expect(plan.stdout).toContain("\n✓ Nerd Font\n✓ segment data\n✓ session data\n");
  });

  // brandon-doctor-v62x.bmf: the bar's doctor files its stores under the
  // DAEMON's state directory, from whichever shell spawned it; this command
  // reads what they hold in the daemon's answer, never a file of its own.
  test("the doctor's stores are the daemon's answer", async () => {
    const breach = "2026-10-19T18-01-12-345Z-77";
    const breached = (postMortemsRead: StoresRead["postMortemsRead"]) => async (): Promise<DaemonAnswer> => ({
      ...(await daemonHolding({ postMortemsRead })()),
      serving: {
        kind: "ok",
        value: {
          ...HEALTHY_SERVING,
          postMortems: { kind: "ok", value: [{ identity: breach, artifacts: { memoryReport: "/m.txt" } }] },
        },
      },
    });
    const plan = (daemon: () => Promise<DaemonAnswer>) =>
      doctorPlan(EDGE, NO_HANDLER, daemon, inDir(IN_TMUX), "/", () => ({ columns: 120 }));
    expect((await plan(breached({ kind: "ok", value: { through: breach } }))).stdout).toContain("\n✓ daemon\n");
    expect((await plan(breached({ kind: "failed", reason: "EACCES" }))).stdout).toContain(
      "\n✗ daemon — which post-mortems were read could not be read: EACCES\n",
    );
  });

  // With no daemon to answer, the stores are unknown: a check whose own facts
  // settle it needs no store, and the daemon row says why once.
  test("no daemon: the daemon row says why once, and checks the stores cannot settle still pass", async () => {
    const reason = "could not connect to the daemon";
    const failed = { kind: "failed", reason } as const;
    const plan = await doctorPlan(
      EDGE,
      NO_HANDLER,
      async () => ({
        ...(await DAEMON()),
        serving: failed,
        stores: { marks: failed, clicked: failed, postMortemsRead: failed },
      }),
      inDir(IN_TMUX),
      "/",
      () => ({ columns: 120 }),
    );
    expect(plan.stdout).toContain(`\n✗ daemon — ${reason} — daemon 4100 running\n✓ URL handler\n`);
    expect(plan.stdout).toContain("\n✓ links\n");
    expect(plan.stdout).toContain("\n✓ Nerd Font\n");
  });

  test("a failed check is exit 1, its reason and the fix hint on the line", async () => {
    const plan = await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir(IN_TMUX), "/", () => ({ columns: 120 }));
    expect(plan.code).toBe(1);
    expect(plan.stderr).toBe("");
    expect(plan.stdout).toBe(
      "✓ config — bundled default (no config file loaded)\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n" +
        "✗ tmux truecolor — Claude Code renders the bar in 256 colours inside tmux" +
        ` (fix: click the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor, then [fix] on the bar)\n` +
        "✓ UTF-8\n✓ terminal width — 120 columns, as this command's terminal measured\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n",
    );
  });

  // The verdict names the file it read — the one in THIS shell's
  // CLAUDE_CONFIG_DIR, not ~/.claude's.
  test("a staged-but-unapplied fix names the settings file it was read from", async () => {
    fs.writeFileSync(settingsPath(), `{ "env": { "${TMUX_TRUECOLOR_VAR}": "1" } }`);
    expect((await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir(IN_TMUX), "/", () => ({ columns: 120 }))).stdout).toBe(
      `✓ config — bundled default (no config file loaded)\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✗ tmux truecolor — ${TMUX_TRUECOLOR_VAR} is set in ${settingsPath()} — restart Claude Code to apply\n✓ UTF-8\n✓ terminal width — 120 columns, as this command's terminal measured\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n`,
    );
  });
});

// brandon-doctor-v62x.e91: the config check over the loader itself — the CLI's
// own edge, a real project config in the directory it runs from, and a user
// config behind it under an isolated XDG home.
describe("doctorPlan over a real config", () => {
  const REAL: DoctorEdge = { ...EDGE, loadConfig: loadConfigOnce };
  let savedXdg: string | undefined;
  let project: string;
  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
    project = path.join(dir, "project");
    fs.mkdirSync(project);
    // The project's config is the one the doctor reads.
    answerRepo(project);
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });
  const projectConfig = (): string => path.join(project, ".cc-candybar.json5");
  const plan = (env: Record<string, string> = {}) =>
    doctorPlan(REAL, NO_HANDLER, DAEMON, inDir(env), project, () => ({ columns: 120 }));

  test("a load of a config whose plugin declares sources makes, watches and sweeps no storage", async () => {
    const plugin = path.join(project, "p");
    const storage = path.join(plugin, "session");
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(
      path.join(plugin, "plugin.json5"),
      `{ sources: { status: { scope: "session", refresh: { watch: true }, read: { file: { json: true } } } },
         segments: { s: { template: "{{ .repo.p.status }}" } } }`,
    );
    // A session's file nobody has written for 31 days.
    const old = path.join(storage, "s.json");
    fs.writeFileSync(old, "{}");
    const at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, at, at);
    fs.writeFileSync(
      projectConfig(),
      `{ plugins: ["./p/plugin.json5"], root: { h: ["repo.p.s"] } }`,
    );
    const load = loadConfigOnce({ projectDir: project, cwd: project, target: { source: "search" } });
    expect(load.error).toBeNull();
    expect(Object.keys(load.config.variables)).toContain("repo.p.status");
    // Long enough for a sweep the load started to have unlinked it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.existsSync(old)).toBe(true);
    fs.rmSync(storage, { recursive: true });
    loadConfigOnce({ projectDir: project, cwd: project, target: { source: "search" } });
    expect(fs.existsSync(storage)).toBe(false);
  });

  // The doctor reads the one load the daemon settles, so a warning only the
  // build earns (a variable that failed to declare) reaches its verdict too.
  test("a load's warning carries what its build earned", () => {
    fs.writeFileSync(
      projectConfig(),
      `{ variables: { v: { kind: "template", template: "{{ if }}" } } }`,
    );
    const load = loadConfigOnce({ projectDir: project, cwd: project, target: { source: "search" } });
    expect(load.error).toBeNull();
    expect(load.warning).toContain(`Variable "v"`);
  });

  test("no config file anywhere: the bundled default is correct", async () => {
    expect((await plan()).stdout).toBe("✓ config — bundled default (no config file loaded)\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width — 120 columns, as this command's terminal measured\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n");
  });

  test("a config using everything it declares is ok", async () => {
    fs.writeFileSync(
      projectConfig(),
      `{ variables: { v: { kind: "literal", value: "x" } },
         segments: { s: { template: "{{ .v }}" } }, root: { h: ["s"] } }`,
    );
    expect(await plan()).toEqual({
      stdout: `✓ config — ${projectConfig()} (searched)\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width — 120 columns, as this command's terminal measured\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n`,
      stderr: "",
      code: 0,
    });
  });

  test("every problem is listed: the advisory and each unused name, the user layer behind the project's included", async () => {
    const user = path.join(dir, "xdg", "cc-candybar", "config.json5");
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, `{ helpers: { h: "x" } }`);
    fs.writeFileSync(
      projectConfig(),
      `{
  variables: { v: { kind: "literal", value: "x" }, v: { kind: "literal", value: "y" } },
  actions: { a: { copy: "text" } },
}`,
    );
    expect(await plan()).toEqual({
      stdout:
        `✗ config — ${user} < ${projectConfig()} (searched): ${projectConfig()}:2: duplicate key "v" — the settings menu cannot edit this file until it is fixed\n` +
        `    helper "h" is never called\n` +
        `    variable "v" is never read\n` +
        `    action "a" is never clicked\n` +
        "✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width — 120 columns, as this command's terminal measured\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n",
      stderr: "",
      code: 1,
    });
  });

  test("a config that does not load is the loader's own error", async () => {
    fs.writeFileSync(projectConfig(), `{ root: { h: ["ghost"] } }`);
    const out = await plan();
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(
      new RegExp(`^✗ config — .* \\(searched\\): Invalid config in .*\\(1 issue\\):\n    .*ghost`),
    );
  });

  test("threshold knobs that do not ascend are a load error, so the check fails", async () => {
    fs.writeFileSync(
      projectConfig(),
      `{ root: { h: [{ seg: "block", settings: { warnAt: 90, errorAt: 50 } }] } }`,
    );
    const out = await plan();
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/^✗ config — .* \(searched\): Invalid config/);
    expect(out.stdout).toMatch(/errorAt/);
  });

  // Named relative to the doctor's cwd, never the process's (brandon-config-nuq6).
  test("a file named on the command line is the one checked, over $CC_CANDYBAR_CONFIG", async () => {
    const named = path.join(dir, "named.json5");
    const hinted = path.join(dir, "hinted.json5");
    fs.writeFileSync(named, `{ helpers: { h: "x" } }`);
    fs.writeFileSync(hinted, "{}");
    expect(
      (
        await doctorPlan(
          REAL,
          NO_HANDLER, DAEMON,
          inDir({ CC_CANDYBAR_CONFIG: hinted }),
          project, () => ({ columns: 120 }),
          path.relative(project, named),
        )
      )
        .stdout,
    ).toBe(`✗ config — ${named} (command argument): helper "h" is never called\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width — 120 columns, as this command's terminal measured\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n`);
  });

  // [LAW:single-enforcer] brandon-unfiled-3248.e3r: the argv gate refuses
  // arity and an option only. An empty argument — `doctor "$CFG"` with CFG
  // unset — passes through as the name it is; what it means is decided where
  // `check` and the bar decide it, not at the gate. One table, so the diff of
  // a regression names its row: reintroducing `args[0] === ""` shows the
  // `[""]` row as usage where run is expected.
  test("parseDoctorArgs refuses two files or an option, never an empty name", () => {
    const USAGE = "Usage: cc-candybar doctor [config-file]\n";
    const ARITY = `doctor: expected at most one config file\n${USAGE}`;
    const table = [[], [""], ["a.json5"], ["a.json5", "b.json5"], ["--help"], ["a.json5", "--verbose"]];
    expect(table.map((args) => ({ args, parsed: parseDoctorArgs(args) }))).toEqual([
      { args: [], parsed: { kind: "run", configFile: undefined } },
      { args: [""], parsed: { kind: "run", configFile: "" } },
      { args: ["a.json5"], parsed: { kind: "run", configFile: "a.json5" } },
      { args: ["a.json5", "b.json5"], parsed: { kind: "usage", message: ARITY } },
      { args: ["--help"], parsed: { kind: "usage", message: `doctor: unknown option --help\n${USAGE}` } },
      { args: ["a.json5", "--verbose"], parsed: { kind: "usage", message: `doctor: unknown option --verbose\n${USAGE}` } },
    ]);
  });

  // [LAW:one-source-of-truth] brandon-unfiled-3248.e3r: `doctor "$CFG"` with
  // CFG unset checks the bar `--config "$CFG"` renders — the hinted chain —
  // never refusing the run. The empty name means what it means to the bar.
  test("an empty name on the command line is no name: $CC_CANDYBAR_CONFIG is the file checked", async () => {
    const hinted = path.join(dir, "hinted.json5");
    fs.writeFileSync(hinted, `{ helpers: { h: "x" } }`);
    const out = await doctorPlan(
      REAL,
      NO_HANDLER, DAEMON,
      inDir({ CC_CANDYBAR_CONFIG: hinted }),
      project, () => ({ columns: 120 }),
      "",
    );
    expect(out.code).toBe(1);
    expect(out.stdout.split("\n")[0]).toBe(
      `✗ config — ${hinted} ($CC_CANDYBAR_CONFIG): helper "h" is never called`,
    );

    // With no variable either, the empty name and no name reach the same
    // searched chain: undefined-from-empty is undefined-from-absent.
    const plan = (configFile: string | undefined) =>
      doctorPlan(REAL, NO_HANDLER, DAEMON, inDir({}), project, () => ({ columns: 120 }), configFile);
    expect(await plan("")).toEqual(await plan(undefined));
  });

  // brandon-effects-2gka.21e, brandon-doctor-v62x.tgp: what the recent bars
  // of this Claude Code directory drew decides whether the bar moves, and the
  // settings file in this shell's CLAUDE_CONFIG_DIR whether Claude Code
  // redraws it every second — and takes the fix.
  const drawing = (frame: FrameSeen, claudeConfigDir: string) => async () => ({
    ...(await DAEMON()),
    frames: {
      kind: "ok" as const,
      value: [reportedFrame(frame, claudeConfigDir)],
    },
  });
  const planOver = (daemon: () => Promise<DaemonAnswer>) =>
    doctorPlan(REAL, NO_HANDLER, daemon, inDir({}), project, () => ({ columns: 120 }));

  test("a bar seen moving under a statusLine with no interval fails effect refresh, with the fix hint", async () => {
    fs.writeFileSync(
      settingsPath(),
      `{ "statusLine": { "type": "command", "command": "cc-candybar" } }`,
    );
    expect(await planOver(drawing("moves", dir))).toEqual({
      stdout:
        "✓ config — bundled default (no config file loaded)\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width — 120 columns, as this command's terminal measured\n" +
        "✗ effect refresh — the bar moves (an effect, a fade, an animated segment, or an open menu counting down to its close), but its statusLine sets no refreshInterval, so Claude Code redraws it only on events" +
        ` (statusLine from ${settingsPath()})` +
        ` (fix: click the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor, then [fix] on the bar)\n` +
        "✓ Nerd Font\n✓ segment data\n✓ session data\n",
      stderr: "",
      code: 1,
    });
  });

  // Another directory's settings file redraws that session, not this one's.
  // brandon-doctor-v62x.y5d: each bar is judged against the settings chain
  // ITS session reads — its project's files and its Claude Code directory's
  // user file — never the one this command's cwd would read.
  describe("each session's own settings chain", () => {
    let other: string;
    beforeEach(() => {
      other = path.join(dir, "other");
      fs.mkdirSync(path.join(other, ".claude"), { recursive: true });
      // This command's cwd reads only the user file, which asks for nothing.
      fs.writeFileSync(
        settingsPath(),
        `{ "statusLine": { "type": "command", "command": "cc-candybar" } }`,
      );
      // The other project holds its own statusLine, redrawing every second.
      fs.writeFileSync(
        path.join(other, ".claude", "settings.local.json"),
        `{ "statusLine": { "type": "command", "command": "cc-candybar", "refreshInterval": 1 } }`,
      );
    });
    const sessions =
      (...frames: ReturnType<typeof reportedFrame>[]) =>
      async (): Promise<DaemonAnswer> => ({
        ...(await DAEMON()),
        frames: { kind: "ok", value: frames },
      });
    // s1: the other project, whose chain sets 1. s2: this project, whose
    // chain sets none.
    const s1 = () => reportedFrame("moves", dir, other, "s1");
    const s2 = () => reportedFrame("moves", dir, project, "s2");

    test("a bar whose project sets the interval passes, though this cwd's chain sets none", async () => {
      expect((await planOver(sessions(s1()))).stdout).toContain(
        `✓ effect refresh — statusLine.refreshInterval is 1 in ${path.join(other, ".claude", "settings.local.json")}\n`,
      );
    });

    test("with bars in both, the one whose own chain fails is the finding, with its fix", async () => {
      expect((await planOver(sessions(s1(), s2()))).stdout).toContain(
        `✗ effect refresh — the bar moves (an effect, a fade, an animated segment, or an open menu counting down to its close), but its statusLine sets no refreshInterval, so Claude Code redraws it only on events (statusLine from ${settingsPath()})`,
      );
    });

    // Run in a session's shell, the command judges that session's bar alone.
    // The project a shell's session reads its settings from is the one its
    // render recorded, whichever directory under it the shell has cd'd into.
    test("run in a session, its own chain is the session's project's, not the shell's cwd", () => {
      const said = [s1(), s2()];
      expect(ownProject({ kind: "shell", sessionId: "s1" }, said, path.join(other, "sub"))).toBe(other);
      expect(ownProject({ kind: "shell", sessionId: "s9" }, said, "/here")).toBe("/here");
      expect(ownProject({ kind: "recent" }, said, "/here")).toBe("/here");
    });

    test("run in session s1, s2's bar is not judged", async () => {
      const out = await doctorPlan(
        REAL,
        NO_HANDLER,
        sessions(s1(), s2()),
        inDir({ CLAUDE_CODE_SESSION_ID: "s1" }),
        project,
        () => ({ columns: 120 }),
      );
      expect(out.stdout).toContain(
        `✓ effect refresh — statusLine.refreshInterval is 1 in ${path.join(other, ".claude", "settings.local.json")}\n`,
      );
    });
  });

  test("$CC_CANDYBAR_CONFIG names the file checked, as the client reports it", async () => {
    const named = path.join(dir, "named.json5");
    fs.writeFileSync(named, `{ helpers: { h: "x" } }`);
    expect((await plan({ CC_CANDYBAR_CONFIG: named })).stdout).toBe(
      `✗ config — ${named} ($CC_CANDYBAR_CONFIG): helper "h" is never called\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width — 120 columns, as this command's terminal measured\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n`,
    );
  });

  // The bar's row holds one problem and counts the rest; the CLI lists them.
  test("the report row names the first problem and counts the others", async () => {
    fs.writeFileSync(
      projectConfig(),
      `{ actions: { a: { copy: "t" }, b: { copy: "t" } }, helpers: { h: "x" } }`,
    );
    const reports = runDoctor({
      ...gatherFacts(
        REAL,
        { tmux: null, claudeConfigDir: dir },
        { projectDir: project, cwd: project, target: { source: "search" } },
        () => null,
        { kind: "ok", value: HEALTHY_SERVING },
        CARRIED,
        NAMED,
        { kind: "recent" },
        sightedIn(project, dir, STILL),
        { kind: "ok", value: { columns: 148, of: { kind: "command" } } },
        EMPTY_STORES,
      ),
      urlHandler: { kind: "unsupported" },
      install: HEALTHY_FACTS.install,
    });
    const pairs = new Map(
      doctorReportPairs(reports).map((p) => [p.key, p.value]),
    );
    expect(pairs.get(doctorReportKeys("config").reason)).toBe(
      `${projectConfig()} (searched): action "a" is never clicked (+2 more — run \`cc-candybar doctor\`)`,
    );
  });
});
