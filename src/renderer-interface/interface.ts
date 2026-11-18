// The renderer interface (docs/design/host-and-renderer.md §7): the host hands
// a renderer inputs, and the renderer answers each with the effects it asks
// the host to perform, what it needs read, and the record of its turn.
//
// [LAW:one-way-deps] The host depends on this module and the renderer
// implements it; it imports only types, the vocabulary both sides speak: the
// session context, the world state, the frame, the instant.
// [LAW:types-are-the-program] The unions hold only the arms something produces
// and something consumes; each later step adds its own.

import type {
  ParsedSessionId,
  SessionId,
} from "../daemon/foundations/session-id";
import type { Failure } from "../daemon/foundations/verb-error";
import type { ClickArrival } from "../doctor/sightings";
import type { DoctorAsk } from "../doctor/gather";
import type { Run } from "../facts/source-identity";
import type { SourceId, WorldState } from "../facts/world-state";
import type { WireFrame } from "../render/frame";
import type { Readings, Tick } from "../utils/instant";
import type { Field } from "../utils/logfmt";
import type { CheckedRenderRequest, SessionContext } from "./request-context";
import type {
  MenuIdleStats,
  RenderCacheStats,
  StatsSnapshot,
} from "../daemon/foundations/stats-snapshot";
import type {
  DebugSnapshot,
  DebugWhat,
} from "../daemon/foundations/debug-types";
import type { HeldEvent } from "../utils/event-hold";
import type { LogLevel } from "../utils/logger";
import type { Crosses } from "./crosses";
import type { Lane, LaneSwitches } from "../config/lanes";
import type { Change } from "../config/config-changes";
import type { TmuxHint } from "../tmux-hint";
import type { SlashLine } from "../claude-input/slash-line";
import type { SessionPane } from "../claude-input/typing";
import type { RepoAnswer } from "../config/loader/repo-gate";
import type { Answered } from "../daemon/foundations/sighting-roles";
import type { RenderOrigin } from "../config-hint";
import type { LayerRole } from "../config/layer-role";
import type { ConfigSnapshot } from "../config/config-snapshot";
import type { StoreWrite } from "./stored-state";

// Which request a statusline frame answers: the host's count of the requests
// of every kind it accepted, in arrival order, so renders' ids have gaps.
declare const REQUEST_ID: unique symbol;
export type RequestId = number & { readonly [REQUEST_ID]: true };

// An effect's name, minted by the renderer that returned it, which its
// `effect-done` carries back.
declare const EFFECT_ID: unique symbol;
export type EffectId = number & { readonly [EFFECT_ID]: true };

// [LAW:one-type-per-behavior] One interface over every transport: in process,
// or lines to the renderer's own process. Every input is an event, answered
// by its turn's output.
export interface Answering<O> {
  answer(input: RendererInput): Promise<O>;
}

// What a renderer implements: every input answered by its output.
export type Renderer = Answering<RendererOutput>;

// An output as its transport hands it to the host, with how long the turn
// took, measured around `answer` on the clock of the process it ran in: the
// renderer reads none, and the host tells the hop's cost from the turn's.
export type Timed<O> = O & { readonly turnMs: number };

// What the host holds of a renderer: its answers, each timed by its transport.
export type TimedRenderer = Answering<Timed<RendererOutput>>;

// [LAW:single-enforcer] The one measure of a turn, around the renderer's
// `answer`, on the monotonic clock of the process it runs in.
export function timed(
  renderer: Renderer,
  monotonic: () => number,
): TimedRenderer {
  return {
    answer: async (input) => {
      const from = monotonic();
      const output = await renderer.answer(input);
      return { ...output, turnMs: Math.round(monotonic() - from) };
    },
  };
}

// [LAW:effects-at-boundaries] Every input carries the host's two readings,
// made as its slot in the mailbox comes (`Readings`): the renderer reads no
// clock.
export interface RendererInput extends Readings {
  readonly kind: "event";
  readonly event: Event;
}

// A session's context as its newest request names it, and the world state read
// at that request's keys.
export interface SessionConfig {
  readonly context: CheckedRenderRequest;
  readonly worldState: WorldState;
}

// [LAW:types-are-the-program] Every input and output of a turn is plain data:
// the build fails on one a process could not carry.
export const INPUTS_CROSS: Crosses<RendererInput> = true;
export const OUTPUTS_CROSS: Crosses<RendererOutput> = true;

export type Event =
  | {
      // A renderer's start: every live session's context, as `context` hands
      // one in, in one turn, so the start's output names everything the
      // renderer serves and the host releases nothing it still holds for one.
      readonly kind: "start";
      // Who watches each session's frames as the start is made, taken
      // before the sessions are opened: a watched session's feed holds its
      // view before the view opens.
      readonly viewers: Viewers;
      readonly sessions: readonly SessionConfig[];
    }
  | {
      // A request's opening turn, delivered ahead of it: the session's
      // context as its newest request names it. Its turn opens the session's
      // view, so the output names what the view reads before the request
      // waits on it. It carries no config: that is its origin's, which the
      // renderer subscribes (`Subscriptions.configs`).
      readonly kind: "context";
      readonly context: CheckedRenderRequest;
      // [LAW:one-source-of-truth] The world state read at this context's own
      // keys: a session's context and its world state reach the renderer as
      // one value, so a renderer never holds a context beside a document read
      // at another request's keys.
      readonly worldState: WorldState;
    }
  | {
      // [LAW:one-source-of-truth] What discovery found at `origin`, which the
      // renderer's subscriptions name: a fact about the origin, shared by
      // every session there. Handed in when the origin is first named, in the
      // slot of the turn that named it, and again whenever it moves.
      readonly kind: "config";
      readonly origin: RenderOrigin;
      readonly config: ConfigSnapshot;
    }
  | {
      // A request of a session whose `context` came before it, delivered once
      // its wait on the session's world state has ended in the host: the
      // turn draws at once, from the world state the renderer holds.
      readonly kind: "request";
      readonly id: RequestId;
      readonly context: CheckedRenderRequest;
    }
  | {
      // A session's world state moved since the one the renderer holds: read
      // at the keys of the newest `context` the host delivered for it.
      readonly kind: "world-state";
      readonly worldState: WorldState;
    }
  | {
      // The host ended the session: the renderer lets go of what it holds
      // of it, and its document goes however the turn ends, answered or
      // threw, so the host's next record for the session starts again at
      // seq 1.
      readonly kind: "retire";
      readonly session: SessionId;
    }
  | {
      readonly kind: "effect-done";
      // The session of the effect it reports on: none for an act no session
      // asked for.
      readonly session: SessionId | null;
      readonly of: EffectId;
      readonly outcome: EffectOutcome;
    }
  | {
      // A click on a link the bar drew: the renderer decides what it means
      // and acts on it in this turn, so the output names what the act moved.
      readonly kind: "click";
      readonly verb: string;
      readonly value: string;
      // The click's session as it crossed the host's session-id checkpoint:
      // null when the click names none.
      readonly session: ParsedSessionId | null;
      readonly arrival: ClickArrival;
      // [LAW:one-source-of-truth] The click's session as the host's book
      // holds it: what it renders from, and, once heard since the daemon
      // started, the request whose hints are the pane its lanes follow. Null
      // when the click names no session, or the book holds none of it.
      readonly context: SessionContext | null;
    }
  | {
      // Who watches each session's frames now, whole: a feed opens for a
      // session that gained its first viewer and closes for one that lost
      // its last.
      readonly kind: "viewers";
      readonly viewers: Viewers;
    }
  | {
      // The tick the renderer last declared (`Subscriptions.wake`) has
      // come: what is due by the turn's tick runs in it.
      readonly kind: "due";
    }
  | {
      // A reading of the renderer's own state, which its turn answers with
      // a `report`, as a request's answers with a `present`.
      readonly kind: "inspect";
      readonly ask: Inspect;
    }
  // The daemon's teardown, in its two renderer steps: from `closing` no
  // config write begins, and `close` ends the views and their feeds.
  | { readonly kind: "closing" }
  | { readonly kind: "close" };

// What an `inspect` reads: the stats reply's counts of the renderer's state,
// or the debug reply's projection of the most recently drawn view.
export type Inspect =
  | { readonly kind: "stats" }
  | { readonly kind: "debug"; readonly what: DebugWhat };

// What the stats reply reads of the renderer's state.
export interface RendererStats {
  readonly renderCache: RenderCacheStats;
  readonly effectCache: StatsSnapshot["effectCache"];
  readonly sessionState: StatsSnapshot["sessionState"];
  readonly menuIdle: MenuIdleStats;
  // Frames the renderer's feeds drew.
  readonly framesDrawn: number;
}

// What an `inspect` read, of its ask's own kind.
export type Reading =
  | { readonly kind: "stats"; readonly stats: RendererStats }
  | { readonly kind: "debug"; readonly snapshot: DebugSnapshot };

// [LAW:one-source-of-truth] Who watches one session's frames, as the host
// derives it from its own sources: each lane's subscribers and whether any of
// them draws the bar now (a tmux status line showing the session's pane), and
// whether the session's pane is on a screen.
export interface SessionViewers {
  readonly lanes: Readonly<Partial<Record<Lane, LaneViewers>>>;
  readonly shown: boolean;
  // Where the latest of its subscribers came among every subscriber the host
  // has taken: one that joins is owed a frame even when the counts read as
  // they did, as when one leaves and another takes its place.
  readonly joined: number;
}

export interface LaneViewers {
  readonly subscribers: number;
  readonly drawing: boolean;
}

// Every session someone watches, whole: a session absent has no viewer.
export type Viewers = Readonly<Record<SessionId, SessionViewers>>;

// [LAW:one-source-of-truth] The lanes that follow a session and draw it now:
// the one derivation from its viewers, which the renderer hands the bar to
// and the host's lane edge waits on.
export function followingOf(viewers: SessionViewers | undefined): Set<Lane> {
  const following = new Set<Lane>();
  for (const [lane, seen] of Object.entries(viewers?.lanes ?? {}))
    if (seen.drawing) following.add(lane as Lane);
  return following;
}

export type EffectOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly reason: string }
  // Refused before it acted: a change to a setting that moved since the
  // renderer read it, so nothing made over that reading can land; or an act
  // the world it acts in would not take (a pane not at its prompt, an update
  // already running).
  | { readonly kind: "refused"; readonly reason: string }
  // The daemon's close began before it acted, or cut it off: no failure of
  // its own, so no bar holds it.
  | { readonly kind: "closing"; readonly reason: string }
  // An act not performed because its turn's changes did not land: their own
  // outcome says why, so no bar holds it a second time.
  | { readonly kind: "skipped"; readonly reason: string };

// [LAW:one-type-per-behavior] Every frame reaches its surface by `present`;
// the statusline's arm carries the request it answers.
export interface Present {
  readonly kind: "present";
  readonly id: EffectId;
  readonly session: SessionId;
  readonly surface: "statusline";
  readonly request: RequestId;
  // Read through `parseFrame`: its Infinity crosses as null.
  readonly frame: WireFrame;
  // The daemon-wide held events the frame shows: the host marks each
  // answered once it has delivered the frame to its client
  // (src/utils/event-hold.ts).
  readonly shows: readonly HeldEvent[];
}

// [LAW:one-type-per-behavior] An inspect's answer, as a present is a
// request's: what it read, which the host hands the client that asked. It is
// performed by being taken, so no `effect-done` comes back.
export interface Report {
  readonly kind: "report";
  readonly reading: Reading;
}

// [LAW:one-type-per-behavior] Every config write is a `change`: the changes
// that take one file from what the renderer read to what it wrote, which the
// host applies to the file as it stands. A turn's changes land together or
// not at all, and each is settled with that one outcome.
// [LAW:single-enforcer] A config layer is named by its origin and its role in
// that origin's chain, never by a path: which file that is is discovery's to
// say, so a renderer cannot name a file the origin's chain does not hold. A
// `claude-settings` file is one the session's doctor reading handed in
// (`writableSettingsFiles`, src/doctor/gather.ts): the host refuses any other.
export interface ConfigChange {
  readonly kind: "change";
  readonly id: EffectId;
  readonly session: SessionId;
  readonly target: ChangeTarget;
  readonly changes: readonly Change[];
}

export type ChangeTarget =
  | {
      readonly kind: "layer";
      readonly origin: RenderOrigin;
      readonly role: LayerRole;
    }
  | { readonly kind: "claude-settings"; readonly file: string };

// A source a run makes stale: its full name, for the run's line, and the
// storage folder its file is in.
export interface RunRefresh {
  readonly name: string;
  readonly folder: string;
}

// A session as a lane's setup needs it, beyond its pane: its config's
// directory and its Claude Code directory, which the `claude` CLI runs under;
// its conversation, as Claude Code names it in the statusline JSON, which a
// restart resumes from and which a session has none of until its first
// message; and whether Claude Code has answered in it, by the one mark it
// leaves (`answeredOf`).
export interface LaneSession {
  readonly projectDir: string;
  // Null for the default directory: the hint names one only when set.
  readonly claudeConfigDir: string | null;
  readonly transcript: string;
  readonly answered: Answered;
}

// [LAW:types-are-the-program] What a click or a lane switch asks done in the
// world, each named by its operation and carrying exactly what that operation
// needs: no free-form command, so the safety of a slash line or a run is the
// type's. An act's session is the bar its failure shows on; a copy or an open
// a click names no session for has none.
export type Act = { readonly id: EffectId } & (
  | {
      readonly kind: "copy";
      readonly session: SessionId | null;
      readonly text: string;
    }
  | {
      // A file opened in the user's editor: which program opens it is the
      // host's.
      readonly kind: "open";
      readonly session: SessionId | null;
      readonly target: string;
    }
  | {
      // [LAW:single-enforcer] Checked and typed in one step: the pane is read
      // and refused unless it shows the bare input box, then the line goes in.
      readonly kind: "type-slash";
      readonly session: SessionId;
      readonly pane: TmuxHint;
      readonly line: SlashLine;
    }
  | {
      // A program the bar drew, run in its session's environment; each source
      // it refreshes reads pending from its start until it has exited and the
      // source is read again.
      readonly kind: "run";
      readonly session: SessionId;
      readonly action: string;
      readonly program: string;
      readonly args: readonly string[];
      // Laid over the session's environment, which the host holds.
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
      readonly refreshes: readonly RunRefresh[];
    }
  | {
      // The answer to a repository's question, which lands with the turn's
      // changes: the trust book is the host's. `dir` is the one its signed
      // link asked about, which must still be `origin`'s repository.
      readonly kind: "approve-repo";
      readonly session: SessionId;
      readonly origin: RenderOrigin;
      readonly dir: string;
      readonly answer: RepoAnswer;
    }
  | {
      // The update notice's act: what it applies is the update watch's to
      // decide, from its own provenance.
      readonly kind: "apply-update";
      readonly session: SessionId;
    }
  | {
      // Claude Code in the pane ended and started again under the attach
      // launcher, on the same session.
      readonly kind: "restart-claude";
      readonly session: SessionId;
      readonly pane: TmuxHint;
      readonly at: LaneSession;
    }
  | {
      // A pushed surface turned on or off: the bar pane split under the
      // session's pane, or closed.
      readonly kind: "surface";
      readonly session: SessionId;
      readonly surface: "pane";
      readonly on: boolean;
      readonly pane: TmuxHint;
    }
  | {
      // The band mod installed and loaded into the session's Claude Code.
      // Off, it draws nothing, so turning it off asks nothing. Only its
      // `/reload-plugins` is typed into a pane, so it carries the session's
      // pane or why it has none: outside tmux, the mod still installs, and
      // the session is told to type that line itself.
      readonly kind: "surface";
      readonly session: SessionId;
      readonly surface: "band";
      readonly on: true;
      readonly pane: SessionPane;
      readonly at: LaneSession;
    }
);

// An act as its turn asks it, before the renderer names it.
export type ActRequest = Unnamed<Act>;
type Unnamed<A> = A extends unknown ? Omit<A, "id"> : never;

export type Effect = Present | ConfigChange | Act | Report;

// An effect the host settles with an `effect-done`.
export type Settled = Exclude<Effect, Report>;

// [LAW:nothing-unseen] What a turn learned, in the order it learned it, which
// the host writes beside the input's event.
export type TurnRecord = readonly Field[];

// [LAW:effects-at-boundaries] A line for the host's one log, which the turn
// returns: the renderer writes no log.
export interface LoggedLine {
  readonly level: LogLevel;
  readonly line: string;
}

// [LAW:types-are-the-program] A source the renderer's state needs read for
// one session: a plugin source, at its storage folder, named by the variable
// that reads it; a `shell` or `file` run, named by its digest; or the
// doctor's run, by what it asks of the machine.
export type Subscription =
  | {
      readonly kind: "plugin";
      readonly source: SourceId;
      readonly folder: string;
    }
  | { readonly kind: "run"; readonly run: Run }
  // A variable an `env` source reads, from the session's environment, which
  // the host holds and hands in as that one variable's value.
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "doctor"; readonly ask: DoctorAsk };

// [LAW:one-source-of-truth] Whole, replacing the last: what every session the
// renderer holds needs read, which lanes its settings switch on, and when the
// renderer next wants a turn. The host diffs it; nothing is declared by
// message, so nothing has to remember what it asked. A session absent from it
// needs nothing read.
// [LAW:types-are-the-program] Keyed by session, so no session is listed twice,
// and a record, so it crosses a process as it is: a session absent is a key
// absent, never one holding `undefined`, which JSON does not carry.
// The storage folders a renderer's states name, and how many config loads it
// has run. A load is when a folder is kept again, as it was when it was
// first named: a watch refused or lost is tried again then. So the host keeps
// every folder again when either moves, and otherwise, as on most turns, does
// nothing.
export interface StorageNamed {
  // Each folder once, sorted.
  readonly folders: readonly string[];
  readonly loads: number;
}

export interface Subscriptions {
  readonly sources: Readonly<Record<SessionId, readonly Subscription[]>>;
  // The lanes each session with an open view switches on, as it draws them:
  // the host gates every subscriber by its lane, and holds the tmux status
  // line row of each session whose switch is on, in the pane its newest
  // request reports. A session with no view has no switch to read.
  readonly lanes: Readonly<Record<SessionId, LaneSwitches>>;
  // The origins whose config the renderer holds: each live session's, and
  // each a parked event waits on. The host discovers an origin as it is
  // first named, follows its files while it is named, and lets it go when it
  // is not.
  readonly configs: readonly RenderOrigin[];
  // [LAW:no-ambient-temporal-coupling] The plugin storage folders the latest
  // load of each render state names, from its first load to its reclaim: the
  // host's storage owner keeps each one, so a folder's watch lives as long as
  // a build names it, never as long as a view.
  readonly storage: StorageNamed;
  // [LAW:no-ambient-temporal-coupling] The tick the renderer next wants a
  // turn at, derived from its own state as each turn ends: the host keeps one
  // timer to it and hands it in as a `due`. Null while nothing is due.
  readonly wake: Tick | null;
}

// A frame's two answers, serialized once for every subscriber: `resp`, which
// a lane drawing the bar elsewhere is sent, and `statusline`, what Claude
// Code's statusline shows (the bar, or the handoff line in its place while a
// lane draws it elsewhere, src/renderer/lane-handoff.ts).
export interface Answers {
  readonly resp: string;
  readonly statusline: string;
}

// A frame a feed drew, for the session's subscribers: the bar, which a lane
// drawing it in tmux encodes, and its answers.
// [LAW:decomposition] Every frame a feed draws is pushed: whether one changed
// is the host's to judge, per subscriber, against what that one was sent.
export interface PushedFrame {
  readonly session: SessionId;
  // Read through `parseFrame`: its Infinity crosses as null.
  readonly bar: WireFrame;
  readonly answers: Answers;
}

// How a turn ended, a turn that threw included: its failure as data, a class
// crossing no process. Either way it carries the record it reached and the
// effects its acts made, so a click that wrote and then failed still lands
// what it wrote.
export type TurnOutcome = {
  readonly record: TurnRecord;
  // What the turn logged, a turn that threw included.
  readonly logged: readonly LoggedLine[];
  readonly effects: readonly Effect[];
} & (
  | { readonly kind: "answered" }
  | { readonly kind: "threw"; readonly failure: Failure }
);

// [LAW:no-silent-failure] Every turn answers, so `answer` never rejects. Its
// output names the open views' subscriptions as they stand after it, however
// it ended: an act can land before its turn throws (a click that committed
// and followed its view), and its view is read all the same. Its frames are
// those its feeds drew in it.
// [LAW:one-source-of-truth] Its stored writes are what the turn moved of the
// renderer's stores, which the host's copy takes before any later input: a
// write answers nothing, so it is no effect, and no `effect-done` comes back.
export type RendererOutput = TurnOutcome & {
  readonly subscriptions: Subscriptions;
  readonly frames: readonly PushedFrame[];
  readonly stored: readonly StoreWrite[];
};
