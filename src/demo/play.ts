// The demo's one view-and-print path (src/demo/dsl.ts is its process main): a
// config loaded as the daemon loads one, one session's view of it opened
// through a facts source, and a frame drawn per answer at its request's
// instant, by the daemon's own functions.
//
// [LAW:dataflow-not-control-flow] What the frames are drawn from is values the
// main hands in: the facts arm (the in-process arm over owners, or a
// recording's), the steps (requests at the offsets they arrive at, the draws
// of their answers, and a recording's documents where the daemon took them),
// whose home `~` names, the turn the view opens on and what the session's
// clicks left for each draw (a recording's, or a session that never clicked),
// what each draw was handed (a recording's, or a session no lane follows and
// nothing warned of), when each draw is drawn (a recorded instant, or the
// instant its request arrived at), and how a request arrives at its offset (a
// sleep on the machine's clock and its reading, or a held clock's advance and
// the recorded instant). The path itself never asks which.
//
// [LAW:single-enforcer] One faked hook event, or a recorded one, goes through
// the functions the daemon runs for a real one — loadChain, openView over the
// daemon's session source, the follow's settle, the daemon's draw of a view
// (src/daemon/draw-view.ts). There is no demo-only payload or draw: a field
// the daemon's payload gains is in the demo's, and an open viewer stands in
// for the bar as the daemon's does.

import { readFileSync } from "node:fs";
import { observable, runInAction, type IObservableValue } from "mobx";
import {
  parseRecording,
  type ClickState,
  type DrawState,
  type Recording,
  type ReplayLine,
  type SessionRequest,
  type TurnLine,
} from "../facts/recording.js";
import type { RendererLinks } from "../click/renderer-links.js";
import { DIAGNOSTICS_VIEWING } from "../config/door.js";
import { drawView, type Handed } from "../daemon/draw-view.js";
import type { RendererAddress } from "../daemon/home.js";
import { daemonGates } from "../daemon/update-keys.js";
import type { Gates } from "../daemon/foundations/gates.js";
import { locations } from "../daemon/paths.js";
import { repoGateAt } from "../daemon/repo-configs.js";
import { repoGateLines } from "../config/loader/repo-gate.js";
import {
  homeLayer,
  InstalledLayerMemo,
  refuseDrops,
} from "../config/dsl-loader.js";
import {
  loadChain,
  openView,
  UNOWNED_STORAGE,
  type DslRenderState,
} from "../daemon/cache/render.js";
import type { Facts, RecordingFacts } from "../daemon/facts-source.js";
import { sessionSource } from "../daemon/session-source.js";
import { SessionState, SINGLE_RUN } from "../daemon/session-state.js";
import { EMPTY_HISTORY_DEPTH } from "../daemon/settings-history.js";
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
  // The keyspaces its load and its views gate and judge by: one, as the
  // daemon holds one, so the drawn values and the ⚠ list agree.
  readonly gates: Gates;
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
  const sessionState = new SessionState(SINGLE_RUN);
  const gates = daemonGates();
  const locs = locations(world.host, world.home);
  const repos = repoGateAt(world.filesystem, stateDir, cwd);
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
      gates,
      stateDir,
      filesystem: world.filesystem,
      memo: new InstalledLayerMemo(),
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
  return { state, sessionState, gates, [Symbol.dispose]: dispose };
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
export type Depths = Pick<ClickState, "history" | "back">;

// Every field of the settings history's depth, whichever it gains.
function sameDepths(a: Depths, b: Depths): boolean {
  const fields = Object.keys(a.history) as Array<keyof Depths["history"]>;
  return (
    a.back === b.back && fields.every((k) => a.history[k] === b.history[k])
  );
}

// [LAW:single-enforcer] A recorded clicks' state made the replay's, in one
// action, so its turn and its `state` variables move together: the store's
// values and revision for the session, and the depths. A draw's idle instant
// is handed to the draw itself.
export function restoreDraw(
  sessionState: SessionState,
  depths: IObservableValue<Depths>,
  sessionId: string,
  state: ClickState,
): void {
  runInAction(() => {
    sessionState.restore(sessionId, state.values, state.revision);
    depths.set({ history: state.history, back: state.back });
  });
}

// When a draw is drawn: at a recorded instant, exactly as its line holds it (a
// lane's frame is drawn between whole milliseconds), or at the instant the
// request at an offset arrived at, which the live arm learns only as it
// arrives.
export type DrawnAt =
  | { readonly instant: Instant }
  | { readonly request: number };

// One step of a play, from the clock's reading as it begins: a request
// arrives at its offset; a declaration restates the request the next draw's
// view was declared with; a draw (an answer, or a lane's frame) is drawn at
// its instant, from the session's state it read and with what it was handed;
// a document becomes the arm's; a turn is taken over its line's inputs (the
// clicks' state, the request, the document it reaches) and held or not; a
// state is the session's clicks' state from there.
export type DemoStep =
  | {
      readonly kind: "request";
      readonly offsetMs: number;
      readonly request: SessionRequest;
    }
  | { readonly kind: "declared"; readonly request: SessionRequest }
  | {
      readonly kind: "draw";
      readonly at: DrawnAt;
      readonly state: DrawState;
      readonly handed: Handed;
    }
  | { readonly kind: "document"; readonly reach: () => void }
  | { readonly kind: "state"; readonly state: ClickState }
  | {
      readonly kind: "turn";
      readonly turn: DemoTurn;
      readonly reach: () => void;
    };

// A turn the play takes: the request and the clicks' state it is taken over,
// and whether it is held from then on.
export type DemoTurn = Pick<TurnLine, "request" | "state" | "held">;

// A recording as the demo plays it: the instant its held clock starts at, in
// whole milliseconds as the clock reads them, the turn the view opens on, and
// its lines as steps, in the file's order, at their offsets from it. The clock
// starts at the first request or draw, not the opening turn: the document a
// recording opens with is the one the bar was drawn from when it began, which
// can be hours old.
export interface RecordingPlay {
  readonly startMs: number;
  readonly opening: DemoTurn;
  readonly steps: readonly DemoStep[];
}

// The steps a parsed recording plays by, each of its documents reached on
// `arm` when the walk comes to its line, a turn's among them.
export function playOf(
  recording: Pick<Recording, "opening" | "lines">,
  arm: Pick<RecordingFacts, "reach">,
): RecordingPlay {
  const first = recording.lines.find(
    (line) => line.kind === "request" || line.kind === "draw",
  );
  // [LAW:no-silent-failure] The parser refuses a recording nothing was drawn
  // in, so one with no draw is this play's bug.
  if (first === undefined) {
    throw new Error("a recording with no draw reached the play");
  }
  const startMs = msOf(first.at);
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
              at: { instant: line.at },
              state: line.state,
              handed: {
                drawing: line.drawing,
                feeds: line.feeds,
                diagnostics: line.diagnostics,
              },
            }
          : line.kind === "state"
            ? { kind: line.kind, state: line.state }
            : line.kind === "turn"
              ? {
                  kind: line.kind,
                  turn: line,
                  reach: () => arm.reach(line.document),
                }
              : { kind: "document", reach: () => arm.reach(line) };
  return {
    startMs,
    opening: recording.opening,
    steps: recording.lines.map(step),
  };
}

export interface DemoPlay {
  readonly loaded: DemoState;
  readonly facts: Facts;
  // The session source's own reads: whose home `~` names, and the log.
  readonly home: string;
  readonly log: DaemonLogger;
  readonly clock: Timekeeper;
  // The turn the view opens on: over the arm's document as the play begins.
  readonly opening: DemoTurn;
  readonly steps: RecordingPlay["steps"];
  readonly arrive: Arrive;
  // The renderer the frames' links are minted for.
  readonly to: RendererAddress;
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

// [LAW:no-ambient-temporal-coupling] The steps are taken in their order, which
// is the order the daemon took them in: a request's clock is brought to its
// offset, the view is declared with it and what its arrival starts of the
// facts lands; a draw restores the session's state it read and draws the view
// as it stands then, at its instant; a turn is taken over its line's inputs
// and then held or not.
export async function playDemo({
  loaded: { state, sessionState, gates },
  facts,
  home,
  log,
  clock,
  opening,
  steps,
  arrive,
  to,
  frame,
}: DemoPlay): Promise<void> {
  const warn = (message: string): void => log("warn", message);
  const startMs = clock.now();
  // Each request's instant, by its offset: what the live arm's answer to it is
  // drawn at.
  const arrived = new Map<number, Instant>();
  const answered = (offsetMs: number): Instant => {
    const at = arrived.get(offsetMs);
    // [LAW:no-silent-failure] The live arm draws only an answer to a request
    // already taken; one that is not is this play's bug, never a frame at
    // another instant.
    if (at === undefined) {
      throw new Error(
        `a draw answers a request at +${offsetMs}ms, and none arrived then`,
      );
    }
    return at;
  };
  // [LAW:one-source-of-truth] The depths of the draw being drawn, set with the
  // store by each draw's restore. Compared by value, so a draw whose depths
  // held moves nothing the turn reads, as the daemon's depths do not.
  const depths = observable.box<Depths>(NEVER_CLICKED, {
    deep: false,
    equals: sameDepths,
  });
  // [LAW:one-source-of-truth] Whether the recorded session's turn was held
  // where the play stands. While it is, the replay's turn inputs cannot be
  // read, so the replay's turn keeps the last one it took, through the
  // daemon's own taking (src/daemon/session-source.ts), as the live one did.
  const held = observable.box(false);
  const turnInput =
    <A extends unknown[], T>(read: (...args: A) => T) =>
    (...args: A): T => {
      // [LAW:dataflow-not-control-flow] The recorded hold decides what the
      // read answers: a turn input that cannot be read, as it could not live.
      if (held.get())
        throw new Error("the recorded session's turn was held here");
      return read(...args);
    };
  // The session's view of the state, as the daemon opens one per session,
  // at the directory of the request it is declared with.
  const open = (request: SessionRequest) =>
    openView(state, request.cwd, request, {
      facts,
      source: sessionSource({
        providers: { home, log },
        sessionState,
        stateGates: gates.state,
        history: turnInput(() => depths.get().history),
        navigation: turnInput(() => depths.get().back),
      }),
      // The demo draws one frame per request: no feed to wake.
      changed: () => {},
      log,
    });
  // The opening turn taken over its own clicks' state, request and document
  // (the arm's as the play begins), then held or not.
  restoreDraw(sessionState, depths, opening.request.sessionId, opening.state);
  let view = open(opening.request);
  runInAction(() => held.set(opening.held));
  // [LAW:one-source-of-truth] The view is at its latest request's directory,
  // as the daemon's cache moves a session's view to the entry its request
  // names: a request from another directory opens the view there, so its
  // sources' runs are the ones the session's documents hold from then on.
  const declare = (request: SessionRequest): void => {
    if (request.cwd === view.facts().cwd) {
      view.requested(request);
      return;
    }
    view.dispose();
    view = open(request);
  };
  try {
    // The session's effect memory, held across the frames as the daemon holds
    // it across a session's requests, so a `globals.effect` moves frame to
    // frame.
    const effects = new SessionEffects<RenderedLine>(opening.request.sessionId);
    for (const step of steps) {
      if (step.kind === "document") {
        step.reach();
      } else if (step.kind === "turn") {
        // Released, so the turn is taken over the line's inputs: its clicks'
        // state and its document in one action, then its request, which
        // declares the view in a call of its own (openView).
        runInAction(() => {
          held.set(false);
          restoreDraw(sessionState, depths, view.sessionId, step.turn.state);
          step.reach();
        });
        declare(step.turn.request);
        runInAction(() => held.set(step.turn.held));
      } else if (step.kind === "request") {
        const at = await arrive(startMs + step.offsetMs);
        arrived.set(step.offsetMs, at);
        declare(step.request);
        await view.settle(at).landed;
      } else if (step.kind === "declared") {
        declare(step.request);
      } else if (step.kind === "state") {
        // [LAW:one-source-of-truth] The clicks' state moves where the live
        // session's moved, before the document stamped under it is reached.
        restoreDraw(sessionState, depths, view.sessionId, step.state);
      } else {
        const at =
          "instant" in step.at ? step.at.instant : answered(step.at.request);
        restoreDraw(sessionState, depths, view.sessionId, step.state);
        frame(
          drawView(
            view,
            step.handed,
            at,
            effects,
            step.state.idleSince,
            sessionState.get(view.sessionId, DIAGNOSTICS_VIEWING),
            to,
            ({ message }) => warn(message),
          ).body,
        );
      }
    }
  } finally {
    view.dispose();
  }
}
