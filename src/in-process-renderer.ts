// The site and worker tests use this adapter to run the renderer on the same
// event loop as its host. The installed daemon selects the subprocess adapter.
import type { RendererLink, RendererPort } from "./daemon/renderer-process.js";
import {
  CrossedFailure,
  RendererDown,
} from "./daemon/foundations/verb-error.js";
import type { RendererName } from "./daemon/foundations/renderer-name.js";
import { mainRendererOf } from "./renderer/main.js";
import {
  timed,
  type Renderer,
  type TimedRenderer,
} from "./renderer-interface/interface.js";
import { readingsAt } from "./utils/instant.js";
import { writeLogLines } from "./utils/logger.js";
import { runTeardown, type TeardownStep } from "./utils/teardown.js";

export function inProcessRenderer(
  decorate: (renderer: Renderer) => Renderer = (renderer) => renderer,
): RendererPort {
  return ({ name, boot, recording }) => ({
    start: ({ clock, log, start }) =>
      localLink(
        name,
        () => {
          const input = boot();
          const capture = recording?.();
          const result = mainRendererOf(input);
          if (capture !== undefined) {
            if (result.kind === "refused") capture.constructed(input, result);
            else {
              const { renderer: _core, ...constructed } = result;
              capture.constructed(input, constructed);
            }
          }
          if (result.diagnostics !== undefined)
            writeLogLines(log, result.diagnostics);
          if (result.kind === "refused")
            throw new CrossedFailure(result.failure);
          const core = timed(
            decorate(result.renderer),
            () => clock.monotonic(),
            (message) => log("warn", message),
          );
          if (capture === undefined) return core;
          return {
            answer: (event) =>
              capture.active
                ? capture.turn(event, core.answer)
                : core.answer(event),
          };
        },
        () => clock.detach(`renderer ${name} restart`, start),
        async (previous) => {
          // [LAW:no-ambient-temporal-coupling] No old turn remains in flight
          // in the recording slot. Close its local ownership before building
          // the successor, while the host's existing holds await its START.
          const steps = (["close-journal", "close-views"] as const).map(
            (kind): TeardownStep => [
              `renderer ${name} ${kind}`,
              async () => {
                const output = await previous.answer({
                  kind: "event",
                  ...readingsAt(clock),
                  event: { kind },
                });
                if (output.diagnostics !== undefined)
                  writeLogLines(log, output.diagnostics);
                if (output.kind === "threw")
                  throw new CrossedFailure(output.failure);
              },
            ],
          );
          await runTeardown(steps, log);
        },
      ),
  });
}

function localLink(
  name: RendererName,
  build: () => TimedRenderer,
  restore: () => void,
  retire: (previous: TimedRenderer) => Promise<void>,
): RendererLink {
  // [LAW:no-ambient-temporal-coupling] None until the daemon serves: an input
  // before it fails as no renderer's.
  let built: TimedRenderer | null = null;
  const live = (): TimedRenderer => {
    if (built === null)
      throw new RendererDown(`renderer ${name} has not started`);
    return built;
  };
  // [LAW:no-ambient-temporal-coupling] An input reaches the renderer once
  // the stack that sent it has unwound, as it does over a process's lines.
  // The host hands some in from inside its own MobX action, and one store
  // runs both: a turn begun there would leave its views' reactions to run as
  // the host's action ends, after the turn, with no time to read.
  const crossed = async (): Promise<void> => {};
  const renderer: TimedRenderer = {
    answer: async (input) => {
      await crossed();
      return live().answer(input);
    },
  };
  return {
    renderer,
    // [LAW:single-enforcer] Each turn timed around its answer, on the host's
    // clock, which the renderer's process is.
    serve: () => {
      built ??= build();
    },
    arm: () => {},
    restart: async () => {
      const previous = built;
      built = null;
      if (previous !== null) await retire(previous);
      built = build();
      restore();
    },
    // Only a renderer already built by serve can take the close's steps.
    beginClose: () => (built === null ? "closed" : "closing"),
    close: async () => {},
    process: () => null,
  };
}
