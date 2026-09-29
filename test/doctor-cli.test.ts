// [LAW:verifiable-goals] `cc-candybar doctor`'s contract, read off the plan
// the argv binding performs: the exit code and the streams for an unreadable
// settings file, a clean setup, and a failed check carrying a fix.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctorPlan } from "../src/doctor/cli";
import { DISCLOSURE_GLYPH_CLOSED, DOOR_GLYPH } from "../src/config/disclosure";
import type { DoctorEdge } from "../src/doctor/edge";
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
};
// The settings file the CLI reads is the one its own CLAUDE_CONFIG_DIR names.
const settingsPath = (): string => path.join(dir, "settings.json");
const inDir = (env: Record<string, string>) => ({ ...env, CLAUDE_CONFIG_DIR: dir });

describe("doctorPlan", () => {
  test("an unreadable settings.json is exit 2 naming the file, nothing on stdout", () => {
    fs.writeFileSync(settingsPath(), '{ "env": [1] }');
    expect(doctorPlan(EDGE, inDir(IN_TMUX), "/")).toEqual({
      stdout: "",
      stderr: `doctor: cannot read ${settingsPath()}: \`env\` is not an object\n`,
      code: 2,
    });
  });

  // Claude Code parses settings.json strictly; a file it would refuse is not
  // readable, whatever a looser parser makes of it.
  test("a settings.json that is JSON5 but not JSON is exit 2 naming the file", () => {
    fs.writeFileSync(settingsPath(), '{ "env": { "A": "1", }, }');
    const plan = doctorPlan(EDGE, inDir(IN_TMUX), "/");
    expect(plan.stdout).toBe("");
    expect(plan.code).toBe(2);
    expect(plan.stderr).toMatch(/\n$/);
    expect(plan.stderr.startsWith(`doctor: cannot read ${settingsPath()}: `)).toBe(true);
  });

  test("every check ok is exit 0, one ✓ line per check", () => {
    expect(doctorPlan(EDGE, inDir({}), "/")).toEqual({
      stdout: "✓ tmux truecolor\n",
      stderr: "",
      code: 0,
    });
  });

  test("a failed check is exit 1, its reason and the fix hint on the line", () => {
    const plan = doctorPlan(EDGE, inDir(IN_TMUX), "/");
    expect(plan.code).toBe(1);
    expect(plan.stderr).toBe("");
    expect(plan.stdout).toBe(
      "✗ tmux truecolor — Claude Code renders the bar in 256 colours inside tmux" +
        ` (fix: click the settings menu (${DOOR_GLYPH} by default) › 🧰 tools ${DISCLOSURE_GLYPH_CLOSED} 🩺 doctor, then [fix] on the bar)\n`,
    );
  });

  // The verdict names the file it read — the one in THIS shell's
  // CLAUDE_CONFIG_DIR, not ~/.claude's.
  test("a staged-but-unapplied fix names the settings file it was read from", () => {
    fs.writeFileSync(settingsPath(), `{ "env": { "${TMUX_TRUECOLOR_VAR}": "1" } }`);
    expect(doctorPlan(EDGE, inDir(IN_TMUX), "/").stdout).toBe(
      `✗ tmux truecolor — ${TMUX_TRUECOLOR_VAR} is set in ${settingsPath()} — restart Claude Code to apply\n`,
    );
  });
});
