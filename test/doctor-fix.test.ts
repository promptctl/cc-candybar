// [LAW:verifiable-goals] brandon-doctor-b6a acceptance 2: the fix over a
// settings.json WITH an existing `env` block and WITHOUT one changes exactly
// the one key, and every other byte of the user's file survives. The edge is
// driven with a fake DoctorEdge whose tmux probe throws, so the settings.json
// side is exercised alone — and the gatherFacts cases pin that the probe is
// only ever asked when there is a server to ask. The settings file is the one
// in the Claude Code directory the client's `claudeConfigDir` hint names.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TMUX_TRUECOLOR_VAR, type Fix } from "../src/doctor/checks";
import { applyFix, gatherFacts, type DoctorEdge } from "../src/doctor/edge";
import type { ClientHints } from "../src/daemon/protocol";

const FIX: Fix = { kind: "claude-settings-env", name: TMUX_TRUECOLOR_VAR, value: "1" };
const HINT = { socket: "/tmp/tmux-501/default", pane: "%3", truecolor: null };
const NO_TMUX: DoctorEdge = {
  probeTmux: () => {
    throw new Error("probeTmux must not run in this case");
  },
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A Claude Code configuration directory under the temp dir, and its file.
const configDir = (name = "claude"): string => path.join(dir, name);
const settingsIn = (conf: string): string => path.join(conf, "settings.json");

function writeSettings(text: string, name = "claude"): string {
  const conf = configDir(name);
  fs.mkdirSync(conf, { recursive: true });
  fs.writeFileSync(settingsIn(conf), text);
  return conf;
}

const factsIn = (
  conf: string,
  tmux: ClientHints["tmux"],
  edge: DoctorEdge = NO_TMUX,
) => gatherFacts(edge, { tmux, claudeConfigDir: conf });
// Outside tmux: the settings half alone.
const factsOf = (conf: string) => factsIn(conf, null);

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
    const conf = writeSettings(before);
    const facts = applyFix(FIX, factsOf(conf));
    const after = fs.readFileSync(settingsIn(conf), "utf8");
    expect(JSON.parse(after)).toEqual({
      permissions: { allow: ["Bash(ls:*)"] },
      env: {
        DISABLE_AUTOUPDATER: "1",
        FORCE_COLOR: "3",
        [TMUX_TRUECOLOR_VAR]: "1",
      },
      model: "opus",
    });
    expect(facts.claudeSettings.path).toBe(settingsIn(conf));
    expect(facts.claudeSettings.env).toEqual({
      DISABLE_AUTOUPDATER: "1",
      FORCE_COLOR: "3",
      [TMUX_TRUECOLOR_VAR]: "1",
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
    const conf = writeSettings(before);
    applyFix(FIX, factsOf(conf));
    const after = fs.readFileSync(settingsIn(conf), "utf8");
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
    const conf = writeSettings(before);
    applyFix(FIX, factsOf(conf));
    const after = fs.readFileSync(settingsIn(conf), "utf8");
    expect(after).toBe(`{ "env": { "${TMUX_TRUECOLOR_VAR}": "1" } }\n`);
  });

  test("no settings file: the file (and its directory) is created", () => {
    const conf = configDir(path.join("nested", "claude"));
    applyFix(FIX, factsOf(conf));
    expect(JSON.parse(fs.readFileSync(settingsIn(conf), "utf8"))).toEqual({
      env: { [TMUX_TRUECOLOR_VAR]: "1" },
    });
  });
});

describe("gatherFacts", () => {
  test("reads the env block of settings.json", () => {
    const conf = writeSettings(`{ "env": { "FORCE_COLOR": "3" }, "model": "opus" }`);
    expect(factsOf(conf).claudeSettings).toEqual({
      path: settingsIn(conf),
      env: { FORCE_COLOR: "3" },
    });
  });

  test("a missing, blank, or env-less settings file is an empty env", () => {
    expect(factsOf(configDir("absent")).claudeSettings.env).toEqual({});
    expect(factsOf(writeSettings(" \n", "blank")).claudeSettings.env).toEqual({});
    expect(factsOf(writeSettings(`{ "model": "opus" }`)).claudeSettings.env).toEqual({});
  });

  // [LAW:no-silent-failure] Unparseable is thrown, never read as empty — the
  // fix would otherwise splice into a file it cannot parse either.
  test("an unparseable settings file throws", () => {
    const conf = writeSettings(`{ "env": `);
    expect(() => factsOf(conf)).toThrow(`cannot read ${settingsIn(conf)}`);
    const notObject = writeSettings(`[1, 2]`, "array");
    expect(() => factsOf(notObject)).toThrow(/not a JSON object/);
    const badEnv = writeSettings(`{ "env": "yes" }`, "badenv");
    expect(() => factsOf(badEnv)).toThrow(/`env` is not an object/);
  });

  test("the three hint states map to the three TmuxFacts arms; tmux is asked only inside", () => {
    const absent = configDir("absent");
    expect(factsIn(absent, undefined).tmux).toEqual({ kind: "unreported" });
    expect(factsIn(absent, null).tmux).toEqual({ kind: "outside" });
    const asked: unknown[] = [];
    const edge: DoctorEdge = {
      probeTmux: (hint) => {
        asked.push(hint);
        return { kind: "ok", value: ["osc7", "RGB"] };
      },
    };
    expect(factsIn(absent, HINT, edge).tmux).toEqual({
      kind: "inside",
      hint: HINT,
      termfeatures: { kind: "ok", value: ["osc7", "RGB"] },
    });
    expect(asked).toEqual([HINT]);
  });
});
