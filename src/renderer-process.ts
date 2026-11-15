// The renderer's process: the `renderer` subcommand a daemon's supervisor
// starts (src/daemon/renderer-links.ts). It builds the main renderer over the
// files its boot names and serves it over its stdio, one JSON value per line
// (src/renderer-interface/wire.ts). It ends when its stdin does, which the OS
// gives it however its host ends, so it never outlives its host to write the
// session file beside the next host's renderer.

import readline from "node:readline";
import type { World } from "./host";
import { parseBoot } from "./renderer-interface/boot.js";
import type { AdapterToHost } from "./renderer-interface/adapter.js";
import { serveRenderer } from "./renderer-interface/wire.js";
import { loadMainRenderer } from "./renderer/main.js";
import { daemonGates } from "./daemon/foundations/update-keys.js";
import { locations } from "./daemon/paths";
import { makeLimits } from "./daemon/limits";
import { rendererProcessAdapters } from "./daemon/production-adapters";
import { instantAt } from "./utils/instant.js";
import type { DaemonLogger } from "./utils/logger";

export function runRenderer(args: readonly string[], world: World): void {
  const boot = parseBoot(args[0]);
  const { clock, host } = world;
  // [LAW:single-enforcer] The renderer writes no log of its own: its lines
  // reach the host's one log, once the host it reaches exists.
  let reached: AdapterToHost | null = null;
  const log: DaemonLogger = (level, line) => {
    if (reached === null) process.stderr.write(`${level}: ${line}\n`);
    else reached.log(level, line);
  };
  // [LAW:no-silent-failure] Anything thrown past a turn ends the renderer,
  // said on the host's log, and its supervisor starts another on the next
  // input.
  process.on("uncaughtException", (err) => {
    log("error", `renderer uncaughtException: ${err.stack ?? err.message}`);
    process.exitCode = 1;
    process.stdout.end(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    log("error", `renderer unhandledRejection: ${String(reason)}`);
    process.exitCode = 1;
    process.stdout.end(() => process.exit(1));
  });
  const adapters = rendererProcessAdapters(boot, log, clock, world.launcher);
  let answer: ((line: string) => void) | null = null;
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => answer?.(line));
  serveRenderer(
    {
      send: (line) => void process.stdout.write(`${line}\n`),
      hear: (heard) => {
        answer = heard;
      },
    },
    (remote) => {
      reached = remote;
      log(
        "info",
        `renderer up generation=${boot.generation} pid=${process.pid}`,
      );
      return loadMainRenderer({
        generation: boot.generation,
        clock,
        now: () => instantAt(clock),
        storage: adapters.storage,
        linkSigner: adapters.linkSigner,
        stateDir: boot.stateDir,
        locations: locations(host),
        env: host.env,
        home: host.home,
        gates: daemonGates(),
        bundle: boot.bundle,
        memoryLimitBytes: boot.memoryShareBytes,
      }).start(remote);
    },
    () => clock.monotonic(),
  );
  // [LAW:one-type-per-behavior] This process's backstop is the host's, over
  // its own share: a breach writes its own post-mortems and ends it, and its
  // supervisor starts another.
  makeLimits({
    ...adapters.limits((code) => process.stdout.end(() => process.exit(code))),
    limitBytes: boot.memoryShareBytes,
  }).arm();
  // [LAW:no-ambient-temporal-coupling] The host's close has taken the
  // renderer's steps before it ends stdin; a host that died took none, and
  // what the session state has pending is lost with it, as it is when the
  // host's own process dies.
  input.on("close", () => process.stdout.end(() => process.exit(0)));
}
