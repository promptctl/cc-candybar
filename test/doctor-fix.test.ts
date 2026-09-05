// [LAW:verifiable-goals] brandon-doctor-b6a acceptance 2: the fix over a
// settings.json WITH an existing `env` block and WITHOUT one changes exactly
// the one key, and every other byte of the user's file survives. The edge is
// driven with a fake DoctorEdge whose tmux probe throws, so the settings.json
// side of the edge is exercised alone — and the gatherFacts cases pin that
// the probe is only ever asked when there is a server to ask.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TMUX_TRUECOLOR_VAR, type Fix } from "../src/doctor/checks";
import { applyFix, gatherFacts, type DoctorEdge } from "../src/doctor/edge";

const FIX: Fix = { kind: "claude-settings-env", name: TMUX_TRUECOLOR_VAR, value: "1" };
const HINT = { socket: "/tmp/tmux-501/default", pane: "%3", truecolor: null };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function edgeAt(file: string, probeTmux?: DoctorEdge["probeTmux"]): DoctorEdge {
  return {
    probeTmux:
      probeTmux ??
      (() => {
        throw new Error("probeTmux must not run in this case");
      }),
    claudeSettingsPath: path.join(dir, file),
  };
}

function writeSettings(file: string, text: string): DoctorEdge {
  const edge = edgeAt(file);
  fs.writeFileSync(edge.claudeSettingsPath, text);
  return edge;
}

// The splice contract, asserted as bytes: the output minus the inserted
// entry IS the input. Splitting on the entry and gluing the halves back
// together must reproduce the original text exactly.
function assertOnlyInserted(before: string, after: string, entry: RegExp): void {
  const m = entry.exec(after);
  expect(m).not.toBeNull();
  const rest = after.slice(0, m!.index) + after.slice(m!.index + m![0].length);
  expect(rest).toBe(before);
}

describe("applyFix (claude-settings-env)", () => {
  test("with an existing env block: one entry appended, every other byte kept", () => {
    const before = `{
  "permissions": { "allow": ["Bash(ls:*)"] },
  "env": {
    "DISABLE_AUTOUPDATER": "1",
    "FORCE_COLOR": "3"
  },
  "model": "opus"
}
`;
    const edge = writeSettings("settings.json", before);
    applyFix(edge, FIX);
    const after = fs.readFileSync(edge.claudeSettingsPath, "utf8");
    expect(JSON.parse(after)).toEqual({
      permissions: { allow: ["Bash(ls:*)"] },
      env: {
        DISABLE_AUTOUPDATER: "1",
        FORCE_COLOR: "3",
        [TMUX_TRUECOLOR_VAR]: "1",
      },
      model: "opus",
    });
    assertOnlyInserted(
      before,
      after,
      new RegExp(`,\\s*"${TMUX_TRUECOLOR_VAR}": "1"`),
    );
  });

  test("without an env block: `env` is created holding only the one key", () => {
    const before = `{
  "model": "opus"
}
`;
    const edge = writeSettings("settings.json", before);
    applyFix(edge, FIX);
    const after = fs.readFileSync(edge.claudeSettingsPath, "utf8");
    expect(JSON.parse(after)).toEqual({
      model: "opus",
      env: { [TMUX_TRUECOLOR_VAR]: "1" },
    });
    assertOnlyInserted(
      before,
      after,
      new RegExp(`,\\s*"env": \\{\\s*"${TMUX_TRUECOLOR_VAR}": "1"\\s*\\}`),
    );
  });

  test("a stale value is overwritten in place, not duplicated", () => {
    const before = `{ "env": { "${TMUX_TRUECOLOR_VAR}": "" } }\n`;
    const edge = writeSettings("settings.json", before);
    applyFix(edge, FIX);
    const after = fs.readFileSync(edge.claudeSettingsPath, "utf8");
    expect(after).toBe(`{ "env": { "${TMUX_TRUECOLOR_VAR}": "1" } }\n`);
  });

  test("no settings file: the file (and its directory) is created", () => {
    const edge = edgeAt(path.join("nested", "settings.json"));
    applyFix(edge, FIX);
    expect(JSON.parse(fs.readFileSync(edge.claudeSettingsPath, "utf8"))).toEqual({
      env: { [TMUX_TRUECOLOR_VAR]: "1" },
    });
  });
});

describe("gatherFacts", () => {
  test("reads the env block of settings.json", () => {
    const edge = writeSettings(
      "settings.json",
      `{ "env": { "FORCE_COLOR": "3" }, "model": "opus" }`,
    );
    expect(gatherFacts(edge, null).claudeSettingsEnv).toEqual({
      FORCE_COLOR: "3",
    });
  });

  test("a missing settings file is an empty env, no env block likewise", () => {
    expect(gatherFacts(edgeAt("absent.json"), null).claudeSettingsEnv).toEqual({});
    const edge = writeSettings("settings.json", `{ "model": "opus" }`);
    expect(gatherFacts(edge, null).claudeSettingsEnv).toEqual({});
  });

  // [LAW:no-silent-failure] Unparseable is thrown, never read as empty — the
  // fix would otherwise splice into a file it cannot parse either.
  test("an unparseable settings file throws", () => {
    const edge = writeSettings("settings.json", `{ "env": `);
    expect(() => gatherFacts(edge, null)).toThrow();
    const notObject = writeSettings("array.json", `[1, 2]`);
    expect(() => gatherFacts(notObject, null)).toThrow(/not a JSON object/);
    const badEnv = writeSettings("badenv.json", `{ "env": "yes" }`);
    expect(() => gatherFacts(badEnv, null)).toThrow(/`env` is not an object/);
  });

  test("the three hint states map to the three TmuxFacts arms; tmux is asked only inside", () => {
    expect(gatherFacts(edgeAt("absent.json"), undefined).tmux).toEqual({
      kind: "unreported",
    });
    expect(gatherFacts(edgeAt("absent.json"), null).tmux).toEqual({
      kind: "outside",
    });
    const asked: unknown[] = [];
    const edge = edgeAt("absent.json", (hint) => {
      asked.push(hint);
      return { kind: "ok", value: ["osc7", "RGB"] };
    });
    expect(gatherFacts(edge, HINT).tmux).toEqual({
      kind: "inside",
      hint: HINT,
      termfeatures: { kind: "ok", value: ["osc7", "RGB"] },
    });
    expect(asked).toEqual([HINT]);
  });
});
