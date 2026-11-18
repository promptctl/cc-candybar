// The renderer interface as lines: what the host and a renderer in another
// process say to each other, one JSON value per line over the renderer's
// stdio. Both ends are pure over a `send` and the lines heard, so the same
// code runs over a pipe in a test as over a process's stdio.
//
// [LAW:one-type-per-behavior] One transport over the one interface: the host
// holds a `TimedRenderer` whichever side of a process the renderer is on. A
// turn is timed in the renderer's process, around its answer, and its time
// crosses with its output.

import type { Failure } from "../daemon/foundations/verb-error.js";
import type { MemorySizes } from "../daemon/foundations/memory-limit.js";
import { CrossedFailure, failureOf } from "../daemon/foundations/verb-error.js";
import type { Asked } from "../utils/outcome.js";
import type { Locations } from "../config/loader/chain-places.js";
import type { HeldKeys } from "../daemon/foundations/gates.js";
import type { StoredState } from "./stored-state.js";
import type { Crosses } from "./crosses.js";
import type {
  RendererInput,
  RendererOutput,
  Timed,
  TimedRenderer,
} from "./interface.js";

// What a renderer builds itself from, in its own process or the host's: where
// the user's config and plugins live as the host found them, the one memory
// limit its cache's budget is a share of, the keys its gates hold, and its
// profile's stored state as the host holds it as the renderer starts.
export interface RendererBoot {
  readonly stored: StoredState;
  // [LAW:one-source-of-truth] The digest of the source the host was built
  // from, which a renderer built from other source refuses: the renderer runs
  // from the entry on disk, which an install can rewrite under a running
  // host, and two builds agree on these lines only by being one build.
  readonly digest: string | null;
  readonly locations: Locations;
  readonly home: string;
  readonly gates: HeldKeys;
  readonly memoryLimitBytes: number;
  // The host's link key in base64, read as this renderer spawned, which it
  // signs every link with; or why it could not be read, which the renderer
  // refuses its boot with.
  readonly linkKey: Asked<string>;
}

export type HostLine =
  | { readonly kind: "boot"; readonly boot: RendererBoot }
  | {
      readonly kind: "input";
      readonly n: number;
      readonly input: RendererInput;
    }
  // [LAW:single-enforcer] The supervisor's one check that the renderer's loop turns:
  // answered outside any turn, with what the process holds of memory.
  | { readonly kind: "ping"; readonly n: number }
  // A breach's heap snapshot, streamed back for the host to write.
  | { readonly kind: "heap-snapshot"; readonly n: number };

export type RendererLine =
  // The boot answered: the renderer is built, or why it is not.
  | { readonly kind: "started"; readonly pid: number }
  | { readonly kind: "refused"; readonly failure: Failure }
  | {
      readonly kind: "output";
      readonly n: number;
      readonly output: Timed<RendererOutput>;
    }
  // An input whose answer rejected: nothing of its turn is taken, so the
  // host's caller hears it as the turn's failure.
  | { readonly kind: "rejected"; readonly n: number; readonly failure: Failure }
  | { readonly kind: "ping"; readonly n: number; readonly usage: MemorySizes }
  // [LAW:effects-at-boundaries] A heap snapshot's next piece of text, which
  // the host writes: the renderer process opens no file.
  | { readonly kind: "heap-chunk"; readonly n: number; readonly chunk: string }
  // The snapshot's end: every chunk sent, or why the rest was not.
  | {
      readonly kind: "heap-snapshot";
      readonly n: number;
      readonly taken:
        | { readonly kind: "ok" }
        | { readonly kind: "failed"; readonly failure: Failure };
    };

// [LAW:types-are-the-program] Every line is plain data.
export const HOST_LINES_CROSS: Crosses<HostLine> = true;
export const RENDERER_LINES_CROSS: Crosses<RendererLine> = true;

// [LAW:single-enforcer] One splitter for a stream of lines: each chunk is
// scanned once, and a last line with no newline is heard at the end.
export function lineSplitter(heard: (line: string) => void): {
  readonly push: (chunk: string) => void;
  readonly end: () => void;
} {
  let rest = "";
  return {
    push: (chunk) => {
      let from = 0;
      let at = chunk.indexOf("\n");
      while (at !== -1) {
        const line = rest + chunk.slice(from, at);
        rest = "";
        heard(line);
        from = at + 1;
        at = chunk.indexOf("\n", from);
      }
      rest += chunk.slice(from);
    },
    end: () => {
      if (rest === "") return;
      const line = rest;
      rest = "";
      heard(line);
    },
  };
}

// The renderer as the host holds it over lines: `renderer` sends each input
// and resolves with its output; `heard` takes every line the renderer says;
// `ended` rejects whatever is still owed, with why.
export interface RendererOverLines {
  readonly renderer: TimedRenderer;
  readonly ping: () => Promise<MemorySizes>;
  // Settles once the snapshot has ended, each chunk handed to `write` as it
  // came.
  readonly heapSnapshot: (write: (chunk: string) => void) => Promise<void>;
  readonly heard: (line: RendererLine) => void;
  readonly ended: (why: Error) => void;
}

export function rendererOverLines(deps: {
  readonly send: (line: HostLine) => void;
  // A line the host could not take.
  readonly fault: (message: string) => void;
}): RendererOverLines {
  const { send } = deps;
  // What each line sent is owed, by its number: what was asked, and how its
  // answer settles it.
  const owed = new Map<
    number,
    {
      readonly what: string;
      readonly settle: (line: RendererLine) => boolean;
      readonly fail: (why: Error) => void;
    }
  >();
  // Where each snapshot being streamed writes its chunks, until it settles.
  const chunks = new Map<number, (chunk: string) => void>();
  let next = 0;
  let gone: Error | null = null;
  const owe = <T>(
    what: string,
    line: (n: number) => HostLine,
    // Whether the line answers what was asked.
    settle: (
      line: RendererLine,
      resolve: (value: T) => void,
      reject: (why: Error) => void,
    ) => boolean,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (gone !== null) {
        reject(gone);
        return;
      }
      const n = ++next;
      owed.set(n, {
        what,
        settle: (heard) => settle(heard, resolve, reject),
        fail: reject,
      });
      send(line(n));
    });
  const renderer: TimedRenderer = {
    answer: (input: RendererInput) =>
      owe<Timed<RendererOutput>>(
        `${input.event.kind} input`,
        (n) => ({ kind: "input", n, input }),
        (heard, resolve, reject) => {
          if (heard.kind === "output") resolve(heard.output);
          else if (heard.kind === "rejected")
            reject(new CrossedFailure(heard.failure));
          else return false;
          return true;
        },
      ),
  };
  const heard = (line: RendererLine): void => {
    // [LAW:no-silent-failure] A line a renderer said as it ended (its pipes
    // can close after its end) reaches nothing: what it answers was failed
    // already.
    if (gone !== null) {
      deps.fault(`renderer said ${line.kind} after its end (${gone.message})`);
      return;
    }
    switch (line.kind) {
      case "heap-chunk": {
        const write = chunks.get(line.n);
        if (write === undefined) {
          deps.fault(`renderer sent a heap chunk ${line.n}, owed none`);
          return;
        }
        write(line.chunk);
        return;
      }
      case "output":
      case "rejected":
      case "ping":
      case "heap-snapshot": {
        const waiting = owed.get(line.n);
        if (waiting === undefined) {
          deps.fault(`renderer answered ${line.kind} ${line.n}, owed nothing`);
          return;
        }
        owed.delete(line.n);
        // [LAW:no-silent-failure] An answer of another kind than was asked
        // settles nothing: the ask fails, saying so.
        if (!waiting.settle(line))
          waiting.fail(
            new Error(`renderer answered ${waiting.what} with ${line.kind}`),
          );
        return;
      }
      case "started":
      case "refused":
        // [LAW:single-enforcer] A boot's answer is the supervisor's, which
        // hears it before it hands lines here.
        deps.fault(`renderer said ${line.kind} after its boot`);
        return;
    }
  };
  return {
    renderer,
    ping: () =>
      owe<MemorySizes>(
        "a ping",
        (n) => ({ kind: "ping", n }),
        (heard, resolve) => {
          if (heard.kind !== "ping") return false;
          resolve(heard.usage);
          return true;
        },
      ),
    heapSnapshot: (write) =>
      owe<void>(
        "a heap snapshot",
        (n) => {
          chunks.set(n, write);
          return { kind: "heap-snapshot", n };
        },
        (heard, resolve, reject) => {
          if (heard.kind !== "heap-snapshot") return false;
          chunks.delete(heard.n);
          if (heard.taken.kind === "ok") resolve();
          else reject(new CrossedFailure(heard.taken.failure));
          return true;
        },
      ),
    heard,
    ended: (why) => {
      gone ??= why;
      const waiting = [...owed.values()];
      owed.clear();
      chunks.clear();
      for (const each of waiting) each.fail(why);
    },
  };
}

// The renderer's side of the lines past its boot: each input answered by
// its output, and the host's reads of the process answered here, outside any
// turn.
export function serveRenderer(deps: {
  readonly renderer: TimedRenderer;
  readonly send: (line: RendererLine) => void;
  readonly memory: () => MemorySizes;
  // The process's heap as text, each piece handed to `chunk` in order.
  readonly heapSnapshot: (chunk: (text: string) => void) => Promise<void>;
}): (line: HostLine) => void {
  const { renderer, send } = deps;
  return (line) => {
    switch (line.kind) {
      case "input":
        // [LAW:no-silent-failure] An input whose answer rejected is answered
        // as that input's failure, never left to end the process.
        void renderer.answer(line.input).then(
          (output) => send({ kind: "output", n: line.n, output }),
          (thrown: unknown) =>
            send({ kind: "rejected", n: line.n, failure: failureOf(thrown) }),
        );
        return;
      case "ping":
        send({ kind: "ping", n: line.n, usage: deps.memory() });
        return;
      case "heap-snapshot": {
        const { n } = line;
        void deps
          .heapSnapshot((chunk) => send({ kind: "heap-chunk", n, chunk }))
          .then(
            () => send({ kind: "heap-snapshot", n, taken: { kind: "ok" } }),
            (thrown: unknown) =>
              send({
                kind: "heap-snapshot",
                n,
                taken: { kind: "failed", failure: failureOf(thrown) },
              }),
          );
        return;
      }
      case "boot":
        throw new Error("a second boot");
    }
  };
}
