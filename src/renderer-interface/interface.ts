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
import type { WireFeedFrame } from "./adapter";
import type { Instant } from "../utils/instant";
import type { Field } from "../utils/logfmt";
import type { CheckedRenderRequest } from "./request-context";
import type { AdapterPush, AdapterReply } from "./adapter";
import type { Crosses } from "./crosses";
import type { LaneSwitches, Viewers } from "../config/lanes";
import type { Change } from "../config/config-changes";
import type { TmuxHint } from "../tmux-hint";
import type { SlashLine } from "../claude-input/slash-line";
import type { SessionPane } from "../claude-input/typing";
import type { RepoAnswer } from "../config/loader/repo-gate";
import type { Answered } from "../daemon/foundations/sighting-roles";

// Which request a statusline frame answers: the host's count of the requests
// of every kind it accepted, in arrival order, so renders' ids have gaps.
declare const REQUEST_ID: unique symbol;
export type RequestId = number & { readonly [REQUEST_ID]: true };

// An effect's name, minted by the renderer that returned it, which its
// `effect-done` carries back.
declare const EFFECT_ID: unique symbol;
export type EffectId = number & { readonly [EFFECT_ID]: true };

// [LAW:one-type-per-behavior] One interface over every transport: in process
// for now, a socket to the renderer's own process later. Each kind of input
// answers with its own output, so an input pays only for what it is.
export interface Renderer<O extends RendererOutput = RendererOutput> {
  answer(input: EventInput): Promise<O>;
  answer(input: AdapterInput): Promise<AdapterOutput>;
}

// [LAW:effects-at-boundaries] A renderer as its transport hands it to the
// host: each event's output with how long its turn took, timed by the
// transport around the renderer's answer, so the host tells what the hop
// cost from what the turn did, and no renderer code reads a clock.
export type TimedOutput = RendererOutput & { readonly turnMs: number };
export type TimedRenderer = Renderer<TimedOutput>;

export type RendererInput = EventInput | AdapterInput;

// [LAW:single-enforcer] The one dispatch from an input to the answer of its
// kind, which every renderer is built by. Each arm is typed by its own input
// and output, so an arm answering the other kind's output fails the build,
// which an overload's body does not.
export function rendererOf<O extends RendererOutput = RendererOutput>(arms: {
  readonly event: (input: EventInput) => Promise<O>;
  readonly adapter: (input: AdapterInput) => Promise<AdapterOutput>;
}): Renderer<O> {
  function answer(input: EventInput): Promise<O>;
  function answer(input: AdapterInput): Promise<AdapterOutput>;
  function answer(input: RendererInput): Promise<O | AdapterOutput> {
    return input.kind === "event" ? arms.event(input) : arms.adapter(input);
  }
  return { answer };
}

export interface EventInput {
  readonly kind: "event";
  readonly event: Event;
  // [LAW:effects-at-boundaries] The instant the turn runs at, read by the host:
  // the renderer reads no clock for it.
  readonly at: Instant;
}

// A session's config as its newest request names it, and the world state read
// at that request's keys.
export interface SessionConfig {
  readonly context: CheckedRenderRequest;
  readonly worldState: WorldState;
}

// [LAW:effects-at-boundaries] exception: a reach of the host's into the
// renderer that is not yet an event, listed in the adapter
// (src/renderer-interface/adapter.ts). A push opens no view and names no
// session's subscriptions, so it carries none of an event's turn: its output
// is its reply alone.
export interface AdapterInput {
  readonly kind: "adapter";
  readonly push: AdapterPush;
  readonly at: Instant;
}

// [LAW:no-silent-failure] A push's turn answers its reply, of its push's own
// kind, or how it threw, as data. A push can move what the renderer's state
// needs (a watch's reload owes a frame, or moves a view's sources), so its
// reply carries the subscriptions as they stand after it, as an event's
// output does.
export type AdapterOutput =
  | {
      readonly kind: "replied";
      readonly reply: AdapterReply;
      readonly subscriptions: Subscriptions;
    }
  | { readonly kind: "threw"; readonly failure: Failure };

// [LAW:types-are-the-program] Every input and output of a turn is plain data:
// the build fails on one a process could not carry.
export const INPUTS_CROSS: Crosses<RendererInput> = true;
export const OUTPUTS_CROSS: Crosses<TimedOutput | AdapterOutput> = true;

export type Event =
  | {
      // A renderer's start: every live session's config, as `config` hands
      // one in, in one turn, so the start's output names everything the
      // renderer serves and the host releases nothing it still holds for one.
      readonly kind: "start";
      readonly sessions: readonly SessionConfig[];
      // Who follows each session's frames now, as `viewers` hands it in.
      readonly viewers: Readonly<Record<SessionId, Viewers>>;
    }
  | {
      // What the session's config is made of, as its newest request names
      // it, delivered ahead of that request: its turn opens the session's
      // view, so the output names what the view reads before the request
      // waits on it. Until config discovery is the host's, it carries the
      // request's context, from which the renderer finds the config itself.
      readonly kind: "config";
      readonly context: CheckedRenderRequest;
      // [LAW:one-source-of-truth] The world state read at this context's own
      // keys: a session's context and its world state reach the renderer as
      // one value, so a renderer never holds a context beside a document read
      // at another request's keys.
      readonly worldState: WorldState;
    }
  | {
      // A request of a session whose `config` came before it, delivered once
      // its wait on the session's world state has ended in the host: the
      // turn draws at once, from the world state the renderer holds.
      readonly kind: "request";
      readonly id: RequestId;
      readonly context: CheckedRenderRequest;
    }
  | {
      // [LAW:one-source-of-truth] Who follows every session's frames, whole,
      // replacing the last: each lane's subscribers and whether they draw it
      // now, and whether its pane is on a screen. A session absent has no
      // feed. The renderer draws its pushed frames over these.
      readonly kind: "viewers";
      readonly viewers: Readonly<Record<SessionId, Viewers>>;
    }
  | {
      // [LAW:no-ambient-temporal-coupling] The instant the renderer last
      // declared it next needs a turn has come: the input's `at` is that
      // instant, as near the wall as the host's timer reached it, and the
      // turn does whatever falls due by then.
      readonly kind: "due";
    }
  | {
      // A session's world state moved since the one the renderer holds: read
      // at the keys of the newest `config` the host delivered for it.
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
      // [LAW:one-source-of-truth] The newest request of the click's session
      // the host holds, whose hints are the pane its lanes follow: null when
      // the click names no session, or the host holds no request of it (none
      // since a restart, or its record evicted).
      readonly latest: CheckedRenderRequest | null;
    };

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
}

// [LAW:one-type-per-behavior] Every config write is a `change`: the changes
// that take one file from what the renderer read to what it wrote, which the
// host applies to the file as it stands. A turn's changes land together or
// not at all, and each is settled with that one outcome.
// [LAW:single-enforcer] exception: a layer is named by its path, not by its
// role in a session's chain, until config discovery hands in snapshots.
// A `claude-settings` file is one the session's doctor reading handed in
// (`writableSettingsFiles`, src/doctor/gather.ts): the host refuses any other.
export interface ConfigChange {
  readonly kind: "change";
  readonly id: EffectId;
  readonly session: SessionId;
  readonly target: ChangeTarget;
  readonly changes: readonly Change[];
}

export type ChangeTarget =
  | { readonly kind: "layer"; readonly path: string }
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
      // Set over the launcher's inherited environment; null unsets.
      readonly env: Readonly<Record<string, string | null>>;
      readonly cwd: string;
      readonly refreshes: readonly RunRefresh[];
    }
  | {
      // The answer to a repository's question, which lands with the turn's
      // changes: the trust book is the host's.
      readonly kind: "approve-repo";
      readonly session: SessionId;
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

export type Effect = Present | ConfigChange | Act;

// [LAW:nothing-unseen] What a turn learned, in the order it learned it, which
// the host writes beside the input's event.
export type TurnRecord = readonly Field[];

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
  | { readonly kind: "doctor"; readonly ask: DoctorAsk };

// [LAW:one-source-of-truth] Whole, replacing the last: what every session the
// renderer holds needs read, and whose bar it draws in its tmux status line.
// The host diffs it; nothing is declared by message, so nothing has to
// remember what it asked. A session absent from it needs nothing read.
// [LAW:types-are-the-program] Keyed by session, so no session is listed twice,
// and a record, so it crosses a process as it is: a session absent is a key
// absent, never one holding `undefined`, which JSON does not carry.
export interface Subscriptions {
  readonly sources: Readonly<Record<SessionId, readonly Subscription[]>>;
  // The sessions whose tmux status line switch is on, in order: the host
  // holds each one's row in the pane its newest request reports.
  readonly tmuxStatus: readonly SessionId[];
  // The lanes each open view's settings switch on, read off the same views:
  // the host gates a subscribe against them, so a lane that is off is
  // refused before anything opens, and one a click switched on is admitted
  // from that click's turn on. A session absent has no view yet, and its
  // first frame decides.
  readonly lanes: Readonly<Record<SessionId, LaneSwitches>>;
  // [LAW:no-ambient-temporal-coupling] The instant the renderer next needs a
  // turn, derived from its state (a frame falling due, a menu's idle close,
  // a reload or a settle it holds), or null for none. The host keeps one
  // timer at it and answers with `due`; a renderer that restarts declares
  // its own, so nothing remembers what was asked.
  readonly wake: Instant | null;
}

// A frame drawn for the lanes that follow a session, which the host's
// surfaces show. It is no effect: nothing settles it.
export interface PushedFrame {
  readonly session: SessionId;
  readonly frame: WireFeedFrame;
}

// How a turn ended, a turn that threw included: its failure as data, a class
// crossing no process. Either way it carries the record it reached and the
// effects its acts made, so a click that wrote and then failed still lands
// what it wrote.
export type TurnOutcome = {
  readonly record: TurnRecord;
  readonly effects: readonly Effect[];
} & (
  | { readonly kind: "answered" }
  | { readonly kind: "threw"; readonly failure: Failure }
);

// [LAW:no-silent-failure] Every turn answers, so `answer` never rejects. Its
// output names the open views' subscriptions as they stand after it, however
// it ended: an act can land before its turn throws (a click that committed
// and followed its view), and its view is read all the same.
// `frames` are the pushed frames the turn drew, in order.
export type RendererOutput = TurnOutcome & {
  readonly subscriptions: Subscriptions;
  readonly frames: readonly PushedFrame[];
};
