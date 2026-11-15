// The renderer interface over a line channel: what a host and a renderer in
// another process say to each other, one JSON value per line. The host sends
// inputs and the answers to the renderer's calls; the renderer sends each
// input's output and its reaches into the host. Each side parses what it
// receives, one parser per direction.
//
// [LAW:one-type-per-behavior] The interface and the adapter are the same
// values on both transports: in process a turn is a call, here a line each
// way, so a renderer cannot tell which carries it.

import {
  CrossedFailure,
  failureOf,
  type Failure,
} from "../daemon/foundations/verb-error.js";
import type { AdapterToHost } from "./adapter.js";
import type {
  AdapterOutput,
  Renderer,
  RendererInput,
  RendererOutput,
} from "./interface.js";

// A process's end of a channel of lines: it sends one line at a time, and
// hears each line the other end sent, in order.
export interface LineChannel {
  readonly send: (line: string) => void;
  readonly hear: (heard: (line: string) => void) => void;
}

export type Reached =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: Failure };

// What the host sends a renderer.
export type ToRenderer =
  | { readonly k: "input"; readonly id: number; readonly input: RendererInput }
  | { readonly k: "reached"; readonly id: number; readonly outcome: Reached };

// What a renderer sends its host: an input's output with the renderer's own
// span of its turn, and a reach, whose id is null when it is a notice nobody
// answers.
export type ToHost =
  | {
      readonly k: "output";
      readonly id: number;
      readonly output: RendererOutput | AdapterOutput;
      readonly tookMs: number;
    }
  | {
      readonly k: "reach";
      readonly id: number | null;
      readonly path: string;
      readonly args: readonly unknown[];
    };

// [LAW:types-are-the-program] Each reach of the adapter, spelled by how it
// crosses: a notice nobody answers, or a call whose promise the host's answer
// settles. Total over the adapter, so a reach added there fails the build
// until it is spelled here.
export type Spelling<T> = {
  readonly [K in keyof T]: T[K] extends (...args: never[]) => infer R
    ? R extends Promise<unknown>
      ? "call"
      : "notice"
    : Spelling<T[K]>;
};

export const ADAPTER_SPELLING: Spelling<AdapterToHost> = {
  wake: "notice",
  log: "notice",
  launch: "call",
  typeSlash: "call",
  applyUpdate: "call",
  runs: { start: "notice", refused: "notice" },
  refresh: "call",
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
  probes: { arrive: "notice" },
  pipeEventAnswered: "notice",
  watches: { watch: "notice", unwatch: "notice" },
  storage: { hold: "notice", release: "notice" },
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// [LAW:parse-dont-validate] The envelope of each line is parsed; what it
// carries is the interface's own type, because both ends are one bundle the
// host started. A line that does not parse is the other end's bug, thrown.
// [LAW:types-are-the-program] exception: the payloads below are cast.
export function parseToRenderer(line: string): ToRenderer {
  const v: unknown = JSON.parse(line);
  if (isRecord(v) && typeof v.id === "number") {
    if (v.k === "input" && isRecord(v.input))
      return {
        k: "input",
        id: v.id,
        input: v.input as unknown as RendererInput,
      };
    if (v.k === "reached" && isRecord(v.outcome))
      return {
        k: "reached",
        id: v.id,
        outcome: v.outcome as unknown as Reached,
      };
  }
  throw new Error(`not a line a host sends a renderer: ${line.slice(0, 200)}`);
}

export function parseToHost(line: string): ToHost {
  const v: unknown = JSON.parse(line);
  if (isRecord(v)) {
    if (
      v.k === "output" &&
      typeof v.id === "number" &&
      typeof v.tookMs === "number" &&
      isRecord(v.output)
    )
      return {
        k: "output",
        id: v.id,
        output: v.output as unknown as RendererOutput | AdapterOutput,
        tookMs: v.tookMs,
      };
    if (
      v.k === "reach" &&
      (typeof v.id === "number" || v.id === null) &&
      typeof v.path === "string" &&
      Array.isArray(v.args)
    )
      return { k: "reach", id: v.id, path: v.path, args: v.args };
  }
  throw new Error(
    `not a line a renderer sends its host: ${line.slice(0, 200)}`,
  );
}

const lineOf = (message: ToRenderer | ToHost): string =>
  JSON.stringify(message);

// The host as a renderer in another process reaches it: each reach is a line,
// and a call's promise settles with the host's answer to it.
function remoteHost<T>(
  spelling: Spelling<T>,
  reach: (path: string, args: readonly unknown[], call: boolean) => unknown,
  prefix: string,
): T {
  // [LAW:types-are-the-program] exception: the object is built key by key
  // from the spelling, which is total over T.
  return Object.fromEntries(
    Object.entries(spelling).map(([key, spelt]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return [
        key,
        spelt === "call"
          ? (...args: unknown[]) => reach(path, args, true)
          : spelt === "notice"
            ? (...args: unknown[]) => void reach(path, args, false)
            : remoteHost(spelt as Spelling<unknown>, reach, path),
      ];
    }),
  ) as T;
}

// [LAW:single-enforcer] One reach performed on the host's adapter, by its
// path: the member named last, called on the object that holds it.
function reachInto(
  host: AdapterToHost,
  path: string,
  args: readonly unknown[],
): unknown {
  const names = path.split(".");
  const holder = names
    .slice(0, -1)
    .reduce<unknown>(
      (at, name) => (at as Record<string, unknown>)[name],
      host,
    ) as Record<string, (...a: unknown[]) => unknown>;
  const member = holder[names[names.length - 1]!];
  if (typeof member !== "function")
    throw new Error(`the adapter has no reach ${path}`);
  return member.apply(holder, [...args]);
}

// The renderer's end: it builds the renderer over the host it reaches through
// the channel, answers each input it hears, and settles each of its calls
// with the host's answer. `monotonic` times each turn.
export function serveRenderer(
  channel: LineChannel,
  build: (host: AdapterToHost) => Renderer,
  monotonic: () => number,
): void {
  const calls = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  let lastCall = 0;
  const send = (message: ToHost): void => channel.send(lineOf(message));
  const host = remoteHost(
    ADAPTER_SPELLING,
    (path, args, call) => {
      if (!call) {
        send({ k: "reach", id: null, path, args });
        return undefined;
      }
      const id = ++lastCall;
      send({ k: "reach", id, path, args });
      return new Promise((resolve, reject) =>
        calls.set(id, { resolve, reject }),
      );
    },
    "",
  );
  const renderer = build(host);
  channel.hear((line) => {
    const heard = parseToRenderer(line);
    switch (heard.k) {
      case "input": {
        const from = monotonic();
        // [LAW:types-are-the-program] exception: the overloads answer each
        // kind of input with its own output, which one call cannot name.
        void (
          renderer.answer as (
            input: RendererInput,
          ) => Promise<RendererOutput | AdapterOutput>
        )(heard.input).then((output) =>
          send({
            k: "output",
            id: heard.id,
            output,
            tookMs: monotonic() - from,
          }),
        );
        return;
      }
      case "reached": {
        const call = calls.get(heard.id);
        if (call === undefined)
          throw new Error(`an answer to call ${heard.id}, which is not open`);
        calls.delete(heard.id);
        if (heard.outcome.ok) call.resolve(heard.outcome.value);
        else call.reject(new CrossedFailure(heard.outcome.failure));
      }
    }
  });
}

// The host's end: each input goes out as a line, and its output, with the
// renderer's span of its turn, settles it. Every reach the renderer sends is
// performed on `host`; a call is answered, and a notice that threw is logged
// through the host's own log.
export interface WireRenderer {
  answer(
    input: RendererInput,
  ): Promise<{ output: RendererOutput | AdapterOutput; tookMs: number }>;
  // [LAW:no-silent-failure] Every input still out fails with `reason`: the
  // renderer's end is gone, and nothing will answer it.
  fail(reason: Error): void;
}

export function wireRenderer(
  channel: LineChannel,
  host: AdapterToHost,
): WireRenderer {
  const pending = new Map<
    number,
    {
      resolve: (v: {
        output: RendererOutput | AdapterOutput;
        tookMs: number;
      }) => void;
      reject: (e: unknown) => void;
    }
  >();
  let lastInput = 0;
  let failed: Error | null = null;
  const send = (message: ToRenderer): void => channel.send(lineOf(message));
  const answerCall = (id: number, outcome: Reached): void => {
    if (failed === null) send({ k: "reached", id, outcome });
  };
  channel.hear((line) => {
    const heard = parseToHost(line);
    switch (heard.k) {
      case "output": {
        const input = pending.get(heard.id);
        if (input === undefined)
          throw new Error(`an output for input ${heard.id}, which is not out`);
        pending.delete(heard.id);
        input.resolve({ output: heard.output, tookMs: heard.tookMs });
        return;
      }
      case "reach": {
        const { id, path, args } = heard;
        if (id === null) {
          try {
            reachInto(host, path, args);
          } catch (thrown) {
            host.log(
              "error",
              `renderer notice ${path} threw: ${failureOf(thrown).detail}`,
            );
          }
          return;
        }
        // [LAW:no-ambient-temporal-coupling] Performed as its line arrives,
        // as a notice is, so the host runs the renderer's reaches in the
        // order it made them; a throw rejects the call.
        void new Promise((resolve) =>
          resolve(reachInto(host, path, args)),
        ).then(
          (value) => answerCall(id, { ok: true, value }),
          (thrown: unknown) =>
            answerCall(id, { ok: false, failure: failureOf(thrown) }),
        );
      }
    }
  });
  return {
    answer: (input) => {
      if (failed !== null) return Promise.reject(failed);
      const id = ++lastInput;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ k: "input", id, input });
      });
    },
    fail: (reason) => {
      failed ??= reason;
      for (const { reject } of pending.values()) reject(reason);
      pending.clear();
    },
  };
}
