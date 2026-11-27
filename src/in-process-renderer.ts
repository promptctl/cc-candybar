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
import { SessionDelivery } from "./daemon/session-delivery.js";

export function inProcessRenderer(
  decorate: (renderer: Renderer) => Renderer = (renderer) => renderer,
): RendererPort {
  return ({ name, boot, recording }) => ({
    start: ({ clock, log, start, observed }) =>
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
          return {
            sessions: new SessionDelivery(input.sessionRevision),
            interrupted: () => capture?.interrupted(),
            observe: (commit) => {
              try {
                observed(result.renderer.observe(commit.value));
              } catch (error) {
                capture?.fail(
                  "renderer could not observe a recorded session commit",
                );
                throw error;
              }
              capture?.observed(commit);
            },
            answer: (event) =>
              capture?.active
                ? capture.turn(event, core.answer)
                : core.answer(event),
          };
        },
        () => clock.detach(`renderer ${name} restart`, start),
        (error, restart) => {
          log(
            "error",
            `renderer ${name} could not apply a session commit: ${String(error)}`,
          );
          clock.detach(`renderer ${name} resynchronize`, restart);
        },
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

type LocalSessionRenderer = TimedRenderer & {
  readonly sessions: SessionDelivery;
  interrupted(): void;
  observe(commit: Parameters<RendererLink["observe"]>[0]): void;
};

function localLink(
  name: RendererName,
  build: () => LocalSessionRenderer,
  restore: () => void,
  failed: (error: unknown, restart: () => Promise<void>) => void,
  retire: (previous: TimedRenderer) => Promise<void>,
): RendererLink {
  // [LAW:no-ambient-temporal-coupling] None until the daemon serves: an input
  // before it fails as no renderer's.
  let built: LocalSessionRenderer | null = null;
  let generation = 0;
  let closing = false;
  // [LAW:no-ambient-temporal-coupling] An input reaches the renderer once
  // the stack that sent it has unwound, as it does over a process's lines.
  // The host hands some in from inside its own MobX action, and one store
  // runs both: a turn begun there would leave its views' reactions to run as
  // the host's action ends, after the turn, with no time to read.
  let pending: Promise<void> = Promise.resolve();
  const enqueue = <T>(work: () => T | Promise<T>): Promise<T> => {
    const next = pending.then(work);
    pending = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const renderer: TimedRenderer = {
    answer: (input) => {
      const target = built;
      return enqueue(() => {
        if (target === null || built !== target)
          throw new RendererDown(
            `renderer ${name} is unavailable for this input`,
          );
        return target.answer(input);
      });
    },
  };
  const serve = () => {
    if (built !== null || closing) return;
    built = build();
    generation++;
    pending = Promise.resolve();
  };
  const restart = async () => {
    const previous = built;
    built = null;
    if (previous !== null) await retire(previous);
    if (closing || built !== null) return;
    serve();
    restore();
  };
  const replace = (target: LocalSessionRenderer, error: unknown) => {
    if (built !== target) return;
    built = null;
    target.interrupted();
    const drain = pending;
    failed(error, async () => {
      // An old generation can still be inside its decorated answer. Release
      // it after its queued inputs drain, independently of the new boot.
      const retired = drain.then(() => retire(target));
      try {
        if (built === null && !closing) await restart();
      } finally {
        await retired;
      }
    });
  };
  return {
    renderer,
    observe: (commit) => {
      const target = built;
      if (target === null) return null;
      try {
        target.sessions.offer(commit);
      } catch (error) {
        replace(target, error);
        return null;
      }
      void enqueue(() => {
        if (built !== target) return;
        target.observe(commit);
        target.sessions.confirm(commit.value.revision);
      }).catch((error: unknown) => replace(target, error));
      return generation;
    },
    // [LAW:single-enforcer] Each turn timed around its answer, on the host's
    // clock, which the renderer's process is.
    serve,
    arm: () => {},
    restart,
    // Only a renderer already built by serve can take the close's steps.
    beginClose: () => {
      closing = true;
      return built === null ? "closed" : "closing";
    },
    close: async () => {
      closing = true;
      built = null;
    },
    // Its memory is the host process's, and charged as the host's.
    process: () => ({ kind: "in-host" }),
  };
}
