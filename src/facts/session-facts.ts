import type { SpeedObservation } from "../daemon/cache/session-usage-store";
import type { TodayFacts } from "../daemon/cache/today-facts";
import type { RefreshLane } from "../daemon/refresh-faults";
import type { SessionId } from "../daemon/session-id";
import type { Update } from "../daemon/update-notice";
import type { ActivityInfo } from "../segments/activity";
import type { AutoCompactWindow } from "../segments/autocompact";
import type { ContextInfo } from "../segments/context";
import type { GitInfo, PullRequest } from "../segments/git";
import type { MetricsInfo } from "../segments/metrics";
import type { UsageInfo } from "../segments/session";
import type { JsonValue } from "../var-system/types";
import type { Fact } from "./fact";

// [LAW:types-are-the-program] The seam between Gather and a renderer: one
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

// What the declared plugin sources read, by their ids.
export type SourceId = string;
export type SourceValue = JsonValue;

// [LAW:one-source-of-truth] A `shell` or `file` source's run, keyed by its
// identity's digest (src/var-system/source-runs.ts): what it read, and why
// its watch may be missing changes to its path, or `null` when it hears
// every place the path can change or watches nothing. The fault crosses with
// the reading because both are the run's, and the renderer draws the fault as
// the variable's standing refresh warning.
export type SourceDigest = string;
export interface RunFact {
  readonly reading: Fact<SourceValue>;
  readonly fault: string | null;
}

// The tmux session the pane belongs to.
export interface TmuxFacts {
  readonly session: string;
}

// The git read of a repository before a PR is composed onto it: the PR is its
// own fact, because its cost is its own.
export type GitFacts = Omit<GitInfo, "pullRequest">;

// The release check: something newer than the running code, or absent.
export type UpdateNotice = Update;

// A fault of Gather's own for one lane of the session.
export interface FactsDiagnostic {
  readonly lane: RefreshLane;
  readonly reason: string;
}

export interface BuiltinFacts {
  readonly session: Fact<UsageInfo>;
  readonly today: Fact<TodayFacts>;
  readonly speed: Fact<SpeedObservation>;
  readonly context: Fact<ContextInfo>;
  readonly metrics: Fact<MetricsInfo>;
  readonly activity: Fact<ActivityInfo>;
  readonly cache: Fact<number>;
  readonly autocompact: Fact<AutoCompactWindow>;
  readonly git: Fact<GitFacts>;
  readonly pr: Fact<PullRequest>;
  readonly tmux: Fact<TmuxFacts>;
  // The host's name and its user are read apart and fail apart (a directory
  // service briefly away fails the user alone), so each is its own fact.
  readonly hostName: Fact<string>;
  readonly hostUser: Fact<string>;
}

// The shape of a facts document on the wire; a document of another version is
// not this one.
export const FACTS_VERSION = 2;

export interface SessionFacts {
  readonly v: number;
  readonly session: SessionId;
  readonly seq: number;
  readonly builtins: BuiltinFacts;
  readonly sources: Readonly<Record<SourceId, Fact<SourceValue>>>;
  // A run is read by a variable's node, never by a payload path, so it is a
  // field apart from the plugin sources the payload projects.
  readonly runs: Readonly<Record<SourceDigest, RunFact>>;
  readonly update: Fact<UpdateNotice>;
  readonly diagnostics: readonly FactsDiagnostic[];
}

// [LAW:one-source-of-truth] Every built-in by name, once, for a walk over a
// document: the parser reads it, and the type check beside it refuses a key
// the list misses or invents.
export const BUILTIN_FACTS = [
  "session",
  "today",
  "speed",
  "context",
  "metrics",
  "activity",
  "cache",
  "autocompact",
  "git",
  "pr",
  "tmux",
  "hostName",
  "hostUser",
] as const satisfies ReadonlyArray<keyof BuiltinFacts>;
type MissingBuiltin = Exclude<
  keyof BuiltinFacts,
  (typeof BUILTIN_FACTS)[number]
>;
const everyBuiltinNamed: MissingBuiltin extends never ? true : never = true;
void everyBuiltinNamed;
