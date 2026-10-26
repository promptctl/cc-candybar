// [LAW:verifiable-goals] The fit check: memento's plugin, shaped exactly as
// memento will ship it, installed in the user's plugin root of a REAL daemon,
// with a stand-in for memento's `ceiling` command. It proves the plugin API
// carries the ceiling with nothing memento-specific in cc-candybar: the plugin
// loads, its segment hides until memento has written the session's file, shows
// the ceiling and memento's refusal from that file, and each of its four
// moves runs the command with the session's own facts — never the daemon's —
// and the bar shows what the command wrote.
//
// `.plugins.memento.*` is the plugin's namespace; the bar's own memento
// integration reads `.memento.*`, so the two never meet.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hookData, killAndWait, linkUrls, renderRequest, sendClick, stripAnsi } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { loggedWhen } from "./helpers/daemon-log";
import { effectsOf } from "./helpers/click";
import { VERB_RUN, type EvaluatedRun } from "../src/click/wire";

jest.setTimeout(30_000);

const SESSION = "0b6c3a4e-5d1f-4a7e-9c2b-8e1f0a3d5c71";
const SOURCE = `{ scope: "session", refresh: { watch: true }, read: { file: { json: true } } }`;

// memento's plugin as the plan shows it: the session's status file, a
// `ceiling` segment gated on it, and four moves, each handed the session and
// memento's config home and each refreshing the status.
const move = (args: string): string =>
  `{ run: ["./memento", "ceiling", ${args}, "--session", "{{ .session.id }}"], env: { MEMENTO_CONFIG_HOME: "{{ .plugins.memento.status.home }}" }, refreshes: ["status"] }`;
const DEFINITION = `{
  sources: { status: ${SOURCE} },
  segments: {
    ceiling: {
      description: "This session's context ceiling, and the moves that change it",
      when: '{{ hasKey .plugins.memento "status" }}',
      template: '{{ $s := .plugins.memento.status }}{{ if hasKey $s "refusal" }}ceiling refused: {{ $s.refusal }}{{ else }}ceiling={{ $s.ceiling }}{{ end }} {{ action "plugins.memento.raise" "[+]" }}{{ action "plugins.memento.lower" "[-]" }}{{ action "plugins.memento.off" "[off]" }}{{ action "plugins.memento.clear" "[clear]" }}',
    },
  },
  actions: {
    raise: ${move(`"set", "session", "+100_000"`)},
    lower: ${move(`"set", "session", "-100_000"`)},
    off: ${move(`"set", "session", "off"`)},
    clear: ${move(`"clear", "session"`)},
  },
}`;

// The project's ceiling, which applies when the session has no layer of its
// own.
const PROJECT_CEILING = 400_000;

// The stand-in for memento's `ceiling` command: it records what it was given
// (its arguments, its session variables, its directory) in memento's config
// home, keeps the session's own layer there, and rewrites the session's status
// file whole, by rename, as memento does after every move.
const standIn = (): string => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const home = process.env.MEMENTO_CONFIG_HOME;
const seen = (n) => (n in process.env ? process.env[n] : null);
fs.appendFileSync(
  path.join(home, "calls.jsonl"),
  JSON.stringify({
    argv,
    cwd: process.cwd(),
    env: Object.fromEntries(
      ["MEMENTO_CONFIG_HOME", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "TMUX", "TMUX_PANE"].map((n) => [n, seen(n)]),
    ),
  }) + "\\n",
);
const sid = argv[argv.indexOf("--session") + 1];
const layerFile = path.join(home, "layer-" + sid + ".json");
const layer = fs.existsSync(layerFile) ? JSON.parse(fs.readFileSync(layerFile, "utf8")) : null;
const next =
  argv[1] === "clear"
    ? null
    : argv[3] === "off"
      ? "off"
      : (typeof layer === "number" ? layer : ${PROJECT_CEILING}) + Number(argv[3].replace(/_/g, ""));
fs.writeFileSync(layerFile, JSON.stringify(next));
const doc = { home, ceiling: next === null ? ${PROJECT_CEILING} : next, off: next === "off", session: next };
fs.mkdirSync("session", { recursive: true });
fs.writeFileSync("session/." + sid + ".tmp", JSON.stringify(doc));
fs.renameSync("session/." + sid + ".tmp", "session/" + sid + ".json");
`;

interface Call {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | null>>;
}

describe("memento's plugin, as memento will ship it, on a real daemon", () => {
  let env: NodeJS.ProcessEnv;
  let sockPath: string;
  let removeTmpDirs: () => void;
  let root: string;
  let projectDir: string;
  let claudeDir: string;
  let mementoHome: string;
  let folder: string;
  let config: string;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-memento-fit");
    ({ sockPath, env, removeTmpDirs } = prepared);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-memento-fit-")));
    projectDir = path.join(root, "project");
    claudeDir = path.join(root, "claude");
    mementoHome = path.join(root, "memento-home");
    for (const d of [projectDir, claudeDir, mementoHome]) fs.mkdirSync(d);
    folder = path.join(root, "data", "cc-candybar", "plugins", "memento");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "plugin.json5"), DEFINITION);
    fs.writeFileSync(path.join(folder, "memento"), standIn(), { mode: 0o755 });
    config = path.join(projectDir, "config.json5");
    fs.writeFileSync(
      config,
      `{ segments: { mine: { template: "mine" } }, root: { h: ["mine", "plugins.memento.ceiling"] } }`,
    );
    // The daemon was spawned by some other session's shell: its session
    // variables are that session's, and must never reach this one's program.
    daemon = await spawnDaemonWithEnv({
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
    if (daemon) await killAndWait(daemon);
    fs.rmSync(root, { recursive: true, force: true });
    removeTmpDirs();
  });

  // The session's request: its hook JSON, and the Claude Code directory its
  // client reports.
  const renderRaw = (): Promise<string> =>
    renderRequest(sockPath, {
      hookData: hookData(SESSION, projectDir),
      args: ["cc-candybar", "--config", config],
      cwd: projectDir,
      claudeConfigDir: claudeDir,
    });

  const renderUntil = async (shows: (bar: string) => boolean, what: string): Promise<string> => {
    let bar = "";
    for (let round = 0; round < 100; round++) {
      const raw = await renderRaw();
      bar = stripAnsi(raw);
      if (shows(bar)) return raw;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the bar never showed ${what}; last:\n${bar}`);
  };

  const storage = (): string => path.join(fs.realpathSync(folder), "session");

  // What memento's hooks write: the session's whole status, by rename, again
  // until the bar shows it (the folder's watch goes live after it opens).
  const mementoWrites = async (doc: object, shows: string): Promise<void> => {
    let bar = "";
    for (let round = 0; round < 50 && !bar.includes(shows); round++) {
      const tmp = path.join(storage(), `.${SESSION}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, path.join(storage(), `${SESSION}.json`));
      await new Promise((r) => setTimeout(r, 100));
      bar = stripAnsi(await renderRaw());
    }
    expect(bar).toContain(shows);
  };

  const calls = (): Call[] =>
    fs.existsSync(path.join(mementoHome, "calls.jsonl"))
      ? fs
          .readFileSync(path.join(mementoHome, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Call)
      : [];

  // The link the bar drew for a move, read out of its bytes.
  const moveLink = (rendered: string, action: string): { url: string; drawn: EvaluatedRun } => {
    for (const url of linkUrls(rendered)) {
      const run = effectsOf(url).find((e) => e.verb === VERB_RUN && e.args[1] === action);
      if (run !== undefined) return { url, drawn: JSON.parse(run.args[2]!) as EvaluatedRun };
    }
    throw new Error(`no ${action} link in ${JSON.stringify(rendered)}`);
  };

  test("it loads with nothing memento-specific, and its segment hides until memento writes the session's file", async () => {
    const bar = stripAnsi(await renderRaw());
    expect(bar).toContain("mine");
    expect(bar).not.toContain("ceiling");
    expect(bar).not.toContain("was not loaded");
    await loggedWhen(
      env,
      (lines) => lines.some((l) => l.includes("config load ") && l.includes(" plugins loaded=1 sources=1 ")),
      "the config-load event loading memento's plugin and its source",
    );
    expect(fs.existsSync(path.join(storage(), `${SESSION}.json`))).toBe(false);
  });

  test("it shows the ceiling from the file, and memento's refusal when the file carries one", async () => {
    await mementoWrites(
      { home: mementoHome, ceiling: PROJECT_CEILING, off: false, refusal: "the session's layer is unreadable" },
      "ceiling refused: the session's layer is unreadable",
    );
    await mementoWrites({ home: mementoHome, ceiling: PROJECT_CEILING, off: false, session: null }, `ceiling=${PROJECT_CEILING}`);
  });

  test.each([
    ["raise", ["set", "session", "+100_000"], "ceiling=500000"],
    ["lower", ["set", "session", "-100_000"], `ceiling=${PROJECT_CEILING}`],
    ["off", ["set", "session", "off"], "ceiling=off"],
    ["clear", ["clear", "session"], `ceiling=${PROJECT_CEILING}`],
  ])(
    "%s runs memento's command with the session's facts, and the bar shows what it wrote",
    async (action, args, shows) => {
      const before = calls().length;
      const { url, drawn } = moveLink(await renderRaw(), `plugins.memento.${action}`);
      expect(drawn).toEqual({
        run: ["./memento", "ceiling", ...args, "--session", SESSION],
        env: { MEMENTO_CONFIG_HOME: mementoHome },
      });

      expect(await sendClick(sockPath, url)).toMatchObject({ ok: true });
      await renderUntil((b) => calls().length > before && b.includes(shows), `${action}'s write`);

      expect(calls().slice(before)).toEqual([
        {
          argv: ["ceiling", ...args, "--session", SESSION],
          // The directory of the file that declares the action.
          cwd: fs.realpathSync(folder),
          env: {
            MEMENTO_CONFIG_HOME: mementoHome,
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
