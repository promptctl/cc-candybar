// [LAW:verifiable-goals] Measured the only way it means anything: a real daemon, a real
// config file, two sessions on one socket. A one-session test cannot see the claim.

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  click,
  killAndWait,
  render,
  stripAnsi,
  urlWriting,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// Declaring the controls here is what gates the writes to exactly these two keys.
const CONFIG_PADDING = 1;
const PADDING_WIDE = 4;
const FILLERS = ["f1", "f2", "f3", "f4", "f5", "f6"];

const USER_CONFIG = {
  globals: { padding: CONFIG_PADDING, autoWrap: true },
  // Literal `to:` writes, so this measures the resolution and not the stepper's seeding rule.
  actions: {
    padWide: { set: "padding", to: String(PADDING_WIDE) },
    wrapOff: { set: "autoWrap", to: "false" },
  },
  segments: {
    controls: {
      template:
        '{{ action "padWide" "[pad+]" }} {{ action "wrapOff" "[nowrap]" }}',
      bg: "surface",
      fg: "foreground",
    },
    // Fixed-width filler, wide enough that `autoWrap` has something to do.
    ...Object.fromEntries(
      FILLERS.map((name) => [
        name,
        { template: "XXXXXXXXXXXXXXXX", bg: "panel", fg: "foreground" },
      ]),
    ),
  },
  root: { h: ["controls", ...FILLERS] },
};

function barInk(rendered: string): number {
  return rows(rendered).reduce((n, l) => n + l.length, 0);
}

function rows(rendered: string): string[] {
  return stripAnsi(rendered)
    .split("\n")
    .filter((l) => l.trim() !== "");
}

describe("candybar-settings-ui-aok.2: autoWrap and padding are per-session", () => {
  test("a click moves the clicking session's bar, leaves other sessions alone, and survives a daemon restart", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
      // Short on purpose — the socket path has to fit in sockaddr_un.
      "ccb-sess-globals",
    );
    const configDir = path.join(env.XDG_CONFIG_HOME!, "cc-candybar");
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json5");
    writeFileSync(configPath, JSON.stringify(USER_CONFIG));
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-session-globals-project-"),
    );

    const CLICKER = "session-globals-clicker";
    const WRAPPER = "session-globals-wrapper";
    const BYSTANDER = "session-globals-bystander";
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);

      const clickerBefore = await render(sockPath, CLICKER, projectDir);
      const bystanderBefore = await render(sockPath, BYSTANDER, projectDir);
      expect(barInk(clickerBefore)).toBe(barInk(bystanderBefore));

      await click(
        sockPath,
        urlWriting(clickerBefore, "padding", String(PADDING_WIDE)),
      );

      const clickerAfter = await render(sockPath, CLICKER, projectDir);
      const bystanderAfter = await render(sockPath, BYSTANDER, projectDir);
      expect(barInk(clickerAfter)).toBeGreaterThan(barInk(clickerBefore));
      // The bystander is byte-identical — the assertion persist-only could never satisfy.
      expect(stripAnsi(bystanderAfter)).toBe(stripAnsi(bystanderBefore));

      const wrapperBefore = await render(sockPath, WRAPPER, projectDir);
      expect(rows(wrapperBefore).length).toBeGreaterThan(1);

      await click(sockPath, urlWriting(wrapperBefore, "autoWrap", "false"));

      expect(rows(await render(sockPath, WRAPPER, projectDir))).toHaveLength(1);
      expect(stripAnsi(await render(sockPath, BYSTANDER, projectDir))).toBe(
        stripAnsi(bystanderBefore),
      );

      // A cold restart: SessionState is disk-backed, so a click survives a recycle.
      const clickerWide = stripAnsi(
        await render(sockPath, CLICKER, projectDir),
      );
      await killAndWait(daemon, "SIGTERM");
      daemon = await spawnDaemonWithEnv(env);

      expect(stripAnsi(await render(sockPath, CLICKER, projectDir))).toBe(
        clickerWide,
      );
      expect(rows(await render(sockPath, WRAPPER, projectDir))).toHaveLength(1);
      expect(stripAnsi(await render(sockPath, BYSTANDER, projectDir))).toBe(
        stripAnsi(bystanderBefore),
      );

      // The config file was never written — the session half is SessionState, not a third destination.
      expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual(
        USER_CONFIG,
      );
    } finally {
      if (daemon) await killAndWait(daemon);
      removeTmpDirs();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
