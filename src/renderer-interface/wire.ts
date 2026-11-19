// The renderer interface as lines: what the host and a renderer in another
// process say to each other, one JSON value per line over the renderer's
// stdio. Both ends are pure over a `send` and the lines heard, so the same
// code runs over a pipe in a test as over a process's stdio.
//
// [LAW:one-type-per-behavior] One transport over the one interface: the host
// holds a `TimedRenderer` and the renderer holds an `AdapterToHost` whichever
// side of a process they are on. A turn is timed in the renderer's process,
// around its answer, and its time crosses with its output.

import type { Failure } from "../daemon/foundations/verb-error.js";
import { isPlainObject } from "../config/loader/validate-core.js";
import { storedStateOf } from "./stored-state.js";
import type { MemorySizes } from "../daemon/foundations/memory-limit.js";
import { CrossedFailure, failureOf } from "../daemon/foundations/verb-error.js";
import type { AdapterToHost } from "./adapter.js";
import type { Crosses } from "./crosses.js";
import {
  rendererOf,
  type AdapterInput,
  type AdapterOutput,
  type RendererBoot,
  type RendererInput,
  type RendererOutput,
  type EventInput,
  type Timed,
  type TimedRenderer,
} from "./interface.js";

// [LAW:one-source-of-truth] Change this when the private renderer transport
// becomes incompatible. A build digest identifies a build, and carries no
// compatibility decision.
export const RENDERER_WIRE_VERSION = 7;
type RendererWireVersion = typeof RENDERER_WIRE_VERSION;

// [LAW:parse-dont-validate] Both boot checkpoints read the peer's raw
// version. A legacy message that omits it admits no renderer input.
export function rendererWireVersionProblem(
  peer: "host" | "renderer",
  version: unknown,
): string | null {
  if (version === RENDERER_WIRE_VERSION) return null;
  const received =
    version === undefined ? "no version" : `version ${JSON.stringify(version)}`;
  return `renderer wire version mismatch (${peer} sent ${received}, expected version ${RENDERER_WIRE_VERSION})`;
}

// [LAW:parse-dont-validate] A worktree's private version is checked before
// its boot shape. Report a mismatched value before announcing readiness.
export function rendererBootFrom(raw: unknown): RendererBoot {
  if (!isPlainObject(raw) || raw.kind !== "boot")
    throw new Error("expected the renderer boot message first");
  const mismatch = rendererWireVersionProblem("host", raw.wireVersion);
  if (mismatch !== null) throw new Error(mismatch);
  const boot = raw.boot;
  if (!isPlainObject(boot)) throw new Error("renderer boot must be an object");
  const locations = boot.locations;
  if (!isPlainObject(locations))
    throw new Error("renderer boot has no resolved locations");
  const { home, configHome, dataHome, dataDirs } = locations;
  if (
    typeof home !== "string" ||
    typeof configHome !== "string" ||
    typeof dataHome !== "string" ||
    !Array.isArray(dataDirs) ||
    !dataDirs.every((dir): dir is string => typeof dir === "string")
  )
    throw new Error("renderer boot has invalid resolved locations");
  const { memoryLimitBytes } = boot;
  if (
    typeof memoryLimitBytes !== "number" ||
    !Number.isFinite(memoryLimitBytes) ||
    memoryLimitBytes < 0
  )
    throw new Error(
      "renderer boot memoryLimitBytes must be a finite nonnegative number",
    );
  return {
    locations: { home, configHome, dataHome, dataDirs },
    memoryLimitBytes,
    stored: storedStateOf(boot.stored),
  };
}

// A reach's path in `AdapterToHost`, dotted: `storage.hold`, `storage.release`.
export type ReachPath = string;

export type HostLine =
  | {
      readonly kind: "boot";
      readonly wireVersion: RendererWireVersion;
      readonly boot: RendererBoot;
    }
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
  | {
      readonly kind: "started";
      readonly pid: number;
      readonly wireVersion: RendererWireVersion;
    }
  | { readonly kind: "refused"; readonly failure: Failure }
  | {
      readonly kind: "output";
      readonly n: number;
      readonly output: Timed<RendererOutput | AdapterOutput>;
    }
  // An input whose answer rejected: nothing of its turn is taken, so the
  // host's caller hears it as the turn's failure.
  | { readonly kind: "rejected"; readonly n: number; readonly failure: Failure }
  | {
      readonly kind: "notice";
      readonly reach: ReachPath;
      readonly args: readonly unknown[];
    }
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

// [LAW:types-are-the-program] Every line is plain data. A reach's arguments
// are checked where they are spelled (`REACHES_CROSS`).
export const HOST_LINES_CROSS: Crosses<HostLine> = true;
export const RENDERER_LINES_CROSS: Crosses<
  Exclude<RendererLine, { kind: "notice" }>
> = true;

// [LAW:types-are-the-program] Every reach `AdapterToHost` spells, each a
// notice (`REACHES_CROSS`): a reach added there fails the build here until it
// is listed.
type ReachKinds<T> = {
  readonly [K in keyof T]: T[K] extends (...args: never[]) => unknown
    ? "notice"
    : ReachKinds<T[K]>;
};

export const REACH_KINDS: ReachKinds<AdapterToHost> = {
  log: "notice",
  eventAnswered: "notice",
  storage: { hold: "notice", release: "notice" },
};

type Reach = (...args: readonly unknown[]) => unknown;

// [LAW:single-enforcer] The one walk of the table: each reach's path and
// kind, in the table's order.
function reachesOf(table: object, prefix = ""): readonly ReachPath[] {
  return Object.entries(table).flatMap(([key, value]) =>
    typeof value === "string"
      ? [`${prefix}${key}`]
      : reachesOf(value as object, `${prefix}${key}.`),
  );
}

const REACHES = reachesOf(REACH_KINDS);

// The host's side of a reach: the function at its path in the host's parts.
function reachAt(host: AdapterToHost, path: ReachPath): Reach {
  const found = path
    .split(".")
    .reduce<unknown>(
      (at, key) => (at as Record<string, unknown> | undefined)?.[key],
      host,
    );
  // [LAW:no-silent-failure] A path the table does not hold is a renderer of
  // another build's; it is said, never dropped.
  if (typeof found !== "function")
    throw new Error(`the renderer reached ${path}, which the host has not`);
  return found as Reach;
}

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
  // The host's parts each reach is performed on.
  readonly host: AdapterToHost;
  // A notice that threw, or a line the host could not take.
  readonly fault: (message: string) => void;
}): RendererOverLines {
  const { send, host } = deps;
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
  const answer = (input: RendererInput) =>
    owe<Timed<RendererOutput | AdapterOutput>>(
      input.kind === "event"
        ? `${input.event.kind} input`
        : `${input.push.kind} push`,
      (n) => ({ kind: "input", n, input }),
      (heard, resolve, reject) => {
        if (heard.kind === "output") resolve(heard.output);
        else if (heard.kind === "rejected")
          reject(new CrossedFailure(heard.failure));
        else return false;
        return true;
      },
    );
  const renderer = rendererOf({
    // [LAW:types-are-the-program] exception: the renderer answers each input
    // with the output of its kind, which the line cannot carry to its type.
    event: (input: EventInput) =>
      answer(input) as Promise<Timed<RendererOutput>>,
    adapter: (input: AdapterInput) =>
      answer(input) as Promise<Timed<AdapterOutput>>,
  });
  // [LAW:no-ambient-temporal-coupling] Each reach is performed as its line
  // arrives, so the notices land in the order sent.
  const reached = (path: ReachPath, args: readonly unknown[]): unknown =>
    reachAt(host, path)(...args);
  const heard = (line: RendererLine): void => {
    // [LAW:no-silent-failure] A line a renderer said as it ended (its pipes
    // can close after its end) reaches nothing: what it would hold has no
    // owner left to release it, and what it answers was failed already.
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
      case "notice":
        try {
          reached(line.reach, line.args);
        } catch (thrown) {
          deps.fault(
            `renderer notice ${line.reach} threw: ${failureOf(thrown).detail}`,
          );
        }
        return;
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

// The host as a renderer in another process holds it: each reach a line.
export function hostOverLines(
  send: (line: RendererLine) => void,
): AdapterToHost {
  const host: Record<string, unknown> = {};
  for (const path of REACHES) {
    const keys = path.split(".");
    const leaf = keys.pop() as string;
    const group = keys.reduce<Record<string, unknown>>(
      (at, key) => (at[key] ??= {}) as Record<string, unknown>,
      host,
    );
    group[leaf] = (...args: readonly unknown[]) =>
      send({ kind: "notice", reach: path, args });
  }
  // [LAW:types-are-the-program] exception: built from `REACH_KINDS`, whose
  // type is `AdapterToHost`'s own shape, so every reach is here.
  return host as unknown as AdapterToHost;
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
        void (
          renderer.answer as (
            i: RendererInput,
          ) => Promise<Timed<RendererOutput | AdapterOutput>>
        )(line.input).then(
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
