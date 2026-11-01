// [LAW:verifiable-goals] The fit check: a plugin another program ships,
// installed in the user's plugin root of a daemon, shaped as such a
// program ships one: a session status file it writes, a segment gated on that
// file, and moves that run the program the session's own status names. It
// proves the plugin API carries all of it with nothing program-specific in
// cc-candybar: the plugin loads, its segment hides until the program has
// written the session's file, shows the value and the program's refusal from
// that file, and each of its four moves runs the program with the session's
// own facts — never the daemon's — and the bar shows what the program wrote.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf, type Frame } from "../src/render/frame";
import { frameRequest, hookData, sendClick } from "./helpers/daemon-e2e";
import { barOf } from "./helpers/drawn-frame";
import { linkUrls } from "./helpers/frame";
import { startDaemon, type InWorkerDaemon } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";
import { loggedWhen } from "./helpers/daemon-log";
import { effectsOf } from "./helpers/click";
import { until } from "./helpers/until";
import { untilHeard } from "./helpers/reload-signal";
import { VERB_RUN, type EvaluatedRun } from "../src/click/wire";

jest.setTimeout(30_000);

const SESSION = "0b6c3a4e-5d1f-4a7e-9c2b-8e1f0a3d5c71";
const SOURCE = `{ scope: "session", refresh: { watch: true }, read: { file: { json: true } } }`;

// The plugin: the session's status file, a `limit` segment gated on it, and
// four moves, each running the program the status names with the program's
// home from the status, and each refreshing the status. The session is the
// one the click's session variables name, so no argument names it again.
const move = (args: string): string =>
  `{ run: ["{{ .plugins.gauge.status.command }}", ${args}], env: { GAUGE_HOME: "{{ .plugins.gauge.status.home }}" }, refreshes: ["status"] }`;
const DEFINITION = `{
  sources: { status: ${SOURCE} },
  segments: {
    limit: {
      description: "This session's limit, and the moves that change it",
      when: '{{ hasKey .plugins.gauge "status" }}',
      template: '{{ $s := .plugins.gauge.status }}{{ if hasKey $s "refusal" }}limit refused: {{ $s.refusal }}{{ else }}limit={{ $s.limit }}{{ end }} {{ action "plugins.gauge.raise" "[+]" }}{{ action "plugins.gauge.lower" "[-]" }}{{ action "plugins.gauge.off" "[off]" }}{{ action "plugins.gauge.clear" "[clear]" }}',
    },
  },
  actions: {
    raise: ${move(`"set", "session", "+100_000"`)},
    lower: ${move(`"set", "session", "-100_000"`)},
    off: ${move(`"set", "session", "off"`)},
    clear: ${move(`"clear", "session"`)},
  },
}`;

// The project's limit, which applies when the session has no layer of its own.
const PROJECT_LIMIT = 400_000;

// The program, installed in its own directory outside the plugin's folder: it
// records what it was given (its arguments, its session variables, its
// directory) in its home, keeps the session's own layer there, and rewrites
// the session's status file whole, by rename, after every move, naming
// itself.
const standIn = (): string => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const home = process.env.GAUGE_HOME;
const seen = (n) => (n in process.env ? process.env[n] : null);
fs.appendFileSync(
  path.join(home, "calls.jsonl"),
  JSON.stringify({
    argv,
    cwd: process.cwd(),
    env: Object.fromEntries(
      ["GAUGE_HOME", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "TMUX", "TMUX_PANE"].map((n) => [n, seen(n)]),
    ),
  }) + "\\n",
);
const sid = process.env.CLAUDE_CODE_SESSION_ID;
const layerFile = path.join(home, "layer-" + sid + ".json");
const layer = fs.existsSync(layerFile) ? JSON.parse(fs.readFileSync(layerFile, "utf8")) : null;
const next =
  argv[0] === "clear"
    ? null
    : argv[2] === "off"
      ? "off"
      : (typeof layer === "number" ? layer : ${PROJECT_LIMIT}) + Number(argv[2].replace(/_/g, ""));
fs.writeFileSync(layerFile, JSON.stringify(next));
const doc = { home, command: __filename, limit: next === null ? ${PROJECT_LIMIT} : next, session: next };
fs.mkdirSync("session", { recursive: true });
fs.writeFileSync("session/." + sid + ".tmp", JSON.stringify(doc));
fs.renameSync("session/." + sid + ".tmp", "session/" + sid + ".json");
`;

interface Call {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | null>>;
}

describe("another program's plugin, as such a program ships it, on a daemon", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let root: string;
  let projectDir: string;
  let claudeDir: string;
  let gaugeHome: string;
  let program: string;
  let folder: string;
  let config: string;
  let daemon: InWorkerDaemon;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-plugin-fit");
    ({ env, removeTmpDirs } = prepared);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-plugin-fit-")));
    projectDir = path.join(root, "project");
    claudeDir = path.join(root, "claude");
    gaugeHome = path.join(root, "gauge-home");
    for (const d of [projectDir, claudeDir, gaugeHome]) fs.mkdirSync(d);
    program = path.join(root, "gauge-install", "bin", "gauge");
    fs.mkdirSync(path.dirname(program), { recursive: true });
    fs.writeFileSync(program, standIn(), { mode: 0o755 });
    folder = path.join(root, "data", "cc-candybar", "plugins", "gauge");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "plugin.json5"), DEFINITION);
    config = path.join(projectDir, "config.json5");
    fs.writeFileSync(
      config,
      `{ segments: { mine: { template: "mine" } }, root: { h: ["mine", "plugins.gauge.limit"] } }`,
    );
    // The daemon was spawned by some other session's shell: its session
    // variables are that session's, and must never reach this one's program.
    daemon = startDaemon({
      ...prepared.env,
      XDG_DATA_HOME: path.join(root, "data"),
      CLAUDE_CODE_SESSION_ID: "the-daemon-spawners-session",
      CLAUDE_PROJECT_DIR: "/the/daemon/spawners/project",
      CLAUDE_CONFIG_DIR: "/the/daemon/spawners/.claude",
      TMUX: "/tmp/the-daemon-spawners-tmux,1,0",
      TMUX_PANE: "%99",
    });
  });

  afterAll(async () => {
    await daemon?.stop();
    fs.rmSync(root, { recursive: true, force: true });
    removeTmpDirs();
  });

  // The session's request: its hook JSON, and the Claude Code directory its
  // client reports.
  const renderRaw = (): Promise<Frame> =>
    frameRequest(daemon, {
      hookData: hookData(SESSION, projectDir),
      args: ["cc-candybar", "--config", config],
      cwd: projectDir,
      claudeConfigDir: claudeDir,
    });

  const renderUntil = async (shows: (bar: string) => boolean, what: string): Promise<Frame> => {
    let raw = barOf();
    await until(
      async () => shows(textOf((raw = await renderRaw()))),
      () => `the bar showing ${what}; last:\n${textOf(raw)}`,
      10_000,
    );
    return raw;
  };

  const storage = (): string => path.join(fs.realpathSync(folder), "session");

  // What the program writes outside a click: the session's whole status, by
  // rename, again until the bar shows it (the folder's watch goes live after
  // it opens).
  const programWrites = async (doc: object, shows: string): Promise<void> => {
    let bar = "";
    await untilHeard(
      () => {
        const tmp = path.join(storage(), `.${SESSION}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(doc));
        fs.renameSync(tmp, path.join(storage(), `${SESSION}.json`));
      },
      async () => {
        bar = textOf(await renderRaw());
        return bar.includes(shows);
      },
      () => `the bar showing ${shows}; last:\n${bar}`,
    );
  };

  const calls = (): Call[] =>
    fs.existsSync(path.join(gaugeHome, "calls.jsonl"))
      ? fs
          .readFileSync(path.join(gaugeHome, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Call)
      : [];

  // The link the bar drew for a move, read off its frame.
  const moveLink = (rendered: Frame, action: string): { url: string; drawn: EvaluatedRun } => {
    for (const url of linkUrls(rendered)) {
      const run = effectsOf(url).find((e) => e.verb === VERB_RUN && e.args[1] === action);
      if (run !== undefined) return { url, drawn: JSON.parse(run.args[2]!) as EvaluatedRun };
    }
    throw new Error(`no ${action} link in ${JSON.stringify(rendered)}`);
  };

  test("it loads, and its segment hides until the program writes the session's file", async () => {
    const bar = textOf(await renderRaw());
    expect(bar).toContain("mine");
    expect(bar).not.toContain("limit");
    expect(bar).not.toContain("was not loaded");
    await loggedWhen(
      env,
      (lines) => lines.some((l) => l.includes("config load ") && l.includes(" plugins loaded=1 sources=1 ")),
      "the config-load event loading the plugin and its source",
    );
    expect(fs.existsSync(path.join(storage(), `${SESSION}.json`))).toBe(false);
  });

  test("it shows the value from the file, and the program's refusal when the file carries one", async () => {
    await programWrites(
      { home: gaugeHome, command: program, refusal: "the session's layer is unreadable" },
      "limit refused: the session's layer is unreadable",
    );
    await programWrites({ home: gaugeHome, command: program, limit: PROJECT_LIMIT, session: null }, `limit=${PROJECT_LIMIT}`);
  });

  test.each([
    ["raise", ["set", "session", "+100_000"], "limit=500000"],
    ["lower", ["set", "session", "-100_000"], `limit=${PROJECT_LIMIT}`],
    ["off", ["set", "session", "off"], "limit=off"],
    ["clear", ["clear", "session"], `limit=${PROJECT_LIMIT}`],
  ])(
    "%s runs the program the session's status names, with the session's facts, and the bar shows what it wrote",
    async (action, args, shows) => {
      const before = calls().length;
      const { url, drawn } = moveLink(await renderRaw(), `plugins.gauge.${action}`);
      expect(drawn).toEqual({
        run: [program, ...args],
        env: { GAUGE_HOME: gaugeHome },
      });

      expect(await sendClick(daemon, url)).toMatchObject({ ok: true });
      await renderUntil((b) => calls().length > before && b.includes(shows), `${action}'s write`);

      expect(calls().slice(before)).toEqual([
        {
          argv: args,
          // The directory of the file that declares the action.
          cwd: fs.realpathSync(folder),
          env: {
            GAUGE_HOME: gaugeHome,
            CLAUDE_CODE_SESSION_ID: SESSION,
            CLAUDE_PROJECT_DIR: projectDir,
            CLAUDE_CONFIG_DIR: claudeDir,
            TMUX: null,
            TMUX_PANE: null,
          },
        },
      ]);
    },
  );
});
