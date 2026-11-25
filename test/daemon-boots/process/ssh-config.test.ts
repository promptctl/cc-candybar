// [LAW:verifiable-goals] `cc-candybar ssh-config` against a real daemon: the
// stanza forwards the socket that daemon serves, to the name its key's links
// carry, whatever shell the stanza was asked for from. The built bundle and a
// daemon of its own, in an isolated environment.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { linkKeyId } from "../../../src/click/link-signer";
import { daemonArgs } from "../../../src/daemon/acquire";
import { linkKeyFile, linkKeyFromFile } from "../../../src/daemon/link-key";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";

const exec = promisify(execFile);
const BUNDLE = path.resolve("dist/index.mjs");

jest.setTimeout(30_000);

test("the stanza names the daemon's own socket and the id its key's links carry", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-ssh-config");
  const daemon = await spawnDaemonWithEnv(isolated.env, (env) => ({
    bin: process.execPath,
    args: daemonArgs(BUNDLE, env),
  })).catch((error: unknown) => {
    isolated.removeTmpDirs();
    throw error;
  });
  try {
    const { stdout } = await exec(
      process.execPath,
      [BUNDLE, "ssh-config", "devbox"],
      { env: isolated.env, timeout: 10_000 },
    );
    // The daemon made its key when asked for the id.
    const key = linkKeyFromFile(linkKeyFile(isolated.stateDir))();
    if (key.kind !== "ok") throw new Error(key.reason);
    expect(stdout).toContain("Host devbox\n");
    expect(stdout).toContain(
      `  LocalForward %d/.cc-candybar/remote/${linkKeyId(key.value)}.sock ${isolated.sockPath}\n`,
    );
  } finally {
    await daemon.stop();
    isolated.removeTmpDirs();
  }
});

test("with no daemon to ask, it says so and prints no stanza", async () => {
  const isolated = prepareIsolatedDaemonEnv("ccb-ssh-config-none");
  try {
    await expect(
      exec(process.execPath, [BUNDLE, "ssh-config", "devbox"], {
        env: isolated.env,
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining(
        `no daemon answered on ${isolated.sockPath}`,
      ),
    });
  } finally {
    isolated.removeTmpDirs();
  }
});
