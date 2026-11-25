// [LAW:verifiable-goals] `cc-candybar ssh-config` against a real daemon: the
// stanza forwards the socket that daemon serves, to the name its key's links
// carry, whatever shell the stanza was asked for from. The built bundle and a
// daemon of its own, in an isolated environment.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { linkKeyId } from "../../../src/click/link-signer";
import { sshConfigPlan } from "../../../src/ssh-cli";
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
      `  LocalForward %d/.cc-candybar/remote/${linkKeyId(key.value)}.%n.sock ${isolated.sockPath}\n`,
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

// [LAW:verifiable-goals] What ssh itself makes of the stanza: the forward's
// name carries the alias the `Host` line names (ssh's `%n`), which is what the
// URL handler reads back to reach a remote file from an editor.
test("ssh expands the stanza's forward to a name carrying the alias", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-ssh-stanza-"));
  try {
    const plan = sshConfigPlan(["devbox"], {
      kind: "ok",
      value: { keyId: "AbCd-_12", socket: "/tmp/cc-candybar-1000/socket" },
    });
    const config = path.join(dir, "config");
    fs.writeFileSync(config, plan.stdout);
    const { stdout } = await exec("ssh", ["-F", config, "-G", "devbox"], {
      timeout: 10_000,
    });
    expect(stdout).toContain(
      `localforward ${os.homedir()}/.cc-candybar/remote/AbCd-_12.devbox.sock /tmp/cc-candybar-1000/socket\n`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
