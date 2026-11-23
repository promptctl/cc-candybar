import { compareStructural } from "mobx";
import { restamp, type Fact } from "../facts/fact";
import { ownValue } from "../utils/plain";
import type {
  BuiltinFacts,
  DaemonFacts,
  RunFact,
  WorldState,
  SourceValue,
} from "../facts/world-state";
import type { GitInfo, GitRead, PullRequest } from "../segments/git";
import type { Instant } from "../utils/instant";
import { ABSENT, failed, ok, type Reading } from "../utils/outcome";
import { awaitedReading } from "../facts/awaited";
import type { Subscribed } from "../renderer-interface/request-context";
import type { SessionId } from "./foundations/session-id";
import type { Readings } from "./readings";
import {
  environmentOutput,
  isEnvironmentOutput,
} from "./environment-output.js";

// The shape of a facts document on the wire; a document of another version is
// not this one.
export const FACTS_VERSION = 5;

// A reading's value carried through `project`; every other arm as it stands.
const over = <T, U>(
  reading: Reading<T>,
  project: (value: T) => U,
): Reading<U> => (reading.kind === "ok" ? ok(project(reading.value)) : reading);

// [LAW:types-are-the-program] The PR is its own fact (its cost is its own),
// asked of the repository's lane: no repository has no PR, and a repository
// that failed to read cannot be asked.
function prOf(git: Reading<GitInfo>): Reading<PullRequest> {
  switch (git.kind) {
    case "pending":
    case "failed":
      return git;
    case "absent":
      return ABSENT;
    case "ok":
      return git.value.pullRequest;
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

function gitFactsOf({ pullRequest: _pullRequest, ...git }: GitInfo): GitRead {
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
  prior: WorldState | undefined,
  session: SessionId,
  readings: Readings,
  daemon: DaemonFacts,
  at: Instant,
): WorldState {
  const { lanes } = readings;
  const stamp = <T>(held: Fact<T> | undefined, reading: Reading<T>): Fact<T> =>
    restamp(held, reading, at);
  const held = prior?.builtins;

  const builtins: BuiltinFacts = {
    session: stamp(held?.session, lanes.usage),
    today: stamp(held?.today, readings.today),
    speed: stamp(held?.speed, lanes.speed),
    context: stamp(held?.context, lanes.context),
    metrics: stamp(held?.metrics, lanes.metrics),
    activity: stamp(held?.activity, lanes.activity),
    cache: stamp(held?.cache, lanes.cache),
    autocompact: stamp(held?.autocompact, lanes.autoCompact),
    git: stamp(held?.git, over(lanes.git, gitFactsOf)),
    pr: stamp(held?.pr, prOf(lanes.git)),
    tmux: stamp(
      held?.tmux,
      over(lanes.tmuxSession, (name) => ({ session: name })),
    ),
    hostName: stamp(held?.hostName, lanes.hostName),
    hostUser: stamp(held?.hostUser, lanes.hostUser),
  };
  // [LAW:dataflow-not-control-flow] Every source the config declares has a
  // lane, and so a key.
  const sources: Record<string, Fact<SourceValue>> = Object.fromEntries(
    [...lanes.sources].map(([name, reading]) => [
      name,
      stamp(prior && ownValue(prior.sources, name), reading),
    ]),
  );

  // Each run by digest; an entry whose reading and fault are both the prior's
  // is the prior entry itself, so `sameFacts` finds it unmoved.
  const runs: Record<string, RunFact> = Object.fromEntries(
    [...lanes.runs].map(([digest, observation]) => {
      const { reading, fault } = observation;
      const held = prior && ownValue(prior.runs, digest);
      const fact = stamp(held?.reading, reading);
      const privateOutput = isEnvironmentOutput(observation);
      return [
        digest,
        held !== undefined &&
        held.reading === fact &&
        held.fault === fault &&
        isEnvironmentOutput(held) === privateOutput
          ? held
          : environmentOutput({ reading: fact, fault }, privateOutput),
      ];
    }),
  );

  const env: Record<string, Fact<string>> = Object.fromEntries(
    [...lanes.env].map(([name, reading]) => [
      name,
      stamp(prior && ownValue(prior.env, name), reading),
    ]),
  );

  const diagnostics = readings.faults;
  const parts = { builtins, sources, runs, env, daemon, diagnostics };
  // [LAW:single-enforcer] `restamp` is the one judge of whether a fact moved,
  // and it returns the prior fact itself when not, so the document is
  // unmoved when every fact is the prior's own. The builtins, sources and runs are
  // compared by that identity, never walked again (a source's value can be
  // large JSON); the daemon's facts and the diagnostics are small and not
  // restamped here.
  if (
    prior !== undefined &&
    sameFacts(builtins, prior.builtins) &&
    sameFacts(sources, prior.sources) &&
    sameFacts(runs, prior.runs) &&
    sameFacts(env, prior.env) &&
    compareStructural(
      { daemon, diagnostics },
      { daemon: prior.daemon, diagnostics: prior.diagnostics },
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

// [LAW:single-enforcer] The other way a document is minted: a stamp that threw
// keeps the readings of `prior` and says why, with the next `seq`, so the bar's
// ⚠ says it is drawn from older facts. The daemon's facts are read apart from
// the session's owners, so they are `daemon` as it stands whatever threw. A
// failure for the reason already held, over the daemon's facts already held,
// is that document, so a fault that persists mints nothing per landing; the
// next stamp that succeeds carries no stamp diagnostic, and so moves too.
//
// [LAW:no-silent-failure] A fact that has never answered cannot now: its owners
// could not be read. So it is that failure, and so is each key the session
// subscribes to that the document lacks, instead of an absence a request's wait
// could not tell from "not read yet" (`unreadOf`, src/facts/awaited.ts). A fact
// that answered keeps its answer, and the next clean stamp restamps them all.
export function failedStamp(
  prior: WorldState,
  reason: string,
  daemon: DaemonFacts,
  subscribed: Subscribed,
  at: Instant,
): WorldState {
  const lost = <T>(): Fact<T> =>
    restamp<T>(undefined, failed(reason, "read"), at);
  const unreadLost = <T>(fact: Fact<T>): Fact<T> =>
    awaitedReading(fact) ? lost<T>() : fact;
  // The keys the document lacks, each as the failure, beside the ones it has.
  const withLacking = <T>(
    held: Readonly<Record<string, T>>,
    names: Iterable<string>,
    absent: () => T,
  ): Record<string, T> => ({
    ...held,
    ...Object.fromEntries(
      [...names]
        .filter((name) => ownValue(held, name) === undefined)
        .map((name) => [name, absent()]),
    ),
  });
  const mapped = <T, U>(
    held: Readonly<Record<string, T>>,
    f: (value: T) => U,
  ): Record<string, U> =>
    Object.fromEntries(Object.entries(held).map(([k, v]) => [k, f(v)]));
  // The prior record itself when no fact in it moved.
  const kept = <T extends object>(now: T, held: T): T =>
    sameFacts(now, held) ? held : now;
  // [LAW:types-are-the-program] exception: the keys of `BuiltinFacts` are the
  // keys of `prior.builtins`, and each fact keeps its own value type.
  const builtins = kept(
    Object.fromEntries(
      Object.entries(prior.builtins).map(([key, fact]) => [
        key,
        unreadLost(fact),
      ]),
    ) as unknown as BuiltinFacts,
    prior.builtins,
  );
  const sources = kept(
    withLacking<Fact<SourceValue>>(
      mapped(prior.sources, unreadLost),
      subscribed.plugins.keys(),
      lost,
    ),
    prior.sources,
  );
  const runs = kept(
    withLacking<RunFact>(
      mapped<RunFact, RunFact>(prior.runs, (run) => {
        const reading = unreadLost(run.reading);
        return reading === run.reading
          ? run
          : environmentOutput(
              { reading, fault: run.fault },
              isEnvironmentOutput(run),
            );
      }),
      subscribed.runs.keys(),
      () => ({ reading: lost(), fault: null }),
    ),
    prior.runs,
  );
  const env = kept(
    withLacking<Fact<string>>(
      mapped(prior.env, unreadLost),
      subscribed.env,
      lost,
    ),
    prior.env,
  );
  const held = prior.diagnostics.find((d) => d.kind === "stamp");
  if (
    held?.reason === reason &&
    compareStructural(daemon, prior.daemon) &&
    builtins === prior.builtins &&
    sources === prior.sources &&
    runs === prior.runs &&
    env === prior.env
  )
    return prior;
  return {
    ...prior,
    builtins,
    sources,
    runs,
    env,
    daemon,
    seq: prior.seq + 1,
    diagnostics: [
      ...prior.diagnostics.filter((d) => d.kind !== "stamp"),
      { kind: "stamp", reason },
    ],
  };
}
