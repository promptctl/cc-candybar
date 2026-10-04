// [LAW:verifiable-goals] `cc-candybar doctor`'s contract, read off the plan
// the argv binding performs: the exit code and the streams for an unreadable
// settings file, a clean setup, and a failed check carrying a fix.

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

const IN_TMUX = { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%1" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-cli-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const EDGE: DoctorEdge = {
  probeTmux: () => ({ kind: "ok", value: ["osc7", "RGB", "sixel"] }),
  loadConfig: () => ({ path: null, error: null, warning: null, unused: [] }),
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
const inDir = (env: Record<string, string>) => ({ ...env, CLAUDE_CONFIG_DIR: dir });

describe("doctorPlan", () => {
  test("an unreadable settings.json is exit 2 naming the file, nothing on stdout", async () => {
    fs.writeFileSync(settingsPath(), '{ "env": [1] }');
    expect(await doctorPlan(EDGE, NO_HANDLER, inDir(IN_TMUX), "/")).toEqual({
      stdout: "",
      stderr: `doctor: cannot read ${settingsPath()}: \`env\` is not an object\n`,
      code: 2,
    });
  });

  // A run that cannot report opens no link: on macOS the probe would be the
  // refusing edge's first call.
  test("an unreadable settings.json is reported before any link is opened", async () => {
    fs.writeFileSync(settingsPath(), '{ "env": [1] }');
    const plan = await doctorPlan(
      EDGE,
      { ...NO_HANDLER, platform: "darwin", sockets: { own: "/a", handler: "/a" } },
      inDir(IN_TMUX),
      "/",
    );
    expect(plan.stderr).toBe(
      `doctor: cannot read ${settingsPath()}: \`env\` is not an object\n`,
    );
  });

  // Claude Code parses settings.json strictly; a file it would refuse is not
  // readable, whatever a looser parser makes of it.
  test("a settings.json that is JSON5 but not JSON is exit 2 naming the file", async () => {
    fs.writeFileSync(settingsPath(), '{ "env": { "A": "1", }, }');
    const plan = await doctorPlan(EDGE, NO_HANDLER, inDir(IN_TMUX), "/");
    expect(plan.stdout).toBe("");
    expect(plan.code).toBe(2);
    expect(plan.stderr).toMatch(/\n$/);
    expect(plan.stderr.startsWith(`doctor: cannot read ${settingsPath()}: `)).toBe(true);
  });

  test("every check ok is exit 0, one ✓ line per check", async () => {
    expect(await doctorPlan(EDGE, NO_HANDLER, inDir({}), "/")).toEqual({
      stdout: "✓ config\n✓ URL handler\n✓ tmux truecolor\n",
      stderr: "",
      code: 0,
    });
  });

  test("a failed check is exit 1, its reason and the fix hint on the line", async () => {
    const plan = await doctorPlan(EDGE, NO_HANDLER, inDir(IN_TMUX), "/");
    expect(plan.code).toBe(1);
    expect(plan.stderr).toBe("");
    expect(plan.stdout).toBe(
      "✓ config\n✓ URL handler\n" +
        "✗ tmux truecolor — Claude Code renders the bar in 256 colours inside tmux" +
        ` (fix: click the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor, then [fix] on the bar)\n`,
    );
  });

  // The verdict names the file it read — the one in THIS shell's
  // CLAUDE_CONFIG_DIR, not ~/.claude's.
  test("a staged-but-unapplied fix names the settings file it was read from", async () => {
    fs.writeFileSync(settingsPath(), `{ "env": { "${TMUX_TRUECOLOR_VAR}": "1" } }`);
    expect((await doctorPlan(EDGE, NO_HANDLER, inDir(IN_TMUX), "/")).stdout).toBe(
      `✓ config\n✓ URL handler\n✗ tmux truecolor — ${TMUX_TRUECOLOR_VAR} is set in ${settingsPath()} — restart Claude Code to apply\n`,
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
    doctorPlan(REAL, NO_HANDLER, inDir(env), project);

  test("no config file anywhere: the bundled default is correct", async () => {
    expect((await plan()).stdout).toBe("✓ config\n✓ URL handler\n✓ tmux truecolor\n");
  });

  test("a config using everything it declares is ok", async () => {
    fs.writeFileSync(
      projectConfig(),
      `{ variables: { v: { kind: "literal", value: "x" } },
         segments: { s: { template: "{{ .v }}" } }, root: { h: ["s"] } }`,
    );
    expect(await plan()).toEqual({
      stdout: "✓ config\n✓ URL handler\n✓ tmux truecolor\n",
      stderr: "",
      code: 0,
    });
  });

  test("every problem is listed: the advisory, the shadowed file, each unused name", async () => {
    const user = path.join(dir, "xdg", "cc-candybar", "config.json5");
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.writeFileSync(user, "{}");
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
        `    ${user} is never read — ${projectConfig()} is found first\n` +
        `    variable "v" is never read\n` +
        `    action "a" is never clicked\n` +
        "✓ URL handler\n✓ tmux truecolor\n",
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

  test("a file named on the command line is the one checked, over $CC_CANDYBAR_CONFIG", async () => {
    const named = path.join(dir, "named.json5");
    const hinted = path.join(dir, "hinted.json5");
    fs.writeFileSync(named, `{ helpers: { h: "x" } }`);
    fs.writeFileSync(hinted, "{}");
    expect(
      (
        await doctorPlan(
          REAL,
          NO_HANDLER,
          inDir({ CC_CANDYBAR_CONFIG: hinted }),
          project,
          named,
        )
      )
        .stdout,
    ).toBe(`✗ config — helper "h" is never called\n✓ URL handler\n✓ tmux truecolor\n`);
  });

  test("$CC_CANDYBAR_CONFIG names the file checked, as the client reports it", async () => {
    const named = path.join(dir, "named.json5");
    fs.writeFileSync(named, `{ helpers: { h: "x" } }`);
    expect((await plan({ CC_CANDYBAR_CONFIG: named })).stdout).toBe(
      `✗ config — helper "h" is never called\n✓ URL handler\n✓ tmux truecolor\n`,
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
      ),
      urlHandler: { kind: "unsupported" },
    });
    const pairs = new Map(
      doctorReportPairs(reports).map((p) => [p.key, p.value]),
    );
    expect(pairs.get(doctorReportKeys("config").reason)).toBe(
      'action "a" is never clicked (+2 more — run `cc-candybar doctor`)',
    );
  });
});
