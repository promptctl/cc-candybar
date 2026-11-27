// A renderer's own process: the main renderer, built from the boot line its
// host sends on stdin, answering every later line as the renderer interface
// over lines (src/renderer-interface/wire.ts) says. It opens no file and
// writes nothing of its own. Log lines and store writes are part of each
// turn's answer, which the host lands.
//
// This process supplies its own clock, memory readings and pipes. The host
// sends the same resolved boot data it uses to build an in-process renderer.

import { once } from "node:events";
import v8 from "node:v8";
import process from "node:process";
import { inspect } from "node:util";
import type { Monotonic } from "./time.js";
import { rendererFailureOf } from "./daemon/foundations/verb-error.js";
import { mainRendererOf } from "./renderer/main.js";
import {
  timed,
  type RendererConstruction,
} from "./renderer-interface/interface.js";
import {
  lineSplitter,
  rendererBootFrom,
  RENDERER_WIRE_VERSION,
  serveRenderer,
  type HostLine,
  type RendererLine,
} from "./renderer-interface/wire.js";

// [LAW:effects-at-boundaries] The transport measures turns with the clock
// the entry point gives it. The renderer reads its world from the boot and
// input messages on the pipe.
export function runRenderer(monotonic: () => Monotonic): void {
  const send = (line: RendererLine): void => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
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

  let served: ReturnType<typeof serveRenderer> | null = null;
  const heard = (text: string): void => {
    if (leaving) return;
    if (served !== null) {
      const line = JSON.parse(text) as HostLine;
      served(
        line,
        line.kind === "session-commit"
          ? Buffer.byteLength(text) + 1
          : undefined,
      );
      return;
    }
    let result: RendererConstruction;
    try {
      const boot = rendererBootFrom(JSON.parse(text));
      result = mainRendererOf(boot);
    } catch (thrown) {
      result = { kind: "refused", failure: rendererFailureOf(thrown) };
    }
    if (result.kind === "refused") {
      send({ ...result, wireVersion: RENDERER_WIRE_VERSION });
      leave(1);
      return;
    }
    const { renderer, diagnostics } = result;
    served = serveRenderer({
      observe: renderer.observe,
      // [LAW:single-enforcer] Each turn is timed in its own process.
      renderer: timed(renderer, monotonic, (message) => {
        process.stderr.write(`${message}\n`);
      }),
      send,
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
      ...(diagnostics === undefined ? {} : { diagnostics }),
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
