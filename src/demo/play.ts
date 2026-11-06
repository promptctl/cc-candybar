// The demo's one view-and-print path (src/demo/dsl.ts is its process main): a
// config loaded as the daemon loads one, one session's view of it opened
// through a facts source, and a frame drawn per answer at its request's
// instant, by the daemon's own functions.
//
// [LAW:dataflow-not-control-flow] What the frames are drawn from is values the
// main hands in: the facts arm (the in-process arm over owners, or a
// recording's), the steps (requests at the offsets they arrive at, the draws
// of their answers, and a recording's documents where the daemon took them),
// whose home `~` names, what the session's clicks left for each draw (a
// recording's, or a session that never clicked), and how a request arrives at
// its offset (a sleep on the machine's clock and its reading, or a held
// clock's advance and the recorded instant). The path itself never asks which.
//
// [LAW:single-enforcer] One faked hook event, or a recorded one, goes through
// the functions the daemon runs for a real one — loadChain, openView over the
// daemon's session source, the follow's settle, drawDsl. There is no
// demo-only payload: a field the daemon's payload gains is in the demo's.

import { readFileSync } from "node:fs";
import { observable, runInAction, type IObservableValue } from "mobx";
import {
  parseRecording,
  type DrawState,
  type Recording,
  type ReplayLine,
} from "../facts/recording.js";
import type { RendererLinks } from "../click/renderer-links.js";
import { daemonGates } from "../daemon/update-keys.js";
import { locations } from "../daemon/paths.js";
import { repoGateAt } from "../daemon/repo-configs.js";
import { repoGateLines } from "../config/loader/repo-gate.js";
import { UNFOLLOWED_FEEDS } from "../config/lanes.js";
import { homeLayer, refuseDrops } from "../config/dsl-loader.js";
import {
  loadChain,
  openView,
  UNOWNED_STORAGE,
  type DslRenderState,
  type SessionView,
} from "../daemon/cache/render.js";
import type { Facts, RecordingFacts } from "../daemon/facts-source.js";
import {
  renderOptionsOf,
  todayOf,
  type ViewFacts,
} from "../daemon/render-payload.js";
import { sessionSource, type SessionSource } from "../daemon/session-source.js";
import { SessionState } from "../daemon/session-state.js";
import { EMPTY_HISTORY_DEPTH } from "../daemon/settings-history.js";
import { drawDsl } from "../dsl/render.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import type { World } from "../host.js";
import { SessionEffects } from "../render/effect.js";
import type { Frame } from "../render/frame.js";
import type { HeldClock } from "../held-clock.js";
import type { Timekeeper } from "../time.js";
import { instantOf, msOf, type Instant } from "../utils/instant.js";
import type { DaemonLogger } from "../utils/logger.js";

// A config loaded for the demo, with what owns its picks.
export interface DemoState extends Disposable {
  readonly state: DslRenderState;
  readonly sessionState: SessionState;
}

// What a load reads: the machine, whose clock is the one the frames are drawn
// by (the machine's, or a replay's held clock); the state directory and the
// links the process main derived from its home; the config, and the
// directory it loads in.
export interface DemoLoad {
  readonly world: World;
  readonly stateDir: string;
  readonly links: RendererLinks;
  readonly configPath: string;
  readonly cwd: string;
  readonly warn: (message: string) => void;
}

// The demo renders the file it was given or nothing. The advisories a file
// earns are reported whether or not it goes on to load, as the daemon's strip
// and `cc-candybar check` report them. The config is the one file named here:
// the daemon's search for a config and its diagnostics viewer are not part of
// the demo.
export function loadDemo({
  world,
  stateDir,
  links,
  configPath,
  cwd,
  warn,
}: DemoLoad): DemoState {
  // The session's store, which each draw's state restores before it draws.
  const sessionState = new SessionState();
  const locs = locations(world.host, world.home);
  const repos = repoGateAt(stateDir, cwd);
  // [LAW:single-enforcer] The daemon's own load and settle: the advisories
  // come out of the one place every load composes them.
  const loaded = loadChain(
    {
      repos,
      advisories: repoGateLines(repos),
      started: world.clock.monotonic(),
    },
    cwd,
    // The file it was given is named explicitly: no repository supplies it.
    {
      layers: [homeLayer(configPath)],
      home: configPath,
      repo: repos.plugins,
      locs,
    },
    {
      clock: world.clock,
      locations: locs,
      sessionState,
      storage: UNOWNED_STORAGE,
      links,
      gates: daemonGates(),
      stateDir,
    },
  );
  if (loaded.warning !== null) warn(loaded.warning);
  if (loaded.state === null) throw loaded.cause;
  const { state } = loaded;
  const dispose = (): void => {
    state.registry.dispose();
  };
  // [LAW:no-silent-failure] The daemon draws past a placement of an
  // undeclared segment; the demo, like `check`, refuses it with the loader's
  // message.
  try {
    refuseDrops(state.dropped);
  } catch (e) {
    dispose();
    throw e;
  }
  return { state, sessionState, [Symbol.dispose]: dispose };
}

// A recording file the demo could not read as one: refused naming the file,
// the message whole, as a config the loader refuses is.
export class RecordingUnreadable extends Error {
  constructor(path: string, cause: unknown) {
    super(`${path} ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "RecordingUnreadable";
  }
}

// [LAW:effects-at-boundaries] The file read, and the one parser over its
// text: another facts version, a cut line, a document of another session, no
// answered request — each is this file's refusal, never a shorter replay.
export function readRecording(path: string): Recording {
  try {
    return parseRecording(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RecordingUnreadable(path, e);
  }
}

// A session that has never clicked: every pick is absent, so each setting
// resolves to the config's own value, every picker is closed, there is nothing
// to undo or go back to, and no menu has been idle.
export const NEVER_CLICKED: DrawState = {
  values: {},
  revision: 0,
  history: EMPTY_HISTORY_DEPTH,
  back: 0,
  idleSince: undefined,
};

// The histories' depths a replay's turn reads, beside its store.
export type Depths = Pick<DrawState, "history" | "back">;

// Every field of the settings history's depth, whichever it gains.
function sameDepths(a: Depths, b: Depths): boolean {
  const fields = Object.keys(a.history) as Array<keyof Depths["history"]>;
  return (
    a.back === b.back && fields.every((k) => a.history[k] === b.history[k])
  );
}

// [LAW:single-enforcer] A draw's recorded state made the replay's, in one
// action, so its turn and its `state` variables move together before it
// draws: the store's values and revision for the session, and the depths.
// The idle instant is handed to the draw itself.
export function restoreDraw(
  sessionState: SessionState,
  depths: IObservableValue<Depths>,
  sessionId: string,
  state: DrawState,
): void {
  runInAction(() => {
    sessionState.restore(sessionId, state.values, state.revision);
    depths.set({ history: state.history, back: state.back });
  });
}

// One step of a play, from the clock's reading as it begins: a request
// arrives at its offset; a declaration restates the request the next draw's
// view was declared with; an answer is drawn at the offset of the request it
// answers, from the session's state it read; a document becomes the arm's.
export type DemoStep =
  | {
      readonly kind: "request";
      readonly offsetMs: number;
      readonly request: ViewFacts;
    }
  | { readonly kind: "declared"; readonly request: ViewFacts }
  | {
      readonly kind: "draw";
      readonly requestOffsetMs: number;
      readonly state: DrawState;
    }
  | { readonly kind: "document"; readonly reach: () => void };

// A recording as the demo plays it: the instant its held clock starts at, in
// whole milliseconds as the clock reads them, and its lines as steps, in the
// file's order, at their offsets from it. The clock starts at the first
// request, not the opening document: the document a recording opens with is
// the view's latest when it began, which can be hours old.
export interface RecordingPlay {
  readonly startMs: number;
  readonly steps: readonly [
    DemoStep & { readonly kind: "request" },
    ...DemoStep[],
  ];
}

// The steps a parsed recording plays by, from its first request, each of its
// documents reached on `arm` when the walk comes to its line.
export function playOf(
  recording: Pick<Recording, "lines">,
  arm: Pick<RecordingFacts, "reach">,
): RecordingPlay {
  const [opening, ...later] = recording.lines;
  const startMs = msOf(opening.at);
  const step = (line: ReplayLine): DemoStep =>
    line.kind === "request"
      ? {
          kind: line.kind,
          offsetMs: msOf(line.at) - startMs,
          request: line.request,
        }
      : line.kind === "declared"
        ? { kind: line.kind, request: line.request }
        : line.kind === "draw"
          ? {
              kind: line.kind,
              requestOffsetMs: msOf(line.request) - startMs,
              state: line.state,
            }
          : { kind: "document", reach: () => arm.reach(line) };
  return {
    startMs,
    steps: [
      { kind: "request", offsetMs: 0, request: opening.request },
      ...later.map(step),
    ],
  };
}

export interface DemoPlay {
  readonly loaded: DemoState;
  // The session's directory, which its view opens at and its sources run in,
  // as the daemon opens a view at its request's: a replay's is the
  // recording's, wherever the demo runs.
  readonly cwd: string;
  readonly facts: Facts;
  // The session source's own reads: whose home `~` names, and the log.
  readonly home: string;
  readonly log: DaemonLogger;
  readonly clock: Timekeeper;
  // The steps, the first a request opening the view.
  readonly steps: RecordingPlay["steps"];
  readonly arrive: Arrive;
  readonly frame: (frame: Frame) => void;
}

// How a request arrives at `atMs`, as the clock reads it: the clock brought
// there, and the instant the request is declared, settled and answered at.
export type Arrive = (atMs: number) => Promise<Instant>;

// [LAW:no-ambient-temporal-coupling] On a held clock the instant is the
// recorded one, never the clock's: a request's instant is read before its turn
// queues, so it can predate the step ahead of it, and the clock never runs
// back.
export const heldArrival =
  (clock: HeldClock): Arrive =>
  async (atMs) => {
    clock.advance(Math.max(0, atMs - clock.now()));
    return instantOf(new Date(atMs));
  };

// One frame of a session's view at `at`, as the daemon draws a request's: the
// draw's own projections, the options its view's turn resolved, and when the
// session's menus' idle period began.
export function drawDemoFrame(
  view: SessionView<SessionSource>,
  at: Instant,
  effects: SessionEffects<RenderedLine>,
  idleSince: Instant | undefined,
  warn: (message: string) => void,
): Frame {
  const effective = view.source.effective();
  return drawDsl(
    view.state.config,
    view.state.compiled,
    view.store,
    view.registry,
    {
      drawing: { by: "request" },
      feeds: UNFOLLOWED_FEEDS,
      today: todayOf(view.source.facts().builtins.today, at),
    },
    at,
    // [LAW:one-source-of-truth] The width is the turn's, as the daemon's
    // request draws it: `renderWidth` of its hints, carried as `term.cols`.
    renderOptionsOf(effective, view.source.payload().term.cols),
    { onRenderWarning: ({ message }) => warn(message) },
    { ...effective, effects, idleSince },
  ).frame;
}

// [LAW:no-ambient-temporal-coupling] The steps are taken in their order, which
// is the order the daemon took them in: a request's clock is brought to its
// offset, the view is declared with it and what its arrival starts of the
// facts lands; a draw restores the session's state it read and draws the view
// as it stands then, at the instant its request arrived at.
export async function playDemo({
  loaded: { state, sessionState },
  cwd,
  facts,
  home,
  log,
  clock,
  steps,
  arrive,
  frame,
}: DemoPlay): Promise<void> {
  const warn = (message: string): void => log("warn", message);
  const [opening] = steps;
  const startMs = clock.now();
  // Each request's instant, by its offset: what its answer is drawn at.
  const arrived = new Map<number, Instant>();
  // [LAW:one-source-of-truth] The depths of the draw being drawn, set with the
  // store by each draw's restore. Compared by value, so a draw whose depths
  // held moves nothing the turn reads, as the daemon's depths do not.
  const depths = observable.box<Depths>(NEVER_CLICKED, {
    deep: false,
    equals: sameDepths,
  });
  // The session's view of the state, as the daemon opens one per session,
  // declared with the request the first frame draws by.
  const view = openView(state, cwd, opening.request, {
    facts,
    source: sessionSource({
      providers: { home, log },
      sessionState,
      history: () => depths.get().history,
      navigation: () => depths.get().back,
    }),
    // The demo draws one frame per request: no feed to wake.
    changed: () => {},
    log,
  });
  try {
    // The session's effect memory, held across the frames as the daemon holds
    // it across a session's requests, so a `globals.effect` moves frame to
    // frame.
    const effects = new SessionEffects<RenderedLine>(opening.request.sessionId);
    for (const step of steps) {
      if (step.kind === "document") {
        step.reach();
      } else if (step.kind === "request") {
        const at = await arrive(startMs + step.offsetMs);
        arrived.set(step.offsetMs, at);
        view.requested(step.request);
        await view.settle(at).landed;
      } else if (step.kind === "declared") {
        view.requested(step.request);
      } else {
        const at = arrived.get(step.requestOffsetMs);
        // [LAW:no-silent-failure] Both arms draw only an answer to a request
        // already taken (the parser refuses a file that does not); one that
        // is not is this play's bug, never a frame at another instant.
        if (at === undefined) {
          throw new Error(
            `a draw answers a request at +${step.requestOffsetMs}ms, and none arrived then`,
          );
        }
        restoreDraw(sessionState, depths, view.sessionId, step.state);
        frame(drawDemoFrame(view, at, effects, step.state.idleSince, warn));
      }
    }
  } finally {
    view.dispose();
  }
}
