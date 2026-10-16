// [LAW:nothing-unseen] candybar-theme-colours-6fq5.ge6, measured on a REAL
// daemon: a render's event — its `render sid=…` log line — names every warning
// the strip above that render's bar carried, by kind and in the strip's order:
// the config load's own (`load`) and each one the render itself reported
// (`RenderWarning`), `-` for none. The cases enumerate both sources whole — a
// load warning or not, a render warning or not — and read each render's strip
// beside its event, so the two cannot disagree unseen.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logPath } from "../src/daemon/paths";
import { killAndWait, render, stripAnsi } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// The rule branches on the session id, payload the daemon carries per render,
// so one config draws a render whose rule names no theme, one whose rule throws
// (brandon-unfiled-3248.2gq), and one that warns of nothing.
const RULE = `{{ if hasSuffix "-bad" .session.id }}no-such-theme{{ else if hasSuffix "-threw" .session.id }}{{ fail "the rule broke" }}{{ else }}dracula{{ end }}`;

// `dup` repeats a key, which loads (last wins) but earns the load's warning that
// the settings menu cannot edit the file; `clean` is the same config without it.
const CONFIGS = {
  clean: `{ globals: { palette: '${RULE}' }, segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`,
  dup: `{ globals: { palette: '${RULE}' }, segments: { mark: { template: 'mark', template: 'mark' } }, root: { h: ['mark'] } }`,
};

describe("a daemon render's event names every warning its strip carried", () => {
  let sockPath: string;
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-warn-e2e");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-warnings-e2e-"),
    );
    for (const [name, text] of Object.entries(CONFIGS))
      writeFileSync(path.join(projectDir, `${name}.json5`), text);
    daemon = await spawnDaemonWithEnv(prepared.env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test.each([
    { config: "clean", sessionId: "clean-good", warn: "-", shown: [] },
    {
      config: "clean",
      sessionId: "clean-bad",
      warn: "rule",
      shown: ["no-such-theme"],
    },
    {
      config: "clean",
      sessionId: "clean-threw",
      warn: "rule",
      shown: ["broke"],
    },
    {
      config: "dup",
      sessionId: "dup-good",
      warn: "load",
      shown: ["duplicate"],
    },
    {
      config: "dup",
      sessionId: "dup-bad",
      warn: "load,rule",
      shown: ["duplicate", "no-such-theme"],
    },
  ] as const)(
    "$config config, session $sessionId: the strip shows $shown and the event says warn=$warn",
    async ({ config, sessionId, warn, shown }) => {
      const output = stripAnsi(
        await render(sockPath, sessionId, projectDir, {}, [
          "cc-candybar",
          "--config",
          path.join(projectDir, `${config}.json5`),
        ]),
      );
      // The bar renders under every case: a warning never takes it away.
      expect(output).toContain("mark");
      // A strip exactly when there is a warning, showing each in its order.
      // Each is found by one word, since the strip wraps a line between words.
      expect(output.includes("⚠")).toBe(shown.length > 0);
      for (const word of shown) expect(output).toContain(word);
      const at = shown.map((word) => output.indexOf(word));
      expect(at).toEqual([...at].sort((a, b) => a - b));

      // A request the helper retried after a reply timeout is logged once per
      // attempt, and every attempt drew the same warnings.
      const events = readFileSync(logPath(env), "utf8")
        .split("\n")
        .filter((l) => l.includes(`render sid=${sessionId} `))
        .map((l) => l.match(/ warn=(\S+)/)?.[1]);
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const event of events) expect(event).toBe(warn);
    },
  );
});
