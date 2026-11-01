// [LAW:types-are-the-program] brandon-unfiled-3248.86ga, measured on a REAL
// daemon: a `launch` child leads its own process group, so nothing aimed at
// the daemon reaches it, yet it dies with the daemon however the daemon ends —
// by its own shutdown, or by a SIGKILL that runs no cleanup at all. The
// lifeline's own cases are held by test/proc/launch.test.ts.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { killAndWait, renderBody } from "./helpers/daemon-e2e";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "./helpers/spawn-isolated-daemon";
import { until } from "./helpers/until";

jest.setTimeout(30_000);

// A `sleep` no other process on the host runs, matched whole.
const running = (seconds: string): boolean =>
  spawnSync("pgrep", ["-f", `^sleep ${seconds}$`]).status === 0;

describe("a launch child in flight dies with the daemon that launched it", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-lifeline-e2e-"),
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // The ticket's repro: a shell source whose command never answers while the
  // test runs, asked for once, so the daemon holds it in flight.
  test.each([
    ["its shutdown", "SIGTERM", "61.861"],
    ["a SIGKILL", "SIGKILL", "61.862"],
  ] as const)("ended by %s", async (_how, signal, seconds) => {
    const config = path.join(projectDir, "waiting.json5");
    writeFileSync(
      config,
      `{ variables: { doc: { kind: 'shell', command: 'sleep ${seconds}', cache: { never: true } } }, segments: { mark: { template: '{{ .doc }}' } }, root: { h: ['mark'] } }`,
    );
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-lifeline-e2e");
    try {
      const daemon = await spawnDaemonWithEnv(prepared.env);
      try {
        await sendDaemonRequest(prepared.sockPath, {
          v: PROTOCOL_VERSION,
          kind: "render",
          ...renderBody("lifeline-e2e", projectDir, {}, [
            "cc-candybar",
            "--config",
            config,
          ]),
        });
        await until(() => running(seconds), `the daemon's sleep ${seconds}`);
      } finally {
        await killAndWait(daemon, signal);
      }
      await until(
        () => !running(seconds),
        `sleep ${seconds} ending with its daemon`,
      );
    } finally {
      // A failed case leaves nothing behind either.
      spawnSync("pkill", ["-f", `^sleep ${seconds}$`]);
      prepared.removeTmpDirs();
    }
  });
});
