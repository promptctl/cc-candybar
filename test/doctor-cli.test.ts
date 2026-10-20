// [LAW:verifiable-goals] `cc-candybar doctor`'s contract, read off the plan
// the argv binding performs: the exit code and the streams for an unreadable
// settings file, a clean setup, and a failed check carrying a fix.

import { BUNDLED_GLYPHS } from "./helpers/bundled-glyphs";
import { healthyDaemonEdge, healthyDataEdge, noManagedSettings, HEALTHY_SERVING, HEALTHY_INSTALL_EDGE, healthyDaemonIn, HEALTHY_FACTS, CARRIED, NAMED, STILL } from "./helpers/doctor-facts";
import { glyphSighting, type MarkBook } from "../src/doctor/checks";
import { withMark } from "../src/doctor/mark-book";
import { memoryStateFile } from "./helpers/state-file";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctorPlan, loadConfigOnce } from "../src/doctor/cli";
import { doctorReportKeys, doctorReportPairs } from "../src/doctor/report";
import { runDoctor } from "../src/doctor/checks";
import { gatherFacts } from "../src/doctor/edge";
import { DOOR_GLYPH } from "../src/config/disclosure";
import type { DoctorEdge } from "../src/doctor/edge";
import type { HandlerProbeEdge } from "../src/doctor/handler-probe";
import { TMUX_TRUECOLOR_VAR } from "../src/doctor/checks";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { DaemonAnswer } from "../src/doctor/daemon-answer";
import type { FrameSeen } from "../src/daemon/render-sightings";

// The daemon a healthy bar answers from: its session runs with the Claude
// Code directory this test's command reports (CLAUDE_CONFIG_DIR, `inDir`).
const DAEMON = () => healthyDaemonIn(dir)();

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
  marks: memoryStateFile<MarkBook>({}),
  clicked: memoryStateFile<readonly string[]>([]),
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
    expect(plan.stdout).toContain("✓ config\n");
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
      stdout: "✓ config\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n",
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
      "\n✗ terminal width — no terminal width was measured",
    );
    expect(
      (await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir({ COLUMNS: "90" }), "/", () => ({}))).code,
    ).toBe(0);
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
      { ...EDGE, clicked: memoryStateFile<readonly string[]>(["kitty"]) },
      NO_HANDLER,
      DAEMON,
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
      { ...EDGE, marks: memoryStateFile(withMark({}, "nerdFont", id, "drawn")) },
      NO_HANDLER,
      DAEMON,
      inDir({ TERM_PROGRAM: "Hyper" }),
      "/",
      () => ({ columns: 120 }),
    );
    expect(plan.stdout).toContain("\n✓ Nerd Font\n✓ segment data\n✓ session data\n");
  });

  test("a failed check is exit 1, its reason and the fix hint on the line", async () => {
    const plan = await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir(IN_TMUX), "/", () => ({ columns: 120 }));
    expect(plan.code).toBe(1);
    expect(plan.stderr).toBe("");
    expect(plan.stdout).toBe(
      "✓ config\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n" +
        "✗ tmux truecolor — Claude Code renders the bar in 256 colours inside tmux" +
        ` (fix: click the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor, then [fix] on the bar)\n` +
        "✓ UTF-8\n✓ terminal width\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n",
    );
  });

  // The verdict names the file it read — the one in THIS shell's
  // CLAUDE_CONFIG_DIR, not ~/.claude's.
  test("a staged-but-unapplied fix names the settings file it was read from", async () => {
    fs.writeFileSync(settingsPath(), `{ "env": { "${TMUX_TRUECOLOR_VAR}": "1" } }`);
    expect((await doctorPlan(EDGE, NO_HANDLER, DAEMON, inDir(IN_TMUX), "/", () => ({ columns: 120 }))).stdout).toBe(
      `✓ config\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✗ tmux truecolor — ${TMUX_TRUECOLOR_VAR} is set in ${settingsPath()} — restart Claude Code to apply\n✓ UTF-8\n✓ terminal width\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n`,
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
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });
  const projectConfig = (): string => path.join(project, ".cc-candybar.json5");
  const plan = (env: Record<string, string> = {}) =>
    doctorPlan(REAL, NO_HANDLER, DAEMON, inDir(env), project, () => ({ columns: 120 }));

  test("no config file anywhere: the bundled default is correct", async () => {
    expect((await plan()).stdout).toBe("✓ config\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n");
  });

  test("a config using everything it declares is ok", async () => {
    fs.writeFileSync(
      projectConfig(),
      `{ variables: { v: { kind: "literal", value: "x" } },
         segments: { s: { template: "{{ .v }}" } }, root: { h: ["s"] } }`,
    );
    expect(await plan()).toEqual({
      stdout: "✓ config\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n",
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
        `✗ config — ${projectConfig()}:2: duplicate key "v" — the settings menu cannot edit this file until it is fixed\n` +
        `    helper "h" is never called\n` +
        `    variable "v" is never read\n` +
        `    action "a" is never clicked\n` +
        "✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n",
      stderr: "",
      code: 1,
    });
  });

  test("a config that does not load is the loader's own error", async () => {
    fs.writeFileSync(projectConfig(), `{ root: { h: ["ghost"] } }`);
    const out = await plan();
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(
      new RegExp(`^✗ config — Invalid config in .*\\(1 issue\\):\n    .*ghost`),
    );
  });

  test("threshold knobs that do not ascend are a load error, so the check fails", async () => {
    fs.writeFileSync(
      projectConfig(),
      `{ root: { h: [{ seg: "block", settings: { warnAt: 90, errorAt: 50 } }] } }`,
    );
    const out = await plan();
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/^✗ config — Invalid config/);
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
    ).toBe(`✗ config — helper "h" is never called\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n`);
  });

  // brandon-effects-2gka.21e, brandon-doctor-v62x.tgp: what the recent bars of
  // this Claude Code directory drew decides whether the bar moves, and the
  // settings file in this shell's CLAUDE_CONFIG_DIR decides the cadence.
  const drawing = (frame: FrameSeen, claudeConfigDir: string) => async () => ({
    ...(await DAEMON()),
    frames: {
      kind: "ok" as const,
      value: [{ role: "statusline" as const, frame, claudeConfigDir, ago: 1 }],
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
        "✓ config\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width\n" +
        "✗ effect refresh — the bar moves (an effect, a fade, or an animated segment), but Claude Code redraws it only on events" +
        ` (statusLine from ${settingsPath()})` +
        ` (fix: click the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor, then [fix] on the bar)\n` +
        "✓ Nerd Font\n✓ segment data\n✓ session data\n",
      stderr: "",
      code: 1,
    });
  });

  // Another directory's settings file redraws that session, not this one's.
  test("a bar of another Claude Code directory says nothing about this one", async () => {
    expect((await planOver(drawing("moves", "/elsewhere"))).stdout).toMatch(
      /✗ effect refresh — no session of this Claude Code has drawn a statusline for this daemon in the last 5 minutes, so whether it moves is unknown/,
    );
  });

  test("$CC_CANDYBAR_CONFIG names the file checked, as the client reports it", async () => {
    const named = path.join(dir, "named.json5");
    fs.writeFileSync(named, `{ helpers: { h: "x" } }`);
    expect((await plan({ CC_CANDYBAR_CONFIG: named })).stdout).toBe(
      `✗ config — helper "h" is never called\n✓ install\n✓ daemon\n✓ URL handler\n✓ links\n✓ tmux truecolor\n✓ UTF-8\n✓ terminal width\n✓ effect refresh\n✓ Nerd Font\n✓ segment data\n✓ session data\n`,
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
        { projectDir: project, cwd: project, configFile: null },
        () => null,
        { kind: "ok", value: HEALTHY_SERVING },
        CARRIED,
        NAMED,
        STILL,
      ),
      urlHandler: { kind: "unsupported" },
      askedBy: "command",
      install: HEALTHY_FACTS.install,
    });
    const pairs = new Map(
      doctorReportPairs(reports).map((p) => [p.key, p.value]),
    );
    expect(pairs.get(doctorReportKeys("config").reason)).toBe(
      'action "a" is never clicked (+2 more — run `cc-candybar doctor`)',
    );
  });
});
