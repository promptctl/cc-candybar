// The host's supervisor of its renderer: it starts one on the first input,
// and after one ended, on the next input, never on the end itself, so a
// renderer that dies as it starts is not started in a loop. Each start is
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
  readonly log: DaemonLogger;
}

export interface Supervisor extends HostedRenderer {
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
  // Settled once the start answered: every input waits for it.
  readonly ready: Promise<void>;
}

const CLOSES: ReadonlySet<AdapterPush["kind"]> = new Set([
  "close-journal",
  "close-views",
  "close-session-state",
]);

export function superviseRenderer(deps: SupervisorDeps): Supervisor {
  const { log } = deps;
  let live: Live | null = null;
  let generations = 0;
  let cause: StartCause = { kind: "first" };
  let closed = false;
  // [LAW:one-source-of-truth] The sessions whose feed is pinned, as the pins
  // and unpins passed on say, so a start pins what the renderer before it
  // held, and the pin that starts a renderer is not counted twice.
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

  const startOne = (): Live => {
    const generation = ++generations as Generation;
    const scope = scopeOf();
    const link = deps.start(scope.host, generation);
    scope.link = link;
    const startedAt = deps.monotonic();
    const sessions = deps
      .sessions()
      .map((s) => ({ ...s, pinned: pinned.has(s.worldState.session) }));
    const started = cause;
    const ready = link
      .answer({
        kind: "start",
        start: { cause: started, sessions },
        at: deps.now(),
      })
      .then(({ output }) => {
        const failed =
          "kind" in output && output.kind === "threw" ? output.failure : null;
        log(
          failed === null ? "info" : "error",
          eventLine("renderer start", [
            ["generation", String(generation)],
            ["cause", started.kind],
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
      log(
        closed ? "info" : "warn",
        eventLine("renderer end", [
          ["generation", String(generation)],
          ["ended", words],
        ]),
      );
      if (live?.link !== link) return;
      live = null;
      cause = { kind: "crashed", ended: words };
      ended.push(scope);
    });
    return { generation, link, scope, ready };
  };

  // [LAW:single-enforcer] The one place an input reaches a renderer, which
  // it starts when none runs.
  const answer = async (input: RendererInput): Promise<Hopped<unknown>> => {
    if (input.kind === "event" && input.event.kind === "effect-done") {
      const of = input.event.of;
      // [LAW:no-silent-failure] A renderer's effects go with it: one that
      // ended cannot settle what it returned.
      if (live === null || generationOf(of) !== live.generation)
        throw new Error(
          `effect ${of} was returned by a renderer that has ended`,
        );
    }
    // A teardown step finds nothing to close when no renderer runs: none
    // started, or the last one ended, and none starts to be closed.
    if (
      input.kind === "adapter" &&
      CLOSES.has(input.push.kind) &&
      live === null
    )
      return { output: { kind: input.push.kind }, hopMs: 0 };
    if (live === null) {
      if (closed) throw new Error("the renderer supervisor is closed");
      live = startOne();
    }
    const running = live;
    await running.ready;
    if (input.kind === "adapter") {
      const { push } = input;
      if (push.kind === "pin") pinned.add(push.session);
      if (push.kind === "unpin") pinned.delete(push.session);
    }
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
    close: async () => {
      closed = true;
      const running = live;
      if (running !== null) await running.link.end();
      // What renderers that ended held goes with the host: none follows them.
      for (const gone of ended) gone.release();
      ended = [];
    },
  };
}
