// [LAW:verifiable-goals] candybar-settings-ui-aok.2's headline acceptance,
// measured the only way it means anything: a REAL daemon, a REAL user config
// file, two REAL sessions on one socket. The in-process suite
// (test/session-globals.test.ts) proves the resolvers; this proves the wiring
// they had to be threaded into — server.ts reads SessionState for `autoWrap`
// and `padding`, which is the line that was missing and the reason a click on
// either did nothing for the clicking session before this ticket.
//
// Two sessions matter here specifically. `padding` and `autoWrap` were
// persist-only, and a persisted write is GLOBAL — it changes every session's
// bar at once. The session half's whole claim is that it does not, so a test
// that renders one session could pass with the old behaviour.

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
import { PADDING_RANGE } from "../src/themes/policy";

jest.setTimeout(30_000);

// A user config of the ordinary shape: its own `root`, plus one segment
// carrying the two session controls `.3` will eventually put in the config
// menu. Declaring them here is what makes the writes gated — the derived
// validators admit exactly these two keys, from these two declarations.
const CONFIG_PADDING = 1;
const PADDING_WIDE = 4;
const FILLERS = ["f1", "f2", "f3", "f4", "f5", "f6"];

const USER_CONFIG = {
  globals: { padding: CONFIG_PADDING, autoWrap: true },
  // Literal `to:` writes rather than the bounded stepper, so what this test
  // measures is the RESOLUTION this ticket added and not the stepper's seeding
  // rule (an unset key seeds from a declared `state` variable's integer
  // default, which is a separate mechanism with its own tests).
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
    // Fixed-width filler, enough of it that the row cannot fit the daemon's
    // assumed 120 columns — otherwise `autoWrap` has nothing to do and both
    // settings would render identically. Literal rather than `directory`
    // because a segment whose width depends on a temp-dir name makes every
    // width comparison below noisy.
    ...Object.fromEntries(
      FILLERS.map((name) => [
        name,
        { template: "XXXXXXXXXXXXXXXX", bg: "panel", fg: "foreground" },
      ]),
    ),
  },
  root: { h: ["controls", ...FILLERS] },
};

// Total rendered characters across every row, ANSI stripped. Padding adds
// `2 x padding` inside each cell, so this grows with padding no matter how the
// wrap splits the row — unlike the widest row, which SHRINKS as more padding
// forces the same cells across more lines.
function barInk(rendered: string): number {
  return rows(rendered).reduce((n, l) => n + l.length, 0);
}

// Rendered rows. The daemon terminates its output with a newline, so the naive
// split always carries a trailing empty element that is not a row.
function rows(rendered: string): string[] {
  return stripAnsi(rendered)
    .split("\n")
    .filter((l) => l.trim() !== "");
}

describe("candybar-settings-ui-aok.2: autoWrap and padding are per-session", () => {
  test("a click moves the clicking session's bar, leaves other sessions alone, and survives a daemon restart", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
      // Short on purpose — the socket path this becomes has to fit in
      // sockaddr_un (prepareIsolatedDaemonEnv enforces it).
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

      // Both sessions start on the config file's padding: 1.
      const clickerBefore = await render(sockPath, CLICKER, projectDir);
      const bystanderBefore = await render(sockPath, BYSTANDER, projectDir);
      expect(barInk(clickerBefore)).toBe(barInk(bystanderBefore));

      await click(
        sockPath,
        urlWriting(clickerBefore, "padding", String(PADDING_WIDE)),
      );

      const clickerAfter = await render(sockPath, CLICKER, projectDir);
      const bystanderAfter = await render(sockPath, BYSTANDER, projectDir);
      // Wider cells everywhere, so the bar carries strictly more characters.
      expect(barInk(clickerAfter)).toBeGreaterThan(barInk(clickerBefore));
      // ...and the session that did not click is byte-identical. This is the
      // assertion the persist-only behaviour could never satisfy.
      expect(stripAnsi(bystanderAfter)).toBe(stripAnsi(bystanderBefore));

      // autoWrap, same story on a THIRD session — so wrapping is the only
      // thing that differs between it and the bystander, with padding held at
      // the config value for both. Observed as row count rather than width:
      // the filler makes the row overflow the daemon's assumed columns, so the
      // config default (wrap on) is a multi-row bar.
      const wrapperBefore = await render(sockPath, WRAPPER, projectDir);
      expect(rows(wrapperBefore).length).toBeGreaterThan(1);

      await click(sockPath, urlWriting(wrapperBefore, "autoWrap", "false"));

      expect(rows(await render(sockPath, WRAPPER, projectDir))).toHaveLength(1);
      expect(stripAnsi(await render(sockPath, BYSTANDER, projectDir))).toBe(
        stripAnsi(bystanderBefore),
      );

      // A cold restart, through the signal path a real one takes. SessionState
      // is disk-backed on purpose (server.ts binds FileSessionStorage and
      // flushes it in `shutdown()`), so a click is not lost when the RSS
      // backstop recycles the daemon mid-session — the session halves come
      // back exactly as theme/style/look do, and the bystander is still
      // untouched.
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

      // And the user's config file was never written to — the session half is
      // SessionState, not a third write destination.
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
