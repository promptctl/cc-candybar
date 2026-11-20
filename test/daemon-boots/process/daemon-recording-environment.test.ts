import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { linksOf } from "../../../src/click/read";
import { daemonArgs } from "../../../src/daemon/acquire";
import { textOf } from "../../../src/render/frame";
import { click, frameRequest, hookData } from "../../helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "../../helpers/spawn-isolated-daemon";
import { until } from "../../helpers/until";

const exec = promisify(execFile);
const BUNDLE = path.resolve("dist/index.mjs");
const VARIABLE = "CCB_CAPTURE_TEST_INPUT";
const ENV_VALUE = "prefix-TEST-ONLY-OUTPUT";
const DERIVED = "TEST-ONLY-OUTPUT";
const CLIPPED_VALUE = `\${${VARIABLE}#prefix-}`;
const ENVIRONMENT_REFUSAL =
  /command returned data after receiving a session environment/;

async function withHost<T>(
  run: (host: Awaited<ReturnType<typeof hostOf>>) => Promise<T>,
): Promise<T> {
  const host = await hostOf();
  try {
    return await run(host);
  } finally {
    await host.close();
  }
}

async function hostOf() {
  const isolated = prepareIsolatedDaemonEnv("ccb-record-env");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-record-env-"));
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    isolated.removeTmpDirs();
  };
  const daemon = await spawnDaemonWithEnv(isolated.env, (env) => ({
    bin: process.execPath,
    args: daemonArgs(BUNDLE, env),
  })).catch((error: unknown) => {
    cleanup();
    throw error;
  });
  const command = (...args: string[]) =>
    exec(process.execPath, [BUNDLE, ...args], {
      cwd: dir,
      env: isolated.env,
      timeout: 10_000,
    });
  const draw = (name: string, file: string, env: Record<string, string>) =>
    frameRequest(isolated.sockPath, {
      cwd: dir,
      hookData: hookData(`capture-${name}`, dir),
      args: ["cc-candybar", "--config-only", file],
      client: { kind: "node", bundle: BUNDLE, source: null },
      env: { CC_CANDYBAR_NAME: name, ...env },
    });
  const open = async (name: string, label = name): Promise<string> => {
    const file = path.join(dir, `${label}.jsonl`);
    await command("record", "start", file, "--renderer", name);
    return file;
  };
  const stop = (name: string) => command("record", "stop", "--renderer", name);
  const refused = async (
    name: string,
    file: string,
    reason = ENVIRONMENT_REFUSAL,
  ) => {
    await expect(stop(name)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(reason),
    });
    expect(
      fs.readdirSync(dir).some((item) => item.startsWith(path.basename(file))),
    ).toBe(false);
  };
  return {
    dir,
    socket: isolated.sockPath,
    command,
    draw,
    open,
    stop,
    refused,
    logged: (value: string) =>
      fs
        .readFileSync(path.join(isolated.stateDir, "daemon.log"), "utf8")
        .includes(value),
    config(name: string, document: object): string {
      const file = path.join(dir, `${name}.json5`);
      fs.writeFileSync(file, JSON.stringify(document));
      return file;
    },
    close: async () => {
      try {
        await daemon.stop();
      } finally {
        cleanup();
      }
    },
  };
}

const source = (command: string) => ({
  variables: {
    observed: {
      kind: "shell",
      command,
      env: [VARIABLE],
      cache: { never: true },
    },
  },
  segments: { observation: { template: "source={{ .observed }}" } },
  root: { h: ["observation"] },
});

const failure = (command: string) => ({
  actions: { action: { run: ["/bin/sh", "-c", command] } },
  segments: { action: { template: '{{ action "action" "FAIL" }}' } },
  root: { h: ["action"] },
});

const failAfterReadingEnvironment = `printf '%s' "${CLIPPED_VALUE}" >&2; exit 7`;

test("the running host refuses shell stdout and stderr derived from an environment it supplied", () =>
  withHost(async (host) => {
    const safe = host.config(
      "absent",
      source("printf 'exposed no environment'"),
    );
    const saved = await host.open("absent");
    expect(textOf(await host.draw("absent", safe, {}))).toContain(
      "exposed no environment",
    );
    await host.stop("absent");
    expect((await host.command("replay", saved)).stdout).toContain("Verified");

    const successful = host.config(
      "stdout",
      source(`printf '%s' "${CLIPPED_VALUE}"`),
    );
    const stdoutCapture = await host.open("stdout");
    expect(
      textOf(await host.draw("stdout", successful, { [VARIABLE]: ENV_VALUE })),
    ).toContain(`source=${DERIVED}`);
    await host.refused("stdout", stdoutCapture);
    // The live host still holds the last successful run when a replacement starts.
    const restarted = await host.open("stdout", "restarted-stdout");
    expect(
      textOf(await host.draw("stdout", successful, { [VARIABLE]: ENV_VALUE })),
    ).toContain(`source=${DERIVED}`);
    await host.refused("stdout", restarted);

    const failed = host.config(
      "stderr",
      source(`printf 'source-stderr:%s' "${CLIPPED_VALUE}" >&2; exit 7`),
    );
    const stderrCapture = await host.open("stderr");
    expect(
      textOf(await host.draw("stderr", failed, { [VARIABLE]: ENV_VALUE })),
    ).toContain("source=");
    await until(
      () => host.logged(`source-stderr:${DERIVED}`),
      "the shell source's live failure",
    );
    await host.draw("stderr", failed, { [VARIABLE]: ENV_VALUE });
    await host.refused("stderr", stderrCapture);
  }));

test("failed action stderr is refused live, after persistence, and after a renderer replacement", () =>
  withHost(async (host) => {
    const name = "action";
    const config = host.config(name, failure(failAfterReadingEnvironment));
    const env = { [VARIABLE]: ENV_VALUE };
    const startClick = async (renderer: string, file: string) => {
      const drawn = await host.draw(renderer, file, env);
      const action = linksOf(drawn).find(({ text }) => text === "FAIL");
      if (action === undefined)
        throw new Error("the statusline drew no run target");
      await click(host.socket, action.url);
    };
    const live = await host.open(name);
    await startClick(name, config);
    await until(
      async () => textOf(await host.draw(name, config, env)).includes("⚠"),
      "the failed action reaching the live renderer",
    );
    await host.refused(name, live);
    const loaded = await host.open(name, "saved-click-error");
    await host.draw(name, config, env);
    await host.refused(
      name,
      loaded,
      /saved renderer state contains values of unknown origin/,
    );

    const fifo = path.join(host.dir, "let-action-finish");
    await exec("/usr/bin/mkfifo", [fifo], { timeout: 2_000 });
    const started = path.join(host.dir, "action-running");
    const script = `/usr/bin/touch '${started}'; read value < '${fifo}'; ${failAfterReadingEnvironment}`;
    const delayed = host.config("outlived", failure(script));
    await startClick("outlived", delayed);
    await until(
      () => fs.existsSync(started),
      "the original worker's action reaching its barrier",
    );
    const replacement = await host.open("outlived");
    await host.draw("outlived", delayed, env);
    await until(() => {
      let fd: number;
      try {
        fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENXIO") return false;
        throw error;
      }
      try {
        fs.writeFileSync(fd, "continue\n");
      } finally {
        fs.closeSync(fd);
      }
      return true;
    }, "the original action still waiting on its barrier");
    await until(
      async () =>
        textOf(await host.draw("outlived", delayed, env)).includes("⚠"),
      "the orphaned action failure on the replacement's statusline",
    );
    await host.refused("outlived", replacement);
  }));
