// [LAW:verifiable-goals] brandon-client-hints-7ua's repro, on a REAL daemon and
// the REAL memento plugin: two sessions share one daemon, each running under a
// different Claude Code directory and memento config home, and the daemon's own
// environment names neither. Each session's ceiling cell must show, and its
// click must move, the memento ITS client reported — the daemon's env answers
// for whichever session happened to spawn it.
//
// Runs where memento is installed for this user, as
// test/memento-integration.test.ts does; elsewhere there is no plugin to
// drive, and the suite name says so rather than passing vacuously.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  click,
  findUrl,
  killAndWait,
  linkUrls,
  render,
  stripAnsi,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "./helpers/spawn-isolated-daemon";
import type { ClientHints } from "../src/daemon/protocol";
import { VERB_CEILING } from "../src/click/wire";
import { locateIn } from "../src/memento/edge";

jest.setTimeout(30_000);

const located = locateIn(
  path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"),
  "/nonexistent-project",
);
const root = located.kind === "ok" ? located.value : undefined;
const suite = root ? describe : describe.skip;

suite(`two Claude Code installs, one daemon (memento at ${root ?? "not installed — skipped"})`, () => {
  test("each session reads and moves the memento its own client reported", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-2inst");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-2inst-scratch-"));
    const dir = (name: string): string => {
      const d = path.join(scratch, name);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    const home = (name: string, ceiling: number): string => {
      const d = dir(name);
      fs.writeFileSync(path.join(d, "memento.conf"), `ceiling = ${ceiling}\n`);
      return d;
    };

    // The daemon's own environment: a Claude Code directory with no plugins,
    // and a memento config home no session below runs under.
    const daemonClaude = dir("claude-daemon");
    const daemonHome = home("memento-daemon", 111_000);
    // The other install: its registry names the host's memento.
    const zaiClaude = dir("claude-zai");
    fs.mkdirSync(path.join(zaiClaude, "plugins"));
    fs.writeFileSync(
      path.join(zaiClaude, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "memento@memento": [{ scope: "user", installPath: root }] } }),
    );
    const zaiHome = home("memento-zai", 222_000);
    const project = dir("project");

    const configDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json5"), `{ root: { h: ["ceiling"] } }`);

    const daemon = await spawnDaemonWithEnv({
      ...env,
      CLAUDE_CONFIG_DIR: daemonClaude,
      MEMENTO_CONFIG_HOME: daemonHome,
    });
    const ZAI: ClientHints = {
      claudeConfigDir: zaiClaude,
      mementoEnv: { MEMENTO_CONFIG_HOME: zaiHome },
    };
    const PLAIN: ClientHints = { claudeConfigDir: daemonClaude, mementoEnv: {} };
    // The reading is cached per scope and refreshed behind the render, so a
    // cell is awaited rather than read off one frame.
    const cell = async (sid: string, hints: ClientHints, want: string): Promise<string> => {
      const deadline = Date.now() + 10_000;
      let last = "";
      do {
        last = await render(sockPath, sid, project, hints);
        if (stripAnsi(last).includes(want)) return last;
      } while (Date.now() < deadline);
      throw new Error(`never rendered ${want}; last:\n${stripAnsi(last)}`);
    };

    try {
      // The zai session wears ITS install's memento, under ITS config home —
      // not the daemon's 111K, and not "no memento" as the daemon's registry says.
      const zai = await cell("zai-session", ZAI, "⌈ 222.0K");
      // A session under the plugin-less directory has no ceiling cell at all.
      expect(stripAnsi(await render(sockPath, "plain-session", project, PLAIN))).not.toContain("⌈");

      // The click carries no hints: the move runs under the ones the session's
      // last render recorded, so the layer lands in the zai config home.
      const plus = findUrl(linkUrls(zai), (effects) =>
        effects.some((e) => e.verb === VERB_CEILING && e.args.join(" ") === "zai-session set +100_000"),
      );
      await click(sockPath, plus!);
      expect(
        fs.readFileSync(path.join(zaiHome, "sessions", "zai-session", "memento.conf"), "utf8"),
      ).toContain("322000");
      expect(fs.existsSync(path.join(daemonHome, "sessions"))).toBe(false);
      await cell("zai-session", ZAI, "⌈ 322.0K");
    } finally {
      await killAndWait(daemon);
      removeTmpDirs();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
