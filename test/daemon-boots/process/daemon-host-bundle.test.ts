import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordHostBundle } from "../../../src/daemon/host-bundle";
import { spawnCooldownPath } from "../../../src/daemon/paths";
import { PROTOCOL_VERSION } from "../../../src/daemon/foundations/protocol";
import { isConnectable, sendDaemonRequest } from "../../helpers/daemon-wire";
import { hostOf } from "../../helpers/host";
import {
  prepareIsolatedDaemonEnv,
  type IsolatedDaemonEnv,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

// [LAW:behavior-not-structure] A statusline client finds no host and starts
// one, through the same spawn production takes: a real client process, a real
// daemon, no test hook. Which bundle the host runs is read from the host that
// answers, so the test holds whatever the spawn does about it.
//
// Needs the build (`pnpm build`): both bundles are copies of dist/.

jest.setTimeout(60_000);

let prepared: IsolatedDaemonEnv;
let bundles: string;

beforeEach(() => {
  prepared = prepareIsolatedDaemonEnv("cc-candybar-hb");
  // Canonical, because the host reports the bundle it was loaded from by its
  // real path, and macOS's temporary directory is a link.
  bundles = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-hb-bundles-")),
  );
});

afterEach(async () => {
  // The host a client started is detached and no child of this test.
  if (await isConnectable(prepared.sockPath)) {
    await sendDaemonRequest(prepared.sockPath, {
      v: PROTOCOL_VERSION,
      kind: "shutdown",
    });
    await until(
      async () => !(await isConnectable(prepared.sockPath)),
      "the host's socket closing",
      8_000,
    );
  }
  prepared.removeTmpDirs();
  fs.rmSync(bundles, { recursive: true, force: true });
});

// A second copy of the build, as a worktree's own would be.
function bundleCopy(name: string): string {
  const dist = path.join(bundles, name, "dist");
  fs.cpSync(path.resolve("dist"), dist, { recursive: true });
  return path.join(dist, "index.mjs");
}

// One statusline tick of the client at `bundle`, with no host running.
function tick(bundle: string) {
  const result = spawnSync(process.execPath, [bundle], {
    input: JSON.stringify({
      session_id: "host-bundle",
      cwd: bundles,
      workspace: { current_dir: bundles },
    }),
    env: prepared.env,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe("a client that finds no host starts the one the install recorded", () => {
  test("a worktree's client starts the installed bundle, and every bar draws from it", async () => {
    const installed = bundleCopy("install");
    const worktree = bundleCopy("worktree");
    recordHostBundle(hostOf(prepared.env), installed);

    tick(worktree);

    await until(
      () => isConnectable(prepared.sockPath),
      "the host the worktree's client started",
      15_000,
    );
    // A bound socket is not yet a host that answers: ask until stats come back.
    let seen: unknown;
    let bundle: string | undefined;
    await until(
      async () => {
        seen = await sendDaemonRequest(prepared.sockPath, {
          v: PROTOCOL_VERSION,
          kind: "stats",
        });
        bundle = (seen as { stats?: { bundle?: string } }).stats?.bundle;
        return bundle !== undefined;
      },
      () => `the host's stats; the last answer was ${JSON.stringify(seen)}`,
      15_000,
    );
    expect(bundle).toBe(installed);
    expect(bundle).not.toBe(worktree);
  });

  test("with no record the bar says to run the install and nothing is spawned", () => {
    const worktree = bundleCopy("worktree");

    const result = tick(worktree);

    expect(result.stdout).toContain("no host bundle recorded");
    expect(result.stdout).toContain("cc-candybar install");
    expect(fs.existsSync(spawnCooldownPath(hostOf(prepared.env)))).toBe(false);
  });
});
