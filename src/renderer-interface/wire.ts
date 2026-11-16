// The renderer interface as lines: what the host and a renderer in another
// process say to each other, one JSON value per line over the renderer's
// stdio. Both ends are pure over a `send` and the lines heard, so the same
// code runs over a pipe in a test as over a process's stdio.
//
// [LAW:one-type-per-behavior] One transport over the one interface: the host
// holds a `Renderer` and the renderer holds an `AdapterToHost` whichever side
// of a process they are on.

import type { Failure } from "../daemon/foundations/verb-error.js";
import type { MemorySizes } from "../daemon/foundations/memory-limit.js";
import { CrossedFailure, failureOf } from "../daemon/foundations/verb-error.js";
import type { Host } from "../host-facts.js";
import type { Timekeeper } from "../time.js";
import type { Asked } from "../utils/outcome.js";
import type { AdapterToHost } from "./adapter.js";
import type { Crosses } from "./crosses.js";
import {
  rendererOf,
  type AdapterInput,
  type AdapterOutput,
  type Renderer,
  type RendererInput,
  type RendererOutput,
  type EventInput,
} from "./interface.js";

// What a renderer process builds itself from: the host's view of its machine
// (its environment, home and temporary directory, from which the renderer
// derives the paths it owns as the host does), the bundle the doctor judges
// clients against, and the one memory limit its cache's budget is a share of.
export interface RendererBoot {
  // [LAW:one-source-of-truth] The digest of the source the host was built
  // from, which a renderer built from other source refuses: the renderer runs
  // from the entry on disk, which an install can rewrite under a running
  // host, and two builds agree on these lines only by being one build.
  readonly digest: string | null;
  // [LAW:one-source-of-truth] The host's own `Host`, its environment's unset
  // variables left out as JSON leaves them, which a process environment
  // reads the same as absent.
  readonly host: Omit<Host, "env"> & {
    readonly env: Readonly<Record<string, string>>;
  };
  readonly bundle: string;
  readonly memoryLimitBytes: number;
  // The host's link key in base64, read as this renderer spawned, which it
  // signs every link with; or why it could not be read, which the renderer
  // refuses its boot with.
  readonly linkKey: Asked<string>;
}

// The host's environment as a boot carries it: its set variables.
export function bootEnv(
  env: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
}

// How an awaited call ended, as data: a rejection keeps its failure's kind.
export type Returned =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "failed"; readonly failure: Failure };

// A reach's path in `AdapterToHost`, dotted: `runs.start`, `doctor.forge`.
export type ReachPath = string;

export type HostLine =
  | { readonly kind: "boot"; readonly boot: RendererBoot }
  | {
      readonly kind: "input";
      readonly n: number;
      readonly input: RendererInput;
    }
  | {
      readonly kind: "returned";
      readonly n: number;
      readonly returned: Returned;
    }
  // [LAW:single-enforcer] The supervisor's one check that the renderer's loop turns:
  // answered outside any turn, with what the process holds of memory.
  | { readonly kind: "ping"; readonly n: number }
  // A breach's heap snapshot, written under the breach's identity.
  | {
      readonly kind: "heap-snapshot";
      readonly n: number;
      readonly file: string;
    };

export type RendererLine =
  // The boot answered: the renderer is built, or why it is not.
  | { readonly kind: "started"; readonly pid: number }
  | { readonly kind: "refused"; readonly failure: Failure }
  | {
      readonly kind: "output";
      readonly n: number;
      readonly output: RendererOutput | AdapterOutput;
    }
  // An input whose answer rejected: nothing of its turn is taken, so the
  // host's caller hears it as the turn's failure.
  | { readonly kind: "rejected"; readonly n: number; readonly failure: Failure }
  | {
      readonly kind: "notice";
      readonly reach: ReachPath;
      readonly args: readonly unknown[];
    }
  | {
      readonly kind: "call";
      readonly n: number;
      readonly reach: ReachPath;
      readonly args: readonly unknown[];
    }
  | { readonly kind: "ping"; readonly n: number; readonly usage: MemorySizes }
  | {
      readonly kind: "heap-snapshot";
      readonly n: number;
      readonly written:
        | { readonly kind: "ok" }
        | { readonly kind: "failed"; readonly failure: Failure };
    };

// [LAW:types-are-the-program] Every line is plain data. A reach's arguments
// and an awaited value are checked where they are spelled (`REACHES_CROSS`).
export const HOST_LINES_CROSS: Crosses<
  Exclude<HostLine, { kind: "returned" }>
> = true;
export const RENDERER_LINES_CROSS: Crosses<
  Exclude<RendererLine, { kind: "notice" | "call" }>
> = true;

// [LAW:types-are-the-program] Which reaches answer nothing and which are
// awaited, for every reach `AdapterToHost` spells: a reach added there fails
// the build here until it is listed as what it is.
type ReachKinds<T> = {
  readonly [K in keyof T]: T[K] extends (...args: never[]) => infer R
    ? [R] extends [Promise<unknown>]
      ? "call"
      : "notice"
    : ReachKinds<T[K]>;
};

export const REACH_KINDS: ReachKinds<AdapterToHost> = {
  wake: "notice",
  log: "notice",
  launch: "call",
  typeSlash: "call",
  applyUpdate: "call",
  runs: { start: "notice", refused: "notice" },
  doctor: {
    probeTmux: "call",
    remoteLogin: "call",
    fontInUse: "call",
    daemons: "call",
    forge: "call",
    transcript: "call",
    install: "call",
  },
  laneSetups: { noted: "notice", clicked: "notice" },
  tmuxStatusLines: { observe: "notice" },
  menuIdle: {
    clicked: "notice",
    clickArrived: "notice",
    clickSettled: "notice",
    observe: "notice",
    confirmClose: "call",
  },
  clicks: { gone: "call" },
  serving: "call",
  renderSightings: { ofSession: "call" },
  eventAnswered: "notice",
  watches: { watch: "notice", unwatch: "notice" },
  storage: { hold: "notice", release: "notice" },
};

type Reach = (...args: readonly unknown[]) => unknown;

// [LAW:single-enforcer] The one walk of the table: each reach's path and
// kind, in the table's order.
function reachesOf(
  table: object,
  prefix = "",
): ReadonlyArray<readonly [ReachPath, "notice" | "call"]> {
  return Object.entries(table).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[`${prefix}${key}`, value as "notice" | "call"] as const]
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
  readonly renderer: Renderer;
  readonly ping: () => Promise<MemorySizes>;
  readonly heapSnapshot: (file: string) => Promise<void>;
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
    owe<RendererOutput | AdapterOutput>(
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
    event: (input: EventInput) => answer(input) as Promise<RendererOutput>,
    adapter: (input: AdapterInput) => answer(input) as Promise<AdapterOutput>,
  });
  // [LAW:no-ambient-temporal-coupling] Each reach is performed as its line
  // arrives, a call's as a notice's, so a call and the notices around it land
  // in the order sent; only a call's answer waits.
  const reached = (path: ReachPath, args: readonly unknown[]): unknown =>
    reachAt(host, path)(...args);
  const calling = (
    path: ReachPath,
    args: readonly unknown[],
  ): Promise<unknown> => {
    try {
      return Promise.resolve(reached(path, args));
    } catch (thrown) {
      return Promise.reject(thrown as Error);
    }
  };
  const heard = (line: RendererLine): void => {
    // [LAW:no-silent-failure] A line a renderer said as it ended (its pipes
    // can close after its end) reaches nothing: what it would hold has no
    // owner left to release it, and what it answers was failed already.
    if (gone !== null) {
      deps.fault(`renderer said ${line.kind} after its end (${gone.message})`);
      return;
    }
    switch (line.kind) {
      case "notice":
        try {
          reached(line.reach, line.args);
        } catch (thrown) {
          deps.fault(
            `renderer notice ${line.reach} threw: ${failureOf(thrown).detail}`,
          );
        }
        return;
      case "call":
        void calling(line.reach, line.args)
          .then(
            (value): Returned => ({ kind: "ok", value }),
            (thrown: unknown): Returned => ({
              kind: "failed",
              failure: failureOf(thrown),
            }),
          )
          .then((returned) =>
            gone === null
              ? send({ kind: "returned", n: line.n, returned })
              : undefined,
          );
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
    heapSnapshot: (file) =>
      owe<void>(
        "a heap snapshot",
        (n) => ({ kind: "heap-snapshot", n, file }),
        (heard, resolve, reject) => {
          if (heard.kind !== "heap-snapshot") return false;
          if (heard.written.kind === "ok") resolve();
          else reject(new CrossedFailure(heard.written.failure));
          return true;
        },
      ),
    heard,
    ended: (why) => {
      gone ??= why;
      const waiting = [...owed.values()];
      owed.clear();
      for (const each of waiting) each.fail(why);
    },
  };
}

// The host as a renderer in another process holds it: each reach a line,
// each awaited call resolved by the `returned` that names it.
export interface HostOverLines {
  readonly host: AdapterToHost;
  readonly returned: (n: number, returned: Returned) => void;
}

export function hostOverLines(
  send: (line: RendererLine) => void,
): HostOverLines {
  const waiting = new Map<
    number,
    {
      readonly resolve: (v: unknown) => void;
      readonly reject: (e: Error) => void;
    }
  >();
  let next = 0;
  const reach =
    (path: ReachPath, kind: "notice" | "call"): Reach =>
    (...args) => {
      if (kind === "notice") {
        send({ kind: "notice", reach: path, args });
        return undefined;
      }
      return new Promise((resolve, reject) => {
        const n = ++next;
        waiting.set(n, { resolve, reject });
        send({ kind: "call", n, reach: path, args });
      });
    };
  const host: Record<string, unknown> = {};
  for (const [path, kind] of REACHES) {
    const keys = path.split(".");
    const leaf = keys.pop() as string;
    const group = keys.reduce<Record<string, unknown>>(
      (at, key) => (at[key] ??= {}) as Record<string, unknown>,
      host,
    );
    group[leaf] = reach(path, kind);
  }
  return {
    // [LAW:types-are-the-program] exception: built from `REACH_KINDS`, whose
    // type is `AdapterToHost`'s own shape, so every reach is here.
    host: host as unknown as AdapterToHost,
    returned: (n, returned) => {
      const call = waiting.get(n);
      // [LAW:no-silent-failure] A return for no call is the host's bug.
      if (call === undefined)
        throw new Error(`the host returned call ${n}, which is not waiting`);
      waiting.delete(n);
      if (returned.kind === "ok") call.resolve(returned.value);
      else call.reject(new CrossedFailure(returned.failure));
    },
  };
}

// The renderer's side of the lines past its boot: each input answered by
// its output, every reach's return handed back, and the host's reads of the
// process answered here, outside any turn.
export function serveRenderer(deps: {
  readonly renderer: Renderer;
  readonly host: HostOverLines;
  readonly send: (line: RendererLine) => void;
  readonly memory: () => MemorySizes;
  readonly heapSnapshot: (file: string) => void;
  readonly clock: Pick<Timekeeper, "defer">;
}): (line: HostLine) => void {
  const { renderer, send } = deps;
  type InputLine = Extract<HostLine, { kind: "input" }>;
  // [LAW:no-silent-failure] An input whose answer rejected is answered as
  // that input's failure, never left to end the process.
  const answered = (line: InputLine): void =>
    void (
      renderer.answer as (
        i: RendererInput,
      ) => Promise<RendererOutput | AdapterOutput>
    )(line.input).then(
      (output) => send({ kind: "output", n: line.n, output }),
      (thrown: unknown) =>
        send({ kind: "rejected", n: line.n, failure: failureOf(thrown) }),
    );
  // [LAW:no-ambient-temporal-coupling] The renderer is one thread, and a
  // chunk's lines are heard in one synchronous loop, so a frame drawn as it is
  // heard draws ahead of every event heard with it or after it, and of their
  // continuations. Each frame is drawn on a turn of its own, after the frame
  // heard before it, so an event waits behind at most the frame drawing as it
  // arrives.
  let lastFrame: Promise<void> = Promise.resolve();
  return (line) => {
    switch (line.kind) {
      case "input":
        if (line.input.kind === "adapter" && line.input.push.kind === "frame")
          lastFrame = lastFrame
            .then(() => new Promise<void>((turn) => deps.clock.defer(turn)))
            .then(() => answered(line));
        else answered(line);
        return;
      case "returned":
        deps.host.returned(line.n, line.returned);
        return;
      case "ping":
        send({ kind: "ping", n: line.n, usage: deps.memory() });
        return;
      case "heap-snapshot": {
        let written: Extract<
          RendererLine,
          { kind: "heap-snapshot" }
        >["written"];
        try {
          deps.heapSnapshot(line.file);
          written = { kind: "ok" };
        } catch (thrown) {
          written = { kind: "failed", failure: failureOf(thrown) };
        }
        send({ kind: "heap-snapshot", n: line.n, written });
        return;
      }
      case "boot":
        throw new Error("a second boot");
    }
  };
}
