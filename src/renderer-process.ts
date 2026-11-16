// A renderer's own process: the main renderer, built from the boot line its
// host sends on stdin, answering every later line as the renderer interface
// over lines (src/renderer-interface/wire.ts) says. It writes nothing of its
// own: its log lines are notices into the host's one log.
//
// [LAW:one-way-deps] exception: the renderer process's composition root, the
// counterpart of the daemon's (src/daemon/server.ts): it reads its paths from
// the host's `Host` and builds the files the renderer still opens itself
// (session state, the settings history, the doctor's stores), which adf and
// uh4 hand in instead.

import v8 from "node:v8";
import process from "node:process";
import { inspect } from "node:util";
import type { World } from "./host.js";
import { daemonPaths, locations } from "./daemon/paths.js";
import { rendererAdapters } from "./daemon/production-adapters.js";
import { linkSigner } from "./click/link-signer.js";
import { daemonGates } from "./daemon/foundations/update-keys.js";
import { failureOf } from "./daemon/foundations/verb-error.js";
import { instantAt } from "./utils/instant.js";
import { loadMainRenderer } from "./renderer/main.js";
import type { Renderer } from "./renderer-interface/interface.js";
import type { AdapterToHost } from "./renderer-interface/adapter.js";
import { bakedDigest } from "./daemon/build-currency.js";
import {
  hostOverLines,
  lineSplitter,
  serveRenderer,
  type HostLine,
  type RendererBoot,
  type RendererLine,
} from "./renderer-interface/wire.js";

export function runRenderer(world: World): void {
  const send = (line: RendererLine): void => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
  const host = hostOverLines(send);
  // [LAW:single-enforcer] Every way out flushes the session state first, as
  // the host's close does: through the renderer's own close step, so a
  // renderer the host never closed (its host died, a throw ended it) loses
  // only what no flush could save.
  let renderer: Renderer | null = null;
  // [LAW:single-enforcer] One way out, taken once, whichever end came first.
  let leaving = false;
  const leave = async (code: number): Promise<void> => {
    if (leaving) return;
    leaving = true;
    // [LAW:no-silent-failure] A flush that fails is said, and the process
    // still ends.
    if (renderer !== null)
      await renderer
        .answer({
          kind: "adapter",
          push: { kind: "close-session-state" },
          at: instantAt(world.clock),
        })
        .catch((thrown: unknown) =>
          process.stderr.write(
            `the session state did not flush: ${failureOf(thrown).detail}\n`,
          ),
        );
    // Each line written so far is on its way before the process ends.
    process.stdout.write("", () => process.exit(code));
  };
  // [LAW:no-silent-failure] What ends it unasked is said on stderr, which the
  // host hears as the renderer's lines.
  process.on("uncaughtException", (err) => {
    process.stderr.write(`uncaughtException: ${err.stack ?? err.message}\n`);
    void leave(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`unhandledRejection: ${inspect(reason)}\n`);
    void leave(1);
  });
  // The host's terminal signals are the host's: it ends this process by
  // closing its stdin.
  for (const sig of ["SIGINT", "SIGHUP"] as const) process.on(sig, () => {});
  process.on("SIGTERM", () => void leave(0));

  let served: ((line: HostLine) => void) | null = null;
  const heard = (text: string): void => {
    const line = JSON.parse(text) as HostLine;
    if (served !== null) {
      served(line);
      return;
    }
    if (line.kind !== "boot") throw new Error(`a ${line.kind} before the boot`);
    try {
      renderer = booted(world, line.boot, host.host);
    } catch (thrown) {
      send({ kind: "refused", failure: failureOf(thrown) });
      void leave(1);
      return;
    }
    served = serveRenderer({
      renderer,
      host,
      send,
      memory: () => {
        const { rss, heapTotal } = process.memoryUsage();
        return { rss, heapTotal };
      },
      heapSnapshot: (file) => void v8.writeHeapSnapshot(file),
      clock: world.clock,
    });
    send({ kind: "started", pid: process.pid });
  };
  const lines = lineSplitter(heard);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => lines.push(chunk));
  // [LAW:no-ambient-temporal-coupling] The host's end, however it came: its
  // close, or its death, which the OS turns into this EOF.
  process.stdin.on("end", () => {
    lines.end();
    void leave(0);
  });
}

function booted(
  world: World,
  boot: RendererBoot,
  reaches: AdapterToHost,
): Renderer {
  const own = bakedDigest();
  if (boot.digest !== own)
    throw new Error(
      `the host was built from source ${boot.digest ?? "of no digest"}; this renderer from ${own ?? "source of no digest"}, which the next daemon runs`,
    );
  // [LAW:no-silent-failure] A key the host could not read refuses this boot
  // with its reason, on the bar's ⚠; the host's next start reads it again.
  if (boot.linkKey.kind === "failed")
    throw new Error(`the link key could not be read: ${boot.linkKey.reason}`);
  const { host } = boot;
  const paths = daemonPaths(host);
  const { clock } = world;
  const adapters = rendererAdapters(paths, clock);
  return loadMainRenderer({
    clock,
    now: () => instantAt(clock),
    storage: {
      ...adapters.storage(reaches.log),
      doctor: adapters.doctorStores,
    },
    linkSigner: linkSigner(Buffer.from(boot.linkKey.value, "base64")),
    stateDir: paths.state,
    locations: locations(host),
    env: host.env,
    home: host.home,
    gates: daemonGates(),
    bundle: boot.bundle,
    memoryLimitBytes: boot.memoryLimitBytes,
  }).start(reaches);
}
