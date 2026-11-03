import { compareStructural } from "mobx";
import { restamp, type Fact } from "../facts/fact";
import type {
  BuiltinFacts,
  GitFacts,
  SessionFacts,
  SourceValue,
  UpdateNotice,
} from "../facts/session-facts";
import type { GitInfo, PullRequest } from "../segments/git";
import type { Instant } from "../utils/instant";
import { ABSENT, ok, pendingOf, type Reading } from "../utils/outcome";
import type { SessionId } from "./session-id";
import type { Readings } from "./render-payload";

// The shape of a facts document on the wire; a document of another version is
// not this one.
export const FACTS_VERSION = 1;

// [LAW:dataflow-not-control-flow] A built-in the closure does not gather has
// no reading, and its fact says so: pending, never a read that found nothing.
const gathered = <T>(on: boolean, reading: Reading<T>): Reading<T> =>
  on ? reading : pendingOf("unread");

// A reading's value carried through `project`; every other arm as it stands.
const over = <T, U>(
  reading: Reading<T>,
  project: (value: T) => U,
): Reading<U> => (reading.kind === "ok" ? ok(project(reading.value)) : reading);

// [LAW:types-are-the-program] The PR is its own fact (its cost is its own),
// asked of the repository's lane: no repository has no PR, a repository that
// failed to read cannot be asked, and a repository read without a PR lane (the
// closure did not ask) has not been asked.
function prOf(git: Reading<GitInfo>): Reading<PullRequest> {
  switch (git.kind) {
    case "pending":
    case "failed":
      return git;
    case "absent":
      return ABSENT;
    case "ok":
      return git.value.pullRequest ?? pendingOf("unread");
  }
}

// The same keys, each holding the very fact it held.
const sameFacts = <T extends object>(now: T, held: T): boolean => {
  const entries = Object.entries(now);
  return (
    entries.length === Object.keys(held).length &&
    entries.every(([key, fact]) => Object.is(fact, Reflect.get(held, key)))
  );
};

function gitFactsOf({ pullRequest: _pullRequest, ...git }: GitInfo): GitFacts {
  return git;
}

// [LAW:single-enforcer] The one definition of a session's facts document: every
// owner's reading of this turn folded into its fact, each stamped by `restamp`
// against the document it replaces. A turn in which nothing moved returns that
// document itself, so nothing holding it, and no observer of it, is touched.
//
// [LAW:effects-at-boundaries] Pure: `at` is the instant of the turn, taken by
// the caller, and the prior document is the caller's to hold.
export function assembleFacts(
  prior: SessionFacts | undefined,
  session: SessionId,
  readings: Readings,
  update: Fact<UpdateNotice>,
  at: Instant,
): SessionFacts {
  const { lanes, gathered: on } = readings;
  const git = gathered(on.git, lanes.git);
  const stamp = <T>(held: Fact<T> | undefined, reading: Reading<T>): Fact<T> =>
    restamp(held, reading, at);
  const held = prior?.builtins;

  const builtins: BuiltinFacts = {
    session: stamp(held?.session, gathered(on.session, lanes.usage)),
    today: stamp(held?.today, gathered(on.today, readings.today)),
    speed: stamp(held?.speed, gathered(on.speed, lanes.speed)),
    context: stamp(held?.context, gathered(on.context, lanes.context)),
    metrics: stamp(held?.metrics, gathered(on.metrics, lanes.metrics)),
    activity: stamp(held?.activity, gathered(on.activity, lanes.activity)),
    cache: stamp(held?.cache, gathered(on.cache, lanes.cache)),
    autocompact: stamp(
      held?.autocompact,
      gathered(on.autocompact, lanes.autoCompact),
    ),
    git: stamp(held?.git, over(git, gitFactsOf)),
    pr: stamp(held?.pr, prOf(git)),
    tmux: stamp(
      held?.tmux,
      over(gathered(on.tmux, lanes.tmuxSession), (name) => ({ session: name })),
    ),
    hostName: stamp(held?.hostName, gathered(on.hostName, lanes.hostName)),
    hostUser: stamp(held?.hostUser, gathered(on.hostUser, lanes.hostUser)),
  };
  // [LAW:dataflow-not-control-flow] Every source the config declares has a
  // key; one the closure does not reach has no lane, and is pending.
  const sources: Record<string, Fact<SourceValue>> = Object.fromEntries(
    readings.declaredSources.map((name) => [
      name,
      stamp(
        prior?.sources[name],
        lanes.sources.get(name) ?? pendingOf("unread"),
      ),
    ]),
  );

  const parts = { builtins, sources, update, diagnostics: readings.faults };
  // [LAW:single-enforcer] `restamp` is the one judge of whether a fact moved,
  // and it returns the prior fact itself when not, so the document is
  // unmoved when every fact is the prior's own. The builtins and sources are
  // compared by that identity, never walked again (a source's value can be
  // large JSON); the update and diagnostics are small and not restamped here.
  if (
    prior !== undefined &&
    sameFacts(builtins, prior.builtins) &&
    sameFacts(sources, prior.sources) &&
    compareStructural(
      { update, diagnostics: readings.faults },
      { update: prior.update, diagnostics: prior.diagnostics },
    )
  ) {
    return prior;
  }
  return {
    v: FACTS_VERSION,
    session,
    seq: prior === undefined ? 1 : prior.seq + 1,
    ...parts,
  };
}
