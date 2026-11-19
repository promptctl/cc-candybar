// A renderer's own process: the main renderer, built from the boot line its
// host sends on stdin, answering every later line as the renderer interface
// over lines (src/renderer-interface/wire.ts) says. It opens no file and
// writes nothing of its own: its log lines are notices into the host's one
// log, and what it stores leaves as its turns' stored writes.
//
// This process supplies its own clock, memory readings and pipes. The host
// sends the same resolved boot data it uses to build an in-process renderer.

import { once } from "node:events";
import v8 from "node:v8";
import process from "node:process";
import { inspect } from "node:util";
import type { World } from "./host.js";
import { failureOf } from "./daemon/foundations/verb-error.js";
import { mainRendererOf } from "./renderer/main.js";
import {
  timed,
  type RendererBoot,
  type TimedRenderer,
} from "./renderer-interface/interface.js";
import type { AdapterToHost } from "./renderer-interface/adapter.js";
import {
  hostOverLines,
  lineSplitter,
  rendererBootFrom,
  RENDERER_WIRE_VERSION,
  serveRenderer,
  type HostLine,
  type RendererLine,
} from "./renderer-interface/wire.js";

export function runRenderer(world: World): void {
  const send = (line: RendererLine): void => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
  const host = hostOverLines(send);
  // [LAW:single-enforcer] One way out, taken once, whichever end came first:
  // the host holds everything this process stored, so nothing is left to
  // save.
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
    if (leaving) return;
    if (served !== null) {
      served(JSON.parse(text) as HostLine);
      return;
    }
    let renderer: TimedRenderer;
    let subscriptionUpdates: boolean;
    try {
      const boot = rendererBootFrom(JSON.parse(text));
      subscriptionUpdates = boot.subscriptionUpdates === true;
      renderer = booted(world, boot, host);
    } catch (thrown) {
      send({ kind: "refused", failure: failureOf(thrown) });
      leave(1);
      return;
    }
    served = serveRenderer({
      renderer,
      send,
      subscriptionUpdates,
      memory: () => {
        const { rss, heapTotal } = process.memoryUsage();
        return { rss, heapTotal };
      },
      // [LAW:carrying-cost] Paced to the pipe: a snapshot is the heap's size
      // again, so the pipe's buffer holds one chunk of it at a time.
      heapSnapshot: async (chunk) => {
        for await (const text of v8.getHeapSnapshot().setEncoding("utf8")) {
          chunk(text as string);
          if (process.stdout.writableNeedDrain)
            await once(process.stdout, "drain");
        }
      },
    });
    send({
      kind: "started",
      pid: process.pid,
      wireVersion: RENDERER_WIRE_VERSION,
    });
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
  const { clock } = world;
  // [LAW:single-enforcer] Each turn timed in this process, around its
  // answer: the host tells the hop from the turn.
  const renderer = mainRendererOf(boot, reaches);
  return timed(renderer, () => clock.monotonic());
}
