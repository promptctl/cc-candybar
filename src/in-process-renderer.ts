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
  rendererOf,
  timed,
  type Renderer,
  type TimedRenderer,
} from "./renderer-interface/interface.js";
import type { Timekeeper } from "./time.js";
import { writeLogLines } from "./utils/logger.js";

export function inProcessRenderer(
  decorate: (renderer: Renderer) => Renderer = (renderer) => renderer,
): RendererPort {
  return ({ name, boot }) => ({
    start: ({ reaches, clock, log }) =>
      localLink(
        name,
        () => {
          const result = mainRendererOf(boot(), reaches);
          if (result.diagnostics !== undefined)
            writeLogLines(log, result.diagnostics);
          if (result.kind === "refused")
            throw new CrossedFailure(result.failure);
          return decorate(result.renderer);
        },
        clock,
      ),
  });
}

function localLink(
  name: RendererName,
  build: () => Renderer,
  clock: Pick<Timekeeper, "monotonic">,
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
  const renderer: TimedRenderer = rendererOf({
    event: async (input) => {
      await crossed();
      return live().answer(input);
    },
    adapter: async (input) => {
      await crossed();
      return live().answer(input);
    },
  });
  return {
    renderer,
    // [LAW:single-enforcer] Each turn timed around its answer, on the host's
    // clock, which the renderer's process is.
    serve: () => {
      built ??= timed(build(), () => clock.monotonic());
    },
    arm: () => {},
    // Only a renderer already built by serve can take the close's steps.
    beginClose: () => (built === null ? "closed" : "closing"),
    close: async () => {},
    process: () => null,
  };
}
