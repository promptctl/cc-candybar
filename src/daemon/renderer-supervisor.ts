// The host's supervisor of its renderer: it starts one when armed, or on the
// first input if it never was, and starts another once one ends, after a
// backoff that grows while renderers end young, so one that dies as it starts
// is started again every so often, not on every input. Each start is
// complete: it carries every session the host holds live, so the renderer
// that answers holds what the one before it held, but the unsaved state its
// process kept. No part outside this file knows whether a renderer restarted.

import type {
  AdapterPush,
  AdapterToHost,
  StorageHoldId,
  WatchId,
} from "../renderer-interface/adapter.js";
import {
  generationOf,
  type AdapterInput,
  type AdapterOutput,
  type EventInput,
  type Generation,
  type RendererInput,
  type RendererOutput,
  type SessionSnapshot,
  type StartCause,
} from "../renderer-interface/interface.js";
import type { Instant } from "../utils/instant.js";
import type { DaemonLogger } from "../utils/logger";
import { eventLine } from "../utils/logfmt.js";
import type { SessionId } from "./foundations/session-id.js";
import { failureOf } from "./foundations/verb-error.js";
import type {
  Invalidation,
  WatcherHandle,
  WatchTargets,
} from "./foundations/watch-targets.js";

// One input's output, with the renderer's own span of its turn.
export interface Crossed {
  readonly output: RendererOutput | AdapterOutput;
  readonly tookMs: number;
}

// One running renderer, over whichever transport carries it.
export interface RendererLink {
  answer(input: RendererInput): Promise<Crossed>;
  // [LAW:no-silent-failure] How it ended, in words ("exited with code 1"):
  // every input still out fails, and the next start says it.
  readonly ended: Promise<string>;
  // Asks it to finish, and resolves once it has ended.
  end(): Promise<void>;
}

// How a renderer starts, handed the host it reaches and the generation it
// mints its ids under.
export type StartRenderer = (
  host: AdapterToHost,
  generation: Generation,
) => RendererLink;

// One input's output, and what crossing to the renderer cost beyond its turn.
export interface Hopped<O> {
  readonly output: O;
  readonly hopMs: number;
}

// [LAW:one-type-per-behavior] What the host's one path to its renderer
// reaches: the renderer interface with each answer's hop.
export interface HostedRenderer {
  answer(input: EventInput): Promise<Hopped<RendererOutput>>;
  answer(input: AdapterInput): Promise<Hopped<AdapterOutput>>;
}

// [LAW:no-ambient-temporal-coupling] When a renderer that ended starts again:
// at once after one that lived, and after an exponential backoff for each in
// a row that ended young, so a renderer that cannot start costs a start every
// minute at most.
export const RESTART = {
  youngMs: 60_000,
  firstBackoffMs: 1_000,
  maxBackoffMs: 60_000,
} as const;

export const restartDelayMs = (endedYoung: number): number =>
  endedYoung === 0
    ? 0
    : Math.min(
        RESTART.firstBackoffMs * 2 ** (endedYoung - 1),
        RESTART.maxBackoffMs,
      );

export interface SupervisorDeps {
  readonly start: StartRenderer;
  // The host's parts every renderer reaches alike: its watches and its storage
  // holds are kept per renderer, here.
  readonly host: Omit<AdapterToHost, "watches" | "storage">;
  readonly watches: {
    acquire(
      key: string,
      targets: WatchTargets,
      told: (heard: Invalidation | null) => void,
    ): WatcherHandle;
  };
  readonly storage: AdapterToHost["storage"];
  // [LAW:one-source-of-truth] Every session the host holds live, as a start
  // carries it: its latest context with the document last stamped for it.
  readonly sessions: () => ReadonlyArray<Omit<SessionSnapshot, "pinned">>;
  readonly monotonic: () => number;
  readonly now: () => Instant;
  // A turn later, as a push from another process arrives after the notice
  // that asked for it.
  readonly defer: (run: () => void) => void;
  // A restart's wait; what it returns cancels it.
  readonly after: (ms: number, run: () => void) => () => void;
  readonly log: DaemonLogger;
}

export interface Supervisor extends HostedRenderer {
  // Starts the first renderer, off any request's path.
  arm(): void;
  // [LAW:no-ambient-temporal-coupling] After this nothing starts; it resolves
  // once the running renderer has ended.
  close(): Promise<void>;
}

// What one renderer asked the host to hold: its watches and its storage
// holds, by the ids it minted, released together once it has gone.
interface Scope {
  readonly host: AdapterToHost;
  // The renderer's link, once built: a watch's pushes go to the renderer
  // that holds the watch, and none once it ended.
  link: RendererLink | null;
  dead: boolean;
  release(): void;
}

interface Live {
  readonly generation: Generation;
  readonly link: RendererLink;
  readonly scope: Scope;
  readonly startedAt: number;
  // Settled once the start answered: every input waits for it.
  readonly ready: Promise<void>;
}

// [LAW:types-are-the-program] Whether a renderer runs, and if none does, why.
type State =
  | { readonly kind: "idle" }
  | { readonly kind: "live"; readonly live: Live }
  | {
      readonly kind: "down";
      readonly ended: string;
      readonly cancel: () => void;
    }
  | { readonly kind: "closed" };

// Pushes that need no renderer when none runs: a teardown step finds nothing
// to close, and a pin is carried by the next start.
const CARRIED: ReadonlySet<AdapterPush["kind"]> = new Set([
  "close-journal",
  "close-views",
  "close-session-state",
  "pin",
  "unpin",
]);

export function superviseRenderer(deps: SupervisorDeps): Supervisor {
  const { log } = deps;
  let state: State = { kind: "idle" };
  let generations = 0;
  // How many renderers in a row ended young: what the next restart waits by.
  let endedYoung = 0;
  // [LAW:one-source-of-truth] The sessions whose feed is pinned, as the pins
  // and unpins passed on say, recorded as each arrives, so a start pins what
  // the renderer before it held.
  const pinned = new Set<SessionId>();
  // Scopes of renderers that ended, released once the next start answered, so
  // a folder both name is never closed between them.
  let ended: Scope[] = [];

  const push = (scope: Scope, push: AdapterPush): void => {
    const { link } = scope;
    if (scope.dead || link === null) return;
    void link.answer({ kind: "adapter", push, at: deps.now() }).then(
      ({ output }) => {
        if ("kind" in output && output.kind === "threw")
          log(
            "error",
            `renderer push ${push.kind} threw: ${output.failure.detail}`,
          );
      },
      (thrown: unknown) => {
        if (!scope.dead)
          log("error", `renderer push ${push.kind} failed: ${String(thrown)}`);
      },
    );
  };

  const scopeOf = (): Scope => {
    const watches = new Map<WatchId, WatcherHandle>();
    const holds = new Set<StorageHoldId>();
    const scope: Scope = {
      host: {
        ...deps.host,
        watches: {
          watch: (id, key, targets) => {
            const told = (heard: Invalidation | null): void =>
              push(scope, { kind: "watch", id, heard, deaf: handle.deaf });
            const handle = deps.watches.acquire(key, targets, told);
            watches.set(id, handle);
            // [LAW:no-ambient-temporal-coupling] The acquire's own push goes
            // after the notice that asked for it, however the renderer is
            // carried: a renderer's start acquires watches before its link
            // exists.
            deps.defer(() => {
              if (watches.get(id) === handle) told(null);
            });
          },
          unwatch: (id) => {
            watches.get(id)?.release();
            watches.delete(id);
          },
        },
        storage: {
          hold: (id, folders) => {
            holds.add(id);
            deps.storage.hold(id, folders);
          },
          release: (id) => {
            holds.delete(id);
            deps.storage.release(id);
          },
        },
      },
      link: null,
      dead: false,
      release: () => {
        for (const handle of watches.values()) handle.release();
        watches.clear();
        for (const id of holds) deps.storage.release(id);
        holds.clear();
      },
    };
    return scope;
  };

  const startOne = (cause: StartCause): Extract<State, { kind: "live" }> => {
    const generation = ++generations as Generation;
    const scope = scopeOf();
    const link = deps.start(scope.host, generation);
    scope.link = link;
    const startedAt = deps.monotonic();
    const sessions = deps
      .sessions()
      .map((s) => ({ ...s, pinned: pinned.has(s.worldState.session) }));
    // [LAW:no-silent-failure] A start that threw, or whose renderer ended
    // first, is said here; the inputs after it reach the link, which fails
    // each with how it ended.
    const ready = link
      .answer({ kind: "start", start: { cause, sessions }, at: deps.now() })
      .then(
        ({ output }) =>
          "kind" in output && output.kind === "threw" ? output.failure : null,
        (thrown: unknown) => failureOf(thrown),
      )
      .then((failed) => {
        log(
          failed === null ? "info" : "error",
          eventLine("renderer start", [
            ["generation", String(generation)],
            ["cause", cause.kind],
            ["sessions", String(sessions.length)],
            ["took", `${Math.round(deps.monotonic() - startedAt)}ms`],
            ...(failed === null ? [] : ([["error", failed.detail]] as const)),
          ]),
        );
        // What the renderers before this one held goes now that this one
        // holds what it needs.
        for (const gone of ended) gone.release();
        ended = [];
      });
    void link.ended.then((words) => {
      scope.dead = true;
      ended.push(scope);
      const current = state.kind === "live" && state.live.link === link;
      if (!current) {
        log(
          "info",
          eventLine("renderer end", [
            ["generation", String(generation)],
            ["ended", words],
          ]),
        );
        return;
      }
      endedYoung =
        deps.monotonic() - startedAt < RESTART.youngMs ? endedYoung + 1 : 0;
      const delay = restartDelayMs(endedYoung);
      log(
        "warn",
        eventLine("renderer end", [
          ["generation", String(generation)],
          ["ended", words],
          ["restart", `${delay}ms`],
        ]),
      );
      let cancel = (): void => {};
      state = { kind: "down", ended: words, cancel: () => cancel() };
      cancel = deps.after(delay, () => {
        state = startOne({ kind: "crashed", ended: words });
      });
    });
    return {
      kind: "live",
      live: { generation, link, scope, startedAt, ready },
    };
  };

  // [LAW:single-enforcer] The one place an input reaches a renderer.
  const answer = async (input: RendererInput): Promise<Hopped<unknown>> => {
    if (input.kind === "event" && input.event.kind === "effect-done") {
      const of = input.event.of;
      // [LAW:no-silent-failure] A renderer's effects go with it: one that
      // ended cannot settle what it returned.
      if (state.kind !== "live" || generationOf(of) !== state.live.generation)
        throw new Error(
          `effect ${of} was returned by a renderer that has ended`,
        );
    }
    if (input.kind === "adapter") {
      const { push } = input;
      if (push.kind === "pin") pinned.add(push.session);
      if (push.kind === "unpin") pinned.delete(push.session);
      if (CARRIED.has(push.kind) && state.kind !== "live")
        return { output: { kind: push.kind }, hopMs: 0 };
    }
    if (state.kind === "idle") state = startOne({ kind: "first" });
    switch (state.kind) {
      case "closed":
        throw new Error("the renderer supervisor is closed");
      case "down":
        throw new Error(
          `no renderer runs: its process ${state.ended}, and another is starting`,
        );
    }
    const running = state.live;
    await running.ready;
    const from = deps.monotonic();
    const { output, tookMs } = await running.link.answer(input);
    return {
      output,
      hopMs: Math.max(0, Math.round(deps.monotonic() - from - tookMs)),
    };
  };

  return {
    // [LAW:types-are-the-program] exception: each input's output is its own
    // kind's, as the renderer answered it; one dispatch cannot name that.
    answer: answer as HostedRenderer["answer"],
    arm: () => {
      if (state.kind === "idle") state = startOne({ kind: "first" });
    },
    close: async () => {
      const was = state;
      state = { kind: "closed" };
      if (was.kind === "down") was.cancel();
      if (was.kind === "live") await was.live.link.end();
      // What every renderer held goes with the host: none follows them.
      for (const gone of ended) gone.release();
      ended = [];
    },
  };
}
