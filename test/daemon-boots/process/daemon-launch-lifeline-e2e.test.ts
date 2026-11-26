// [LAW:types-are-the-program] brandon-unfiled-3248.86ga, measured on a REAL
// daemon: a `launch` child leads its own process group, so nothing aimed at
// the daemon reaches it, yet it dies with the daemon however the daemon ends —
// by its own shutdown, or by a SIGKILL that runs no cleanup at all. The
// lifeline's own cases are held by test/proc/launch.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import { renderBody } from "../../helpers/daemon-e2e";
import { heldGrandchild } from "../../helpers/held-grandchild";
import { sendDaemonRequest } from "../../../scripts/lib/daemon/wire";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

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
    ["its shutdown", "SIGTERM"],
    ["a SIGKILL", "SIGKILL"],
  ] as const)("ended by %s", async (_how, signal) => {
    await using child = await heldGrandchild();
    const config = path.join(projectDir, "waiting.json5");
    writeFileSync(
      config,
      `{ variables: { doc: { kind: 'shell', command: ${JSON.stringify(child.command)}, cache: { never: true } } }, segments: { mark: { template: '{{ .doc }}' } }, root: { h: ['mark'] } }`,
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
        await child.started();
      } finally {
        await daemon.stop(signal);
      }
      await child.ended();
    } finally {
      prepared.removeTmpDirs();
    }
  });
});
