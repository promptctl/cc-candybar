// [LAW:verifiable-goals] `cc-candybar doctor`'s contract, read off the plan
// the argv binding performs: the exit code and the streams for an unreadable
// settings file, a clean setup, and a failed check carrying a fix.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctorPlan } from "../src/doctor/cli";
import type { DoctorEdge } from "../src/doctor/edge";

const IN_TMUX = { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%1" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-cli-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function edge(): DoctorEdge {
  return {
    probeTmux: () => ({ kind: "ok", value: ["osc7", "RGB", "sixel"] }),
    claudeSettingsPath: path.join(dir, "settings.json"),
  };
}

describe("doctorPlan", () => {
  test("an unreadable settings.json is exit 2 naming the file, nothing on stdout", () => {
    const e = edge();
    fs.writeFileSync(e.claudeSettingsPath, '{ "env": [1] }');
    expect(doctorPlan(e, IN_TMUX)).toEqual({
      stdout: "",
      stderr: `doctor: cannot read ${e.claudeSettingsPath}: \`env\` is not an object\n`,
      code: 2,
    });
  });

  test("every check ok is exit 0, one ✓ line per check", () => {
    expect(doctorPlan(edge(), {})).toEqual({
      stdout: "✓ tmux truecolor\n",
      stderr: "",
      code: 0,
    });
  });

  test("a failed check is exit 1, its reason and the fix hint on the line", () => {
    const plan = doctorPlan(edge(), IN_TMUX);
    expect(plan.code).toBe(1);
    expect(plan.stderr).toBe("");
    expect(plan.stdout).toBe(
      "✗ tmux truecolor — Claude Code renders the bar in 256 colours inside tmux" +
        " (fix: click ☰ ▸ 🧰 tools ▸ 🩺 doctor, then [fix] on the bar)\n",
    );
  });
});
