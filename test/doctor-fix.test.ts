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
import {
  checkByName,
  TMUX_TRUECOLOR_VAR,
  type Fix,
} from "../src/doctor/checks";
import { applyFix, gatherFacts, type DoctorEdge } from "../src/doctor/edge";
import type { ClientHints } from "../src/daemon/protocol";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { DslConfig } from "../src/config/dsl-types";
import { placementDraftKey } from "../src/config/edit-chrome";
import { parseAndValidate } from "./helpers/parse-and-validate";

const FIX: Fix = {
  kind: "claude-settings",
  path: ["env", TMUX_TRUECOLOR_VAR],
  value: "1",
};
const HINT = { socket: "/tmp/tmux-501/default", pane: "%3", truecolor: null };
const loadsConfig = (config: DslConfig): DoctorEdge["loadConfig"] => () => ({
  layers: [],
  error: null,
  warning: null,
  unused: [],
  config,
});
const NO_TMUX: DoctorEdge = {
  probeTmux: () => {
    throw new Error("probeTmux must not run in this case");
  },
  remoteLogin: () => {
    throw new Error("remoteLogin must not run in this case");
  },
  fontInUse: () => {
    throw new Error("fontInUse must not run in this case");
  },
  loadConfig: loadsConfig(DEFAULT_DSL_CONFIG),
};
const NO_SESSION = (): string | null => null;
const ORIGIN = { projectDir: "/tmp/proj", cwd: "/tmp/proj", configFile: null };

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
  sessionPick: (key: string) => string | null = NO_SESSION,
) =>
({
    ...gatherFacts(edge, { tmux, claudeConfigDir: conf }, ORIGIN, sessionPick),
    urlHandler: { kind: "unsupported" } as const,
  });
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

describe("applyFix (claude-settings, env)", () => {
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

// brandon-effects-2gka.21e: the effectRefresh fix, end to end over a real file
// — a bar wearing an effect, a statusLine with no interval.
describe("applyFix (effectRefresh)", () => {
  const SHIMMERING = {
    ...NO_TMUX,
    loadConfig: loadsConfig({
      ...DEFAULT_DSL_CONFIG,
      globals: { ...DEFAULT_DSL_CONFIG.globals, effect: "shimmer" },
    }),
  };
  const check = checkByName("effectRefresh")!;

  test('inserts "refreshInterval": 1 beside the statusLine keys, every other byte kept, and a re-probe passes', () => {
    const before = `{
  "statusLine": {
    "type": "command",
    "command": "/usr/local/bin/cc-candybar"
  },
  "model": "opus"
}
`;
    const conf = writeSettings(before);
    const facts = factsIn(conf, null, SHIMMERING);
    const verdict = check.probe(facts);
    expect(verdict.ok).toBe(false);
    if (verdict.ok || verdict.fix === undefined) throw new Error("no fix");

    const after = applyFix(verdict.fix, facts);
    const text = fs.readFileSync(settingsIn(conf), "utf8");
    expect(JSON.parse(text)).toEqual({
      statusLine: {
        type: "command",
        command: "/usr/local/bin/cc-candybar",
        refreshInterval: 1,
      },
      model: "opus",
    });
    assertOnlyInserted(before, text, /,\s*"refreshInterval": 1/);
    expect(check.probe(after)).toEqual({ ok: true });
  });

  test("a longer interval is overwritten in place", () => {
    const before = `{ "statusLine": { "type": "command", "command": "x", "refreshInterval": 5 } }\n`;
    const conf = writeSettings(before);
    const facts = factsIn(conf, null, SHIMMERING);
    const verdict = check.probe(facts);
    if (verdict.ok || verdict.fix === undefined) throw new Error("no fix");
    applyFix(verdict.fix, facts);
    expect(fs.readFileSync(settingsIn(conf), "utf8")).toBe(
      before.replace('"refreshInterval": 5', '"refreshInterval": 1'),
    );
  });
});

describe("gatherFacts", () => {
  test("reads the env block and the statusLine entry of settings.json", () => {
    const conf = writeSettings(
      `{ "env": { "FORCE_COLOR": "3" }, "statusLine": { "command": "x", "refreshInterval": 5 }, "model": "opus" }`,
    );
    expect(factsOf(conf).claudeSettings).toEqual({
      path: settingsIn(conf),
      env: { FORCE_COLOR: "3" },
      statusLine: { kind: "present", refreshInterval: 5 },
    });
  });

  test("a file with no statusLine says so; one with no interval carries none", () => {
    expect(factsOf(configDir("absent")).claudeSettings.statusLine).toEqual({
      kind: "absent",
    });
    expect(
      factsOf(writeSettings(`{ "statusLine": { "command": "x" } }`))
        .claudeSettings.statusLine,
    ).toEqual({ kind: "present", refreshInterval: undefined });
  });

  // The effect is the render's own resolution: the session's pick over the
  // config's, a rule kept as a rule.
  test("the effect is the session's pick over the config default, a rule kept as a rule", () => {
    const absent = configDir("absent");
    const configured = (effect: string): DoctorEdge => ({
      ...NO_TMUX,
      loadConfig: loadsConfig({
        ...DEFAULT_DSL_CONFIG,
        globals: { ...DEFAULT_DSL_CONFIG.globals, effect },
      }),
    });
    expect(factsIn(absent, null).effect).toEqual({
      kind: "decided",
      name: "none",
      value: "none",
    });
    expect(factsIn(absent, null, configured("pulse")).effect).toMatchObject({
      kind: "decided",
      name: "pulse",
    });
    expect(
      factsIn(absent, null, configured("pulse"), (key) =>
        key === "effect" ? "none" : null,
      ).effect,
    ).toMatchObject({ kind: "decided", name: "none" });
    const rule = "{{ if .busy }}shimmer{{ else }}none{{ end }}";
    expect(factsIn(absent, null, configured(rule)).effect).toEqual({
      kind: "expression",
      source: rule,
    });
  });

  // A placement's own effect, read as the render reads it: the session's
  // unsaved pick over the file's value, `bar` and `none` moving nothing.
  test("placement effects are each placement's own, the session's pick over the file's", () => {
    const absent = configDir("absent");
    const edge: DoctorEdge = {
      ...NO_TMUX,
      loadConfig: loadsConfig(
        parseAndValidate(
          "/tmp/proj/.cc-candybar.json5",
          `{
            segments: { a: { template: "a" } },
            root: { h: ["a", { seg: "a", id: "b", settings: { effect: "pulse" } }] },
          }`,
        ),
      ),
    };
    const pick =
      (picks: Record<string, string>) =>
      (key: string): string | null =>
        picks[key] ?? null;
    const draft = (id: string) => placementDraftKey("default", id, "effect");
    const effectsOf = (picks: Record<string, string>) =>
      [...factsIn(absent, null, edge, pick(picks)).placementEffects].sort(
        (x, y) => x.placement.localeCompare(y.placement),
      );
    expect(effectsOf({})).toEqual([{ placement: "b", effect: "pulse" }]);
    expect(effectsOf({ [draft("a")]: "shimmer" })).toEqual([
      { placement: "a", effect: "shimmer" },
      { placement: "b", effect: "pulse" },
    ]);
    expect(effectsOf({ [draft("b")]: "bar" })).toEqual([]);
    expect(effectsOf({ [draft("b")]: "none" })).toEqual([]);
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

  // A statusLine that is not an object concerns one check, so it is a fact
  // that check reads — every other verdict still runs.
  test.each([[`"x"`, "x"], ["null", null]])(
    "a statusLine of %s is its own arm, not a throw",
    (text, value) => {
      const conf = writeSettings(`{ "statusLine": ${text} }`, "badline");
      expect(factsOf(conf).claudeSettings.statusLine).toEqual({
        kind: "not-an-object",
        value,
      });
    },
  );

  test("the three hint states map to the three TmuxFacts arms; tmux is asked only inside", () => {
    const absent = configDir("absent");
    expect(factsIn(absent, undefined).tmux).toEqual({ kind: "unreported" });
    expect(factsIn(absent, null).tmux).toEqual({ kind: "outside" });
    const asked: unknown[] = [];
    const edge: DoctorEdge = {
      probeTmux: (hint) => {
        asked.push(hint);
        return {
          kind: "ok",
          value: { features: ["osc7", "RGB"], termtype: "", termname: "", pid: 4242 },
        };
      },
      remoteLogin: NO_TMUX.remoteLogin,
      fontInUse: NO_TMUX.fontInUse,
      loadConfig: NO_TMUX.loadConfig,
    };
    expect(factsIn(absent, HINT, edge).tmux).toEqual({
      kind: "inside",
      hint: HINT,
      client: {
        kind: "ok",
        value: { features: ["osc7", "RGB"], termtype: "", termname: "", pid: 4242 },
      },
    });
    expect(asked).toEqual([HINT]);
  });
});
