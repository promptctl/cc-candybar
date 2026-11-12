import type { SpeedObservation } from "../daemon/cache/session-usage-store";
import type { TodayFacts } from "../daemon/cache/today-facts";
import type { RefreshLane } from "../daemon/refresh-faults";
import type { SessionId } from "../daemon/session-id";
import type { Update } from "../daemon/update-notice";
import type { ActivityInfo } from "../segments/activity";
import type { AutoCompactWindow } from "../segments/autocompact";
import type { GitRead, PullRequest } from "../segments/git";
import type { MetricsFold } from "../segments/metrics";
import type { TranscriptUsage } from "../segments/session";
import type { JsonValue } from "../var-system/types";
import type { Fact } from "./fact";
import { pendingOf } from "../utils/outcome";

// [LAW:types-are-the-program] The seam between the host and a renderer: one
// total document per session. Every field exists on every document; a fact
// not yet known is the `pending` arm, one found to be nothing is `absent`, one
// whose read failed carries its reason and the phase it failed in. The value
// types are the ones the daemon's owners already produce, so each owner's
// current output is its fact's `T` as it stands.
//
// What stays out is the renderer's: the hook's instantaneous fields, client
// hints, settings, picks, config facts, feeds, the drawing and the menu. The
// payload a template reads is composed from these, the hook, the hints and the
// renderer's own state.

// What the declared plugin sources read, by their variables' names.
export type SourceId = string;
export type SourceValue = JsonValue;

// [LAW:types-are-the-program] What a `shell` or `file` run read, and why its
// watch may be missing changes (`null` when it hears every place its path can
// change, or watches nothing). Keyed apart from the plugin sources, by the
// run's digest, so two variables naming one run read one entry.
export interface RunFact {
  readonly reading: Fact<SourceValue>;
  readonly fault: string | null;
}

// [LAW:types-are-the-program] A run no world state carries yet: never read,
// with no watch to fault.
export const UNREAD_RUN: RunFact = {
  reading: pendingOf("unread"),
  fault: null,
};

// [LAW:types-are-the-program] A run a retired view names that the world state
// no longer carries: its successor named another, and no host reads it again,
// so it draws loading and nothing waits on it (`awaitedReading`).
export const SUPERSEDED_RUN: RunFact = {
  reading: pendingOf("superseded"),
  fault: null,
};

// The tmux session the pane belongs to.
export interface TmuxFacts {
  readonly session: string;
}

// The release check: something newer than the running code, or absent.
export type UpdateNotice = Update;

// A fault of the collector's own: one lane of the session whose refresh threw,
// or the stamp itself, which kept the readings of the document before it.
export interface LaneDiagnostic {
  readonly kind: "lane";
  readonly lane: RefreshLane;
  readonly reason: string;
}
export interface StampDiagnostic {
  readonly kind: "stamp";
  readonly reason: string;
}
export type FactsDiagnostic = LaneDiagnostic | StampDiagnostic;

// [LAW:types-are-the-program] `session`, `context` and `metrics` are the
// transcript's folds alone: the hook's instantaneous fields (cost, the
// context window, durations, lines) are the renderer's, laid over them when
// the payload is composed, so a document is gathered from the session's
// locator and never from a request.
export interface BuiltinFacts {
  readonly session: Fact<TranscriptUsage>;
  readonly today: Fact<TodayFacts>;
  readonly speed: Fact<SpeedObservation>;
  // The transcript's context tokens: its newest main-chain usage entry's.
  readonly context: Fact<number>;
  readonly metrics: Fact<MetricsFold>;
  readonly activity: Fact<ActivityInfo>;
  readonly cache: Fact<number>;
  readonly autocompact: Fact<AutoCompactWindow>;
  // The repository's read; its PR is its own fact, because its cost is its own.
  readonly git: Fact<GitRead>;
  readonly pr: Fact<PullRequest>;
  readonly tmux: Fact<TmuxFacts>;
  // The host's name and its user are read apart and fail apart (a directory
  // service briefly away fails the user alone), so each is its own fact.
  readonly hostName: Fact<string>;
  readonly hostUser: Fact<string>;
}

export interface WorldState {
  readonly v: number;
  readonly session: SessionId;
  readonly seq: number;
  readonly builtins: BuiltinFacts;
  readonly sources: Readonly<Record<SourceId, Fact<SourceValue>>>;
  readonly runs: Readonly<Record<string, RunFact>>;
  readonly update: Fact<UpdateNotice>;
  readonly diagnostics: readonly FactsDiagnostic[];
}
