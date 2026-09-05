// [LAW:verifiable-goals] brandon-config-5g8's acceptance, measured the way
// the ticket measured the defect: a REAL daemon over a REAL socket. The
// ticket set CC_CANDYBAR_CONFIG on the statusline command and saw a rejected
// config render byte-identically to no config — because the variable was
// read from the DAEMON's own environment, which the client's shell never
// reaches once a daemon is running. So this daemon is spawned with NO such
// variable, and every override arrives the only way a client can send one:
// as the `configEnv` hint. Three renders, three different bars:
//   • no override — the bundled default, no strip;
//   • an override naming a file the loader rejects — the red strip naming
//     the file and its first issue, enough to send the user to `check`;
//   • an override naming a file that does not exist — the bar says so, and
//     names the path, instead of the silent default the ticket measured.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { killAndWait, render, stripAnsi } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

describe("brandon-config-5g8: a client's CC_CANDYBAR_CONFIG reaches a running daemon", () => {
  test("a rejected override and an absent override are each visibly distinct from no override", async () => {
    const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-config-env-e2e",
    );
    // The daemon's own shell says nothing — as in production, where the
    // daemon was spawned by whichever session came first.
    delete env.CC_CANDYBAR_CONFIG;
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-config-env-e2e-project-"),
    );
    // The shape every shipped template failed with (brandon-plugin-templates-irq):
    // a top-level key the loader does not know.
    const rejected = path.join(projectDir, "rejected.json5");
    writeFileSync(rejected, JSON.stringify({ theme: "dracula" }));
    const absent = path.join(projectDir, "absent.json5");

    let daemon: RunningDaemon | undefined;
    try {
      daemon = await spawnDaemonWithEnv(env);

      const plain = stripAnsi(
        await render(sockPath, "cfg-env-plain", projectDir),
      );
      const viaRejected = stripAnsi(
        await render(sockPath, "cfg-env-rejected", projectDir, {
          configEnv: rejected,
        }),
      );
      const viaAbsent = stripAnsi(
        await render(sockPath, "cfg-env-absent", projectDir, {
          configEnv: absent,
        }),
      );

      expect(plain).not.toContain("Invalid config");
      expect(plain).not.toContain("Config file not found");

      expect(viaRejected).toContain("⚠ Invalid config in");
      expect(viaRejected).toContain(rejected);
      expect(viaRejected).toContain('Unknown top-level key "theme"');

      // The strip word-wraps at the client's width, so the path (one word)
      // sits on a row of its own beneath the sentence that names it.
      expect(viaAbsent).toContain("⚠ Config file not found:");
      expect(viaAbsent).toContain(absent);
      expect(viaAbsent).not.toContain("Invalid config");

      expect(viaRejected).not.toBe(plain);
      expect(viaAbsent).not.toBe(plain);
    } finally {
      if (daemon) await killAndWait(daemon);
      rmSync(projectDir, { recursive: true, force: true });
      removeTmpDirs();
    }
  });
});
