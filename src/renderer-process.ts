// A renderer's own process: the main renderer, built from the boot line its
// host sends on stdin, answering every later line as the renderer interface
// over lines (src/renderer-interface/wire.ts) says. It opens no file: its log
// lines are notices into the host's one log, what it keeps comes with its
// start and leaves as `store` writes, and a heap snapshot leaves in chunks
// the host writes.

import { once } from "node:events";
import v8 from "node:v8";
import process from "node:process";
import { inspect } from "node:util";
import type { World } from "./host.js";
import { daemonGates } from "./daemon/foundations/update-keys.js";
import { failureOf } from "./daemon/foundations/verb-error.js";
import { startMainRenderer } from "./renderer/main.js";
import { linkSigner } from "./click/link-signer.js";
import { timed, type TimedRenderer } from "./renderer-interface/interface.js";
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
  // [LAW:single-enforcer] One way out, taken once, whichever end came first.
  // Nothing is owed to a file: every turn's `store` writes reached the host
  // with its output.
  let leaving = false;
  const leave = (code: number): void => {
    if (leaving) return;
    leaving = true;
    // Each line written so far is on its way before the process ends.
    process.stdout.write("", () => process.exit(code));
  };
  // [LAW:no-silent-failure] What ends it unasked is said on stderr, which the
  // host hears as the renderer's lines.
  process.on("uncaughtException", (err) => {
    process.stderr.write(`uncaughtException: ${err.stack ?? err.message}\n`);
    leave(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`unhandledRejection: ${inspect(reason)}\n`);
    leave(1);
  });
  // The host's terminal signals are the host's: it ends this process by
  // closing its stdin.
  for (const sig of ["SIGINT", "SIGHUP"] as const) process.on(sig, () => {});
  process.on("SIGTERM", () => leave(0));

  let served: ((line: HostLine) => void) | null = null;
  const heard = (text: string): void => {
    const line = JSON.parse(text) as HostLine;
    if (served !== null) {
      served(line);
      return;
    }
    if (line.kind !== "boot") throw new Error(`a ${line.kind} before the boot`);
    let renderer: TimedRenderer;
    try {
      renderer = booted(world, line.boot, host);
    } catch (thrown) {
      send({ kind: "refused", failure: failureOf(thrown) });
      leave(1);
      return;
    }
    served = serveRenderer({
      renderer,
      send,
      memory: () => {
        const { rss, heapTotal } = process.memoryUsage();
        return { rss, heapTotal };
      },
      // [LAW:no-ambient-temporal-coupling] Each chunk waits for the pipe to
      // drain: a pipe is written asynchronously on macOS, so a snapshot read
      // faster than the host takes it would pile up whole in this process,
      // which is already over its limit.
      heapSnapshot: async (chunk) => {
        const snapshot = v8.getHeapSnapshot();
        snapshot.setEncoding("utf8");
        for await (const text of snapshot) {
          chunk(text as string);
          if (process.stdout.writableNeedDrain)
            await once(process.stdout, "drain");
        }
      },
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
    leave(0);
  });
}

function booted(
  world: World,
  boot: RendererBoot,
  reaches: AdapterToHost,
): TimedRenderer {
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
  const { clock } = world;
  // [LAW:single-enforcer] Each turn timed in this process, around its
  // answer: the host tells the hop from the turn.
  const renderer = startMainRenderer(
    {
      linkSigner: linkSigner(Buffer.from(boot.linkKey.value, "base64")),
      locations: boot.locations,
      env: host.env,
      home: host.home,
      gates: daemonGates(),
      memoryLimitBytes: boot.memoryLimitBytes,
    },
    reaches,
  );
  return timed(renderer, () => clock.monotonic());
}
