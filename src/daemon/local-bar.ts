// A bar drawn in this process for a command, through the daemon's own parts:
// a collector over the owners the command hands it, the main renderer in
// process, the host between them, and each request answered as a statusline
// request is answered (`answerStatusline`). [LAW:single-enforcer] So what a
// command shows is what the daemon draws: there is no second renderer.
//
// It serves one origin, whose config the command discovered: the renderer
// subscribes it, and the host hands in that snapshot. A command performs no
// act and writes no config, so anything that would refuses loudly.

import type { World } from "../host.js";
import type { ConfigSnapshot } from "../config/config-snapshot.js";
import { originKey, type RenderOrigin } from "../config-hint.js";
import type { Gates } from "./foundations/gates.js";
import { MAIN_RENDERER } from "./foundations/renderer-name.js";
import type {
  Event,
  Renderer,
  RequestId,
} from "../renderer-interface/interface.js";
import type { AdapterToHost } from "../renderer-interface/adapter.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import type { StoredState } from "../renderer-interface/stored-state.js";
import { IDLE, type DaemonFacts } from "../facts/world-state.js";
import { ABSENT } from "../utils/outcome.js";
import type { Instant } from "../utils/instant.js";
import { mainRendererOf, type MainRendererInputs } from "../renderer/main.js";
import { locations } from "./paths.js";
import { memoryLimitBytes } from "./limits.js";
import { Collector } from "./collector.js";
import { SourceRuns } from "./source-runs.js";
import type { RenderPayloadDeps } from "./readings.js";
import { inProcessRenderer } from "./renderer-process.js";
import {
  rendererHost,
  type HostTurn,
  type RendererHost,
} from "./renderer-host.js";
import {
  answerStatusline,
  type Locate,
  type StatuslineAnswer,
} from "./statusline-answer.js";
import type { SessionEnvironment } from "./foundations/session-env.js";
import type { RequestFacts } from "./foundations/request-event.js";
import type { LinkSigner } from "../click/link-signer.js";
import type { DaemonLogger } from "../utils/logger.js";

// What builds the renderer: the main renderer, unless a test wraps it.
export type RendererBuilder = (
  inputs: MainRendererInputs,
  host: AdapterToHost,
) => Renderer;

export interface LocalBarInputs {
  readonly world: World;
  // The gates the daemon holds, so what the bar refuses is what the
  // daemon's load refuses.
  readonly gates: Gates;
  readonly linkSigner: LinkSigner;
  // The trust book's directory.
  readonly stateDir: string;
  // The home every session's payload abbreviates its paths under, and
  // where each session's directory sits in its repository.
  readonly home: string;
  readonly locate: Locate;
  // The one origin the bar serves, and what discovery found there.
  readonly origin: RenderOrigin;
  readonly snapshot: ConfigSnapshot;
  // The renderer's stored state: each session's picks.
  readonly stored: StoredState;
  // The owners every session's readings come from, over the bar's own owner
  // of its sources' runs and its log.
  readonly owners: (
    sourceRuns: SourceRuns,
    log: DaemonLogger,
  ) => RenderPayloadDeps;
  readonly daemon: () => DaemonFacts;
  readonly build?: RendererBuilder;
}

// One request's answer, with every turn the host took for it, in order: the
// session's context, then the request, unless the context turn threw.
export interface LocalDraw {
  readonly answer: StatuslineAnswer;
  readonly turns: readonly HostTurn[];
  readonly facts: RequestFacts;
}

export type ClickEvent = Extract<Event, { kind: "click" }>;

export interface LocalBar {
  // [LAW:no-ambient-temporal-coupling] `waitEndsAt` is the monotonic moment
  // the request's wait on its world state ends.
  draw(
    req: CheckedRenderRequest,
    environment: SessionEnvironment,
    waitEndsAt: number,
  ): Promise<LocalDraw>;
  // A click the command makes on its own bar, answered as the daemon answers
  // a click: the collector keeps its session, and the renderer takes it.
  click(event: ClickEvent): Promise<HostTurn>;
  // [LAW:no-ambient-temporal-coupling] The value of `key` on the first turn
  // record that carries it from this call on, whatever input the turn took —
  // a request, a click, or a world state the collector delivered — or null
  // once the monotonic moment `endsAt` passes first, or the bar closes.
  noted(key: string, endsAt: number): Promise<string | null>;
  // [LAW:no-silent-failure] Every line logged as an error, and every failure
  // the host could put on no bar, in order: a command fails on each.
  errors(): readonly string[];
  close(): Promise<void>;
}

const NO_ACT = "a command performs no act";

// The daemon's own facts as a command holds them: no update offered, no
// file-events, launcher, renderer or act fault. What the command's own world
// could not drop from its environment is its own (`Host.dropped`).
export function commandDaemonFacts(
  at: Instant,
  environmentFault: string | null,
): DaemonFacts {
  return {
    update: { newer: { ...ABSENT, at }, act: IDLE, actsError: null },
    environmentFault,
    fileEvents: [],
    launcher: [],
    rendererEnded: null,
    actFailed: null,
  };
}

export function localBar(inputs: LocalBarInputs): LocalBar {
  const { world, origin, snapshot } = inputs;
  const build = inputs.build ?? mainRendererOf;
  const errors: string[] = [];
  const log: DaemonLogger = (level, line) => {
    if (level === "error") errors.push(line);
  };
  let closing = false;
  const sourceRuns = new SourceRuns({
    launcher: world.launcher,
    clock: world.clock,
  });
  // [LAW:no-ambient-temporal-coupling] The collector hands what it stamps
  // alone to the host, which exists once the collector does.
  let host: RendererHost | null = null;
  const collector = new Collector({
    owners: inputs.owners(sourceRuns, log),
    daemon: inputs.daemon,
    clock: world.clock,
    // No feed draws a command's sessions.
    watched: () => false,
    deliver: (event) => {
      if (host === null)
        throw new Error("the collector handed in before the host was built");
      return host.deliver(() => ({ kind: "event", event }), []);
    },
    log,
  });
  const reaches: AdapterToHost = {
    log,
    // A command's bar holds no daemon-wide event.
    eventAnswered: () => {},
    // A command's sessions read no plugin's storage (their owners answer
    // it), so there is no folder to hold.
    storage: { hold: () => {}, release: () => {} },
  };
  const link = inProcessRenderer(
    MAIN_RENDERER,
    (adapter) =>
      build(
        {
          stored: inputs.stored,
          linkSigner: inputs.linkSigner,
          locations: locations(world.host),
          home: inputs.home,
          gates: inputs.gates,
          memoryLimitBytes: memoryLimitBytes(world.host.env),
        },
        adapter,
      ),
    reaches,
    world.clock,
  );
  link.serve();
  // [LAW:single-enforcer] The one origin, refused loudly for any other: a
  // renderer that names another found a bug in the request it was handed.
  const served = originKey(origin);
  const ours = (named: RenderOrigin): void => {
    if (originKey(named) !== served)
      throw new Error(
        `the bar serves origin ${JSON.stringify(served)}, not ${JSON.stringify(originKey(named))}`,
      );
  };
  const refused = (): never => {
    throw new Error(NO_ACT);
  };
  const turns: HostTurn[] = [];
  // A wait on a note: its key and how it ends.
  const waiting = new Map<string, Set<(value: string | null) => void>>();
  const rendered = rendererHost(
    MAIN_RENDERER,
    world.clock,
    link.renderer,
    log,
    {
      subscribed: (subscriptions) => collector.subscribed(subscriptions),
      // No feed draws a command's sessions, so its frames go nowhere.
      frames: () => {},
      // A command's stores live and die with it: nothing reaches the
      // profile's files.
      stored: () => {},
      holding: (session) => collector.holding(session),
      // A command performs no act, so no change writes a settings file.
      writableSettings: () => [],
      // [LAW:single-enforcer] Every turn's record, whatever input it took,
      // so a wait on a note sees each one.
      recorded: (record) => {
        for (const [key, value] of record)
          waiting.get(key)?.forEach((done) => done(value));
      },
    },
    {
      perform: async () => refused(),
      stateDir: inputs.stateDir,
      configs: {
        follow: (origins) => origins.forEach(ours),
        snapshotOf: (named) => {
          ours(named);
          return snapshot;
        },
        landed: refused,
        path: refused,
        repoDir: refused,
      },
      closing: () => closing,
      unheard: (text) => errors.push(text),
    },
  );
  // Each turn a request's answer takes, as the host took it.
  host = {
    ...rendered,
    answer: async (make) => {
      const turn = await rendered.answer(make);
      turns.push(turn);
      return turn;
    },
  };
  const answering = host;
  let id = 0;
  return {
    draw: async (req, environment, waitEndsAt) => {
      const facts: RequestFacts = [];
      const from = turns.length;
      const answer = await answerStatusline(
        answering,
        collector,
        world.clock,
        new AbortController().signal,
        log,
        inputs.locate,
        req,
        environment,
        ++id as RequestId,
        waitEndsAt,
        facts,
      );
      // A command takes its answer as it is drawn.
      answer.settled(true);
      return { answer, turns: turns.slice(from), facts };
    },
    click: (event) => {
      if (event.session?.ok) collector.clicked(event.session.id);
      return answering.answer(() => ({ kind: "event", event }));
    },
    noted: (key, endsAt) =>
      new Promise((resolve) => {
        const waits = waiting.get(key) ?? new Set();
        waiting.set(key, waits);
        const done = (value: string | null): void => {
          waits.delete(done);
          cancel();
          resolve(value);
        };
        waits.add(done);
        const cancel = world.clock.after(
          Math.max(0, endsAt - world.clock.monotonic()),
          () => done(null),
        );
      }),
    errors: () => errors,
    // The daemon's teardown, in its order: no `due` from here, every journal
    // closed, the collector's holds released before the views close, and the
    // runs last.
    close: async () => {
      for (const waits of waiting.values()) waits.forEach((done) => done(null));
      answering.closeWake();
      await answering.ask({ kind: "close-journal" });
      closing = true;
      collector.close();
      await answering.ask({ kind: "close-views" });
      sourceRuns.close();
    },
  };
}
