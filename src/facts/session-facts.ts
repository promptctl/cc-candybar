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
import { undeclaredOf, type Undeclared } from "../utils/outcome";
import type { Fact } from "./fact";

// [LAW:types-are-the-program] The seam between Gather and a renderer: one
// document per session, complete over what the renderer declared. Every
// declared field exists on every document; a fact not yet known is the
// `pending` arm, one found to be nothing is `absent`, one
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

// [LAW:types-are-the-program] Each built-in by name, with the value its owner
// produces: the one map from a built-in's name to its type, which the
// document, a lane and a payload row all key on.
export interface BuiltinValues {
  readonly session: UsageInfo;
  readonly today: TodayFacts;
  readonly speed: SpeedObservation;
  readonly context: ContextInfo;
  readonly metrics: MetricsInfo;
  readonly activity: ActivityInfo;
  readonly cache: number;
  readonly autocompact: AutoCompactWindow;
  readonly git: GitFacts;
  readonly pr: PullRequest;
  readonly tmux: TmuxFacts;
  // The host's name and its user are read apart and fail apart (a directory
  // service briefly away fails the user alone), so each is its own fact.
  readonly hostName: string;
  readonly hostUser: string;
}
export type BuiltinName = keyof BuiltinValues;

// [LAW:dataflow-not-control-flow] The built-ins a renderer declared, each a
// key, as `sources` holds the sources it declared: a built-in its config does
// not read is gathered by nobody and has no key, never a pending that will
// not land.
export type BuiltinFacts = {
  readonly [K in BuiltinName]?: Fact<BuiltinValues[K]>;
};

// The shape of a facts document on the wire; a document of another version is
// not this one. 3: the built-ins are keyed by the declaration, so a reader of
// an earlier version, which takes every built-in as a key, refuses rather
// than throws on the first key it does not find.
export const FACTS_VERSION = 3;

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
] as const satisfies readonly BuiltinName[];
type MissingBuiltin = Exclude<BuiltinName, (typeof BUILTIN_FACTS)[number]>;
const everyBuiltinNamed: MissingBuiltin extends never ? true : never = true;
void everyBuiltinNamed;

// [LAW:parse-dont-validate] The built-ins a renderer declares, as the one
// constructor below builds them: in the document's order, and closed under
// what a fact is read from. The PR is asked of the repository's read, so a
// declaration naming `pr` names `git`, and a set holding the PR alone cannot
// be spelled.
declare const declared: unique symbol;
export type DeclaredBuiltins = ReadonlySet<BuiltinName> & {
  readonly [declared]: true;
};

export function declaredBuiltins(
  names: Iterable<BuiltinName>,
): DeclaredBuiltins {
  const named = new Set(names);
  if (named.has("pr")) named.add("git");
  return new Set(
    BUILTIN_FACTS.filter((name) => named.has(name)),
  ) as unknown as DeclaredBuiltins;
}

// [LAW:single-enforcer] The one reading of a document's built-in: its fact, or
// `Undeclared` when the renderer that followed it did not declare it. Nothing
// else tests a document's key.
export function builtinOf<K extends BuiltinName>(
  facts: SessionFacts,
  name: K,
): Fact<BuiltinValues[K]> | Undeclared {
  const fact: Fact<BuiltinValues[K]> | undefined = facts.builtins[name];
  return fact ?? undeclaredOf(name);
}
