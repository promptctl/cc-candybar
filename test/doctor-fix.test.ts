import { execFileSync } from "node:child_process";
// [LAW:verifiable-goals] brandon-doctor-b6a acceptance 2: the fix over a
// settings.json WITH an existing `env` block and WITHOUT one changes exactly
// the one key, and every other byte of the user's file survives. The edge is
// driven with a fake DoctorEdge whose tmux probe throws, so the settings.json
// side is exercised alone — and the gatherFacts cases pin that the probe is
// only ever asked when there is a server to ask. The settings file is the one
// in the Claude Code directory the client's `claudeConfigDir` hint names.

import { EMPTY_STORES, emptyStores, healthyDaemonEdge, healthyDataEdge, noManagedSettings, HEALTHY_SERVING, HEALTHY_INSTALL_EDGE, HEALTHY_FACTS, CARRIED, NAMED, STILL, drew, sightedIn } from "./helpers/doctor-facts";
import type { FrameSighting } from "../src/daemon/render-sightings";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkByName,
  TMUX_TRUECOLOR_VAR,
  type Asked,
  type DoctorFacts,
  type Fix,
  statusLineOf,
  envVarOf,
} from "../src/doctor/checks";
import { applyFix, gatherFacts, type DoctorEdge } from "../src/doctor/edge";
import type { ClientHints } from "../src/daemon/protocol";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { DslConfig } from "../src/config/dsl-types";

// The tmuxTruecolor fix, into the user settings file of `conf`.
const fixIn = (conf: string): Fix => ({
  kind: "claude-settings",
  file: { scope: "user", path: path.join(conf, "settings.json") },
  path: ["env", TMUX_TRUECOLOR_VAR],
  value: "1",
});
const HINT = { socket: "/tmp/tmux-501/default", pane: "%3", truecolor: null };
const loadsConfig = (config: DslConfig): DoctorEdge["loadConfig"] => () => ({
  layers: [],
  error: null,
  warning: null,
  unused: [],
  config,
});
const NO_TMUX: DoctorEdge = {
  install: HEALTHY_INSTALL_EDGE,
  ...healthyDaemonEdge(),
  ...healthyDataEdge(),
  ...noManagedSettings(),
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
// The session's project, whose .claude/ settings outrank the user file.
const projectDir = (): string => path.join(dir, "proj");

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
  // The bars of a session in the project, under `conf` — so they read the
  // settings chain the run reads itself.
  bars: readonly FrameSighting[] = STILL,
) =>
({
    ...gatherFacts(
      edge,
      { tmux, claudeConfigDir: conf },
      { projectDir: projectDir(), cwd: projectDir(), target: { source: "search" } },
      sessionPick,
      { kind: "ok", value: HEALTHY_SERVING },
      CARRIED,
      NAMED,
      { kind: "recent" },
      sightedIn(projectDir(), conf, bars),
      HEALTHY_FACTS.width,
      EMPTY_STORES,
    ),
    urlHandler: { kind: "unsupported" } as const,
    install: HEALTHY_FACTS.install,
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

// The facts a fix answers with, failing the test on a refused fix.
function fixed(after: Asked<DoctorFacts>): DoctorFacts {
  if (after.kind === "failed") throw new Error(`fix refused: ${after.reason}`);
  return after.value;
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
    const facts = fixed(applyFix(emptyStores(), fixIn(conf), factsOf(conf)));
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
    expect(envVarOf(facts.claudeSettings.origin.sources, TMUX_TRUECOLOR_VAR)).toEqual({
      kind: "ok",
      value: { kind: "set", value: "1", from: { scope: "user", path: settingsIn(conf) } },
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
    applyFix(emptyStores(), fixIn(conf), factsOf(conf));
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
    applyFix(emptyStores(), fixIn(conf), factsOf(conf));
    const after = fs.readFileSync(settingsIn(conf), "utf8");
    expect(after).toBe(`{ "env": { "${TMUX_TRUECOLOR_VAR}": "1" } }\n`);
  });

  test("no settings file: the file (and its directory) is created", () => {
    const conf = configDir(path.join("nested", "claude"));
    applyFix(emptyStores(), fixIn(conf), factsOf(conf));
    expect(JSON.parse(fs.readFileSync(settingsIn(conf), "utf8"))).toEqual({
      env: { [TMUX_TRUECOLOR_VAR]: "1" },
    });
  });
});

// brandon-effects-2gka.21e: the effectRefresh fix, end to end over a real file
// — a bar that moves, a statusLine with no interval.
describe("applyFix (effectRefresh)", () => {
  const MOVING = drew("moves");
  const check = checkByName("effectRefresh")!;

  test('inserts "refreshInterval": 1 beside the statusLine keys, every other byte kept, and the re-probe names the file', () => {
    const before = `{
  "statusLine": {
    "type": "command",
    "command": "/usr/local/bin/cc-candybar"
  },
  "model": "opus"
}
`;
    const conf = writeSettings(before);
    const facts = factsIn(conf, null, NO_TMUX, NO_SESSION, MOVING);
    const verdict = check.probe(facts);
    expect(verdict.ok).toBe(false);
    if (verdict.ok || verdict.fix === undefined) throw new Error("no fix");

    const after = fixed(applyFix(emptyStores(), verdict.fix, facts));
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
    expect(check.probe(after)).toEqual({
      ok: true,
      note: `statusLine.refreshInterval is 1 in ${settingsIn(conf)}`,
    });
  });

  test("a longer interval is overwritten in place", () => {
    const before = `{ "statusLine": { "type": "command", "command": "x", "refreshInterval": 5 } }\n`;
    const conf = writeSettings(before);
    const facts = factsIn(conf, null, NO_TMUX, NO_SESSION, MOVING);
    const verdict = check.probe(facts);
    if (verdict.ok || verdict.fix === undefined) throw new Error("no fix");
    applyFix(emptyStores(), verdict.fix, facts);
    expect(fs.readFileSync(settingsIn(conf), "utf8")).toBe(
      before.replace('"refreshInterval": 5', '"refreshInterval": 1'),
    );
  });
});

// brandon-doctor-v62x.y5d: each bar sits in the settings chain its session
// reads — its project, its Claude Code directory's user file — each location
// read once, and a fix re-reads every chain, so the one holding the file it
// wrote is judged on what the file now holds.
describe("gatherFacts: a settings chain per location", () => {
  const otherProject = (): string => path.join(dir, "other");
  // The facts of a run in the project under `conf`, whose bars are `sighted`.
  const withBars = (conf: string, ...sighted: (readonly [string, readonly FrameSighting[]])[]) => ({
    ...gatherFacts(
      NO_TMUX,
      { tmux: null, claudeConfigDir: conf },
      { projectDir: projectDir(), cwd: projectDir(), target: { source: "search" } },
      NO_SESSION,
      { kind: "ok", value: HEALTHY_SERVING },
      CARRIED,
      NAMED,
      { kind: "recent" },
      {
        kind: "ok",
        value: sighted.flatMap(([project, bars]) => {
          const asked = sightedIn(project, conf, bars);
          return asked.kind === "ok" ? asked.value : [];
        }),
      },
      HEALTHY_FACTS.width,
      EMPTY_STORES,
    ),
    urlHandler: { kind: "unsupported" } as const,
    install: HEALTHY_FACTS.install,
  });

  test("bars of the run's own location sit in its chain; another project's, in one of their own", () => {
    const conf = writeSettings(`{ "statusLine": { "command": "x" } }`);
    const facts = withBars(
      conf,
      [projectDir(), drew("still")],
      [otherProject(), drew("moves")],
      [otherProject(), drew("can-move")],
    );
    const { origin, elsewhere } = facts.claudeSettings;
    expect(origin.at.projectDir).toBe(projectDir());
    expect(origin.bars.map((b) => b.frame)).toEqual(["still"]);
    expect(elsewhere.map((c) => [c.at.projectDir, c.bars.map((b) => b.frame)])).toEqual([
      [otherProject(), ["moves", "can-move"]],
    ]);
    expect(facts.frames).toEqual({ kind: "read" });
  });

  test("a fix in another project's file is what that chain judges next", () => {
    const conf = writeSettings(`{ "model": "opus" }`);
    const local = path.join(otherProject(), ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, `{ "statusLine": { "command": "x" } }\n`);
    const facts = withBars(conf, [otherProject(), drew("moves")]);
    const check = checkByName("effectRefresh")!;
    const verdict = check.probe(facts);
    if (verdict.ok || verdict.fix === undefined) throw new Error("no fix");
    expect(verdict.fix).toMatchObject({ file: { scope: "project-local", path: local } });
    expect(check.probe(fixed(applyFix(emptyStores(), verdict.fix, facts)))).toEqual({
      ok: true,
      note: `statusLine.refreshInterval is 1 in ${local}`,
    });
  });
});

describe("gatherFacts", () => {
  const sourcesOf = (conf: string, edge: DoctorEdge = NO_TMUX) =>
    factsIn(conf, null, edge).claudeSettings.origin.sources;
  const lineOf = (conf: string, edge: DoctorEdge = NO_TMUX) =>
    statusLineOf(sourcesOf(conf, edge));

  test("reads the env block and the statusLine entry of settings.json", () => {
    const conf = writeSettings(
      `{ "env": { "FORCE_COLOR": "3" }, "statusLine": { "command": "x", "refreshInterval": 5 }, "model": "opus" }`,
    );
    expect(envVarOf(sourcesOf(conf), "FORCE_COLOR")).toEqual({
      kind: "ok",
      value: { kind: "set", value: "3", from: { scope: "user", path: settingsIn(conf) } },
    });
    expect(lineOf(conf)).toEqual({
      kind: "present",
      refreshInterval: 5,
      from: { scope: "user", path: settingsIn(conf) },
    });
  });

  test("no file sets a statusLine: absent, naming the files read; one with no interval carries none", () => {
    expect(lineOf(configDir("absent"))).toEqual({ kind: "absent", read: [] });
    const model = writeSettings(`{ "model": "opus" }`, "model");
    expect(lineOf(model)).toEqual({ kind: "absent", read: [settingsIn(model)] });
    const conf = writeSettings(`{ "statusLine": { "command": "x" } }`);
    expect(lineOf(conf)).toEqual({
      kind: "present",
      refreshInterval: undefined,
      from: { scope: "user", path: settingsIn(conf) },
    });
  });

  test("a missing, blank, or env-less settings file leaves every variable unset", () => {
    const unset = { kind: "ok", value: { kind: "unset" } };
    const varOf = (conf: string) => envVarOf(sourcesOf(conf), TMUX_TRUECOLOR_VAR);
    expect(varOf(configDir("absent"))).toEqual(unset);
    expect(varOf(writeSettings(" \n", "blank"))).toEqual(unset);
    expect(varOf(writeSettings(`{ "model": "opus" }`))).toEqual(unset);
  });

  // [LAW:no-silent-failure] Unparseable is a failure naming the file, never
  // read as empty — the fix would otherwise splice into a file it cannot
  // parse either — and it fails the rows that read settings, not the run.
  test("an unparseable settings file is a failed chain naming it", () => {
    const conf = writeSettings(`{ "env": `);
    expect(sourcesOf(conf)).toEqual({
      kind: "failed",
      reason: expect.stringContaining(`cannot read ${settingsIn(conf)}`),
    });
    expect(sourcesOf(writeSettings(`[1, 2]`, "array"))).toMatchObject({
      reason: expect.stringMatching(/not a JSON object/),
    });
    expect(sourcesOf(writeSettings(`{ "env": "yes" }`, "badenv"))).toMatchObject({
      reason: expect.stringMatching(/`env` is not an object/),
    });
  });

  // A statusLine that is not an object concerns one check, so it is a fact
  // that check reads — every other verdict still runs.
  test.each([[`"x"`, "x"], ["null", null]])(
    "a statusLine of %s is its own arm, not a failure",
    (text, value) => {
      const conf = writeSettings(`{ "statusLine": ${text} }`, "badline");
      expect(lineOf(conf)).toEqual({
        kind: "not-an-object",
        value,
        from: { scope: "user", path: settingsIn(conf) },
      });
    },
  );

  // brandon-doctor-v62x.49w — Claude Code's order: managed (its drop-ins over
  // managed-settings.json, alphabetically later over earlier, hidden and
  // non-.json files skipped) > project-local > project > user.
  // A dotfiles-managed settings.json is a symlink: the fix writes the file
  // it points at, and the link stays a link.
  test("the fix writes through a symlinked settings file", () => {
    const conf = configDir("linked");
    fs.mkdirSync(conf, { recursive: true });
    const target = path.join(dir, "dotfiles-settings.json");
    fs.writeFileSync(target, JSON.stringify({ statusLine: { command: "cc-candybar" } }));
    fs.symlinkSync(target, settingsIn(conf));
    const facts = factsIn(conf, null, NO_TMUX, NO_SESSION, drew("moves"));
    const verdict = checkByName("effectRefresh")!.probe(facts);
    if (verdict.ok || verdict.fix === undefined) throw new Error("no fix");
    applyFix(emptyStores(), verdict.fix, facts);
    expect(fs.lstatSync(settingsIn(conf)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8")).statusLine.refreshInterval).toBe(1);
  });

  describe("the settings chain", () => {
    const managedDir = (): string => path.join(dir, "managed");
    const MANAGED: () => DoctorEdge = () => ({ ...NO_TMUX, managedSettingsDir: managedDir() });
    const put = (file: string, json: unknown): string => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json));
      return file;
    };
    const dropIn = (name: string) => path.join(managedDir(), "managed-settings.d", name);
    const line = (refreshInterval?: number) => ({
      statusLine: { command: "cc-candybar", ...(refreshInterval === undefined ? {} : { refreshInterval }) },
    });

    test("lists every file in precedence order, highest first", () => {
      const conf = writeSettings(JSON.stringify(line(5)));
      const files = [
        put(dropIn("20-b.json"), {}),
        put(dropIn("10-a.json"), {}),
        put(path.join(managedDir(), "managed-settings.json"), {}),
        put(path.join(projectDir(), ".claude", "settings.local.json"), {}),
        put(path.join(projectDir(), ".claude", "settings.json"), {}),
        settingsIn(conf),
      ];
      put(dropIn(".hidden.json"), line(9));
      put(dropIn("notes.txt"), line(9));
      const sources = sourcesOf(conf, MANAGED());
      if (sources.kind !== "ok") throw new Error(sources.reason);
      expect(sources.value.map((s) => [s.scope, s.path])).toEqual([
        ["managed", files[0]],
        ["managed", files[1]],
        ["managed", files[2]],
        ["project-local", files[3]],
        ["project", files[4]],
        ["user", files[5]],
      ]);
    });

    test("a managed drop-in's statusLine outranks the user file's", () => {
      const conf = writeSettings(JSON.stringify(line(5)));
      const managed = put(dropIn("10-dotfiles.json"), line(1));
      expect(lineOf(conf, MANAGED())).toEqual({
        kind: "present",
        refreshInterval: 1,
        from: { scope: "managed", path: managed },
      });
    });

    test("managed files merge key by key: the later drop-in's interval wins, and names its file", () => {
      put(path.join(managedDir(), "managed-settings.json"), line(1));
      put(dropIn("10-a.json"), { statusLine: { command: "cc-candybar" } });
      const later = put(dropIn("20-b.json"), { statusLine: { refreshInterval: 3 } });
      expect(lineOf(configDir("absent"), MANAGED())).toEqual({
        kind: "present",
        refreshInterval: 3,
        from: { scope: "managed", path: later },
      });
    });

    test("project-local outranks project, which outranks the user file", () => {
      const conf = writeSettings(JSON.stringify(line(9)));
      const shared = put(path.join(projectDir(), ".claude", "settings.json"), line(5));
      expect(lineOf(conf)).toMatchObject({ refreshInterval: 5, from: { scope: "project", path: shared } });
      const local = put(path.join(projectDir(), ".claude", "settings.local.json"), line(1));
      expect(lineOf(conf)).toMatchObject({ refreshInterval: 1, from: { scope: "project-local", path: local } });
    });

    // A session in the home directory names the user file as its project
    // file too: it is kept once, as the user's, so the fix may write it —
    // whichever spelling, a symlink included, names the config directory.
    test.each([
      ["the same path", () => path.join(projectDir(), ".claude")],
      ["a symlink to it", () => {
        fs.mkdirSync(path.join(projectDir(), ".claude"), { recursive: true });
        const link = path.join(dir, "home-link");
        fs.symlinkSync(path.join(projectDir(), ".claude"), link);
        return link;
      }],
    ])("a project whose .claude is the config dir reads its settings as the user's (%s)", (_, confOf) => {
      const conf = confOf();
      put(settingsIn(path.join(projectDir(), ".claude")), line());
      const sources = sourcesOf(conf);
      if (sources.kind !== "ok") throw new Error(sources.reason);
      expect(sources.value.map((s) => [s.scope, s.path])).toEqual([["user", settingsIn(conf)]]);
      const facts = factsIn(conf, null, NO_TMUX, NO_SESSION, drew("moves"));
      const verdict = checkByName("effectRefresh")!.probe(facts);
      expect(verdict).toMatchObject({ ok: false, fix: { file: { scope: "user", path: settingsIn(conf) } } });
    });

    // The ticket's repro: the variable set in a managed drop-in, read through
    // the real chain reader, is the highest file's, so the check names it.
    test("a managed drop-in's env outranks the user file's, key by key", () => {
      const conf = writeSettings(JSON.stringify({ env: { [TMUX_TRUECOLOR_VAR]: "", FORCE_COLOR: "3" } }));
      const managed = put(dropIn("10-dotfiles.json"), { env: { [TMUX_TRUECOLOR_VAR]: "1" } });
      const sources = sourcesOf(conf, MANAGED());
      expect(envVarOf(sources, TMUX_TRUECOLOR_VAR)).toEqual({
        kind: "ok",
        value: { kind: "set", value: "1", from: { scope: "managed", path: managed } },
      });
      expect(envVarOf(sources, "FORCE_COLOR")).toMatchObject({
        value: { from: { scope: "user" } },
      });
    });

    // The scope that sets statusLine wins it whole: a lower scope's
    // interval is not merged in (undocumented — the reading that can only
    // fail where it might pass).
    test("a higher scope's statusLine is not merged with a lower one's", () => {
      const conf = writeSettings(JSON.stringify(line(1)));
      const managed = put(dropIn("10-dotfiles.json"), line());
      expect(lineOf(conf, MANAGED())).toEqual({
        kind: "present",
        refreshInterval: undefined,
        from: { scope: "managed", path: managed },
      });
    });

    test("an unparseable managed file fails the chain, naming it", () => {
      const bad = dropIn("10-bad.json");
      fs.mkdirSync(path.dirname(bad), { recursive: true });
      fs.writeFileSync(bad, "{");
      expect(sourcesOf(configDir("absent"), MANAGED())).toEqual({
        kind: "failed",
        reason: expect.stringContaining(`cannot read ${bad}`),
      });
    });

    // A managed statusLine is the policy's to change: the fix is withheld,
    // and the managed file is never written.
    test("a managed winner offers no fix, and the file is left as it is", () => {
      const managed = put(dropIn("10-dotfiles.json"), line());
      const before = fs.readFileSync(managed, "utf8");
      const verdict = checkByName("effectRefresh")!.probe(
        factsIn(configDir("absent"), null, MANAGED(), NO_SESSION, drew("moves")),
      );
      expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining(`managed settings, ${managed}`) });
      expect(verdict.ok === false && verdict.fix).toBeUndefined();
      expect(fs.readFileSync(managed, "utf8")).toBe(before);
    });

    // [LAW:no-silent-failure] Only a missing file is absent: one that is
    // there but cannot be read is a file Claude Code may run with.
    test("an unreadable settings file fails the chain, naming it", () => {
      const locked = put(path.join(projectDir(), ".claude", "settings.json"), line(1));
      fs.chmodSync(locked, 0o000);
      try {
        expect(sourcesOf(configDir("absent"))).toEqual({
          kind: "failed",
          reason: expect.stringMatching(new RegExp(`^cannot read ${locked}: .*EACCES`)),
        });
      } finally {
        fs.chmodSync(locked, 0o644);
      }
    });

    // A FIFO where a settings file goes would hold the daemon's loop on a
    // blocking read: it is refused as no regular file, naming it.
    test("a settings path that is no regular file fails the chain, without blocking", () => {
      const fifo = path.join(projectDir(), ".claude", "settings.local.json");
      fs.mkdirSync(path.dirname(fifo), { recursive: true });
      execFileSync("mkfifo", [fifo]);
      expect(sourcesOf(configDir("absent"))).toEqual({
        kind: "failed",
        reason: `cannot read ${fifo}: not a regular file`,
      });
    });

    // No file can sit under a component that is not a directory: a project
    // whose `.claude` is a file has no project settings, as for Claude Code.
    test("a project whose .claude is a file contributes no source", () => {
      fs.mkdirSync(projectDir(), { recursive: true });
      fs.writeFileSync(path.join(projectDir(), ".claude"), "");
      expect(sourcesOf(configDir("absent"))).toEqual({ kind: "ok", value: [] });
    });

    // The fix writes the file the statusLine came from, and the re-read is
    // the whole chain's.
    test("a project-local winner's fix lands in that file, and the re-probe names it", () => {
      const conf = writeSettings(JSON.stringify(line()));
      const shared = put(path.join(projectDir(), ".claude", "settings.local.json"), line());
      const facts = factsIn(conf, null, NO_TMUX, NO_SESSION, drew("moves"));
      const check = checkByName("effectRefresh")!;
      const verdict = check.probe(facts);
      if (verdict.ok || verdict.fix === undefined) throw new Error("no fix");
      const after = fixed(applyFix(emptyStores(), verdict.fix, facts));
      expect(JSON.parse(fs.readFileSync(shared, "utf8")).statusLine.refreshInterval).toBe(1);
      expect(JSON.parse(fs.readFileSync(settingsIn(conf), "utf8"))).toEqual(line());
      expect(check.probe(after)).toEqual({
        ok: true,
        note: `statusLine.refreshInterval is 1 in ${shared}`,
      });
    });
  });

  test("the three hint states map to the three TmuxFacts arms; tmux is asked only inside", () => {
    const absent = configDir("absent");
    expect(factsIn(absent, undefined).tmux).toEqual({ kind: "unreported" });
    expect(factsIn(absent, null).tmux).toEqual({ kind: "outside" });
    const asked: unknown[] = [];
    const edge: DoctorEdge = {
      install: HEALTHY_INSTALL_EDGE,
      ...healthyDaemonEdge(),
      ...healthyDataEdge(),
      ...noManagedSettings(),
      probeTmux: (hint) => {
        asked.push(hint);
        return {
          kind: "ok",
          value: { features: ["osc7", "RGB"], termtype: "", termname: "", pid: 4242, utf8: true },
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
        value: { features: ["osc7", "RGB"], termtype: "", termname: "", pid: 4242, utf8: true },
      },
    });
    expect(asked).toEqual([HINT]);
  });
});
