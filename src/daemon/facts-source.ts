// [LAW:locality-or-seam] The facts source: the one interface a renderer's view
// follows a session's facts through, and the arms behind it
// (docs/design/gather-and-renderer.md §14). Above it, a view holds a document
// and knows nothing of where it came from; below it, the in-process arm reads
// the daemon's own owners and the recording arm replays lines under the
// renderer's clock. The recording arm is the proof the interface is the whole
// seam: a replay draws what the live session drew with nothing read and nothing
// spawned (test/facts-seam.test.ts).
//
// [LAW:one-type-per-behavior] Two arms, one shape. Nothing above the interface
// branches on which it has.

import { inspect } from "node:util";
import {
  computed,
  observable,
  reaction,
  runInAction,
  type IObservableValue,
} from "mobx";
import type { Fact } from "../facts/fact";
import type { FactsLine, Recording, ReplayLine } from "../facts/recording";
import type {
  SessionFacts,
  SourceDigest,
  UpdateNotice,
} from "../facts/session-facts";
import { Holds } from "../utils/holds";
import { instantAt, type Instant } from "../utils/instant";
import { failed, failedWith, pendingOf, type Reading } from "../utils/outcome";
import {
  digestOf,
  whereOf,
  type SourceIdentity,
  type SourceLane,
  type SourceLanes,
  type SourceRuns,
} from "../var-system/source-runs";
import type { JsonValue } from "../var-system/types";
import { assembleFacts } from "./facts-assembly";
import type { PayloadProviders } from "./payload-providers";
import {
  declareLanes,
  readingsOf,
  settledLanes,
  settlePayload,
  type DeclaredLanes,
  type DeclaredSources,
  type PayloadInputs,
  type Readings,
  type Refreshed,
  type RunReading,
  type ViewFacts,
  unstamped,
} from "./render-payload";
import type { SessionId } from "./session-id";

// What a view declares of a session beyond the request it draws by: the
// plugin sources its config declares, at the storage keys the state's build
// took for them. Every built-in is gathered, so nothing a layout places is
// declared.
export interface FollowDeclaration {
  readonly sources: DeclaredSources;
}

// What a view's source reads of a follow: the document as the source last
// stamped it, with the instant of that stamp (one line of a recording, which
// is what a recorder writes and a replay reads), and the source's own fault
// when the stamp after it could not be made — while that is set, the line is
// the last one that could, and the bar says it is drawn from older facts
// (src/daemon/session-source.ts).
export interface FollowedFacts {
  // A MobX read: a derivation over it re-runs in the turn the document moves,
  // and reads the prior object when nothing did.
  readonly stamped: () => FactsLine;
  readonly failure: () => string | null;
}

// What a request's arrival started of the facts (rule 1 of the model, in
// .claude/memory/data-sources.md): the arm's record of each lane it started
// and how long it took, filled as each lands so a deadline that cuts the wait
// still reads which were out, and the landing of those beside the first value
// of every declared lane, today's sums and the PR excepted.
export interface Settling {
  readonly refreshed: Refreshed;
  readonly landed: Promise<void>;
}

export interface Followed extends FollowedFacts {
  // The same session followed again at other keys: a request naming other
  // hints or another directory. Synchronous,
  // in the caller's own turn, so a frame drawn in that turn draws the view
  // declared for it.
  follow(facts: ViewFacts, declaration: FollowDeclaration): void;
  // What a request arriving at `at` starts of the facts. `at` is the request's
  // instant, so what is sampled at it (tok/s) and what is drawn at it read one
  // clock reading.
  settle(at: Instant): Settling;
  // [LAW:locality-or-seam] Where the view's `shell` and `file` sources get
  // their lanes (src/var-system/source-runs.ts, SourceLanes): each lane reads
  // the follow's own document, so a view draws a run only through the facts
  // seam. A declaration's hold is the caller's, and ends the arm's run of it
  // when released; the run itself is the arm's.
  readonly runs: SourceLanes;
  // The follow's holds, timers and reactions go. A view disposed without it
  // leaks every hold its declaration took. A registry declaring through
  // `runs` releases its declarations first (src/daemon/cache/render.ts).
  dispose(): void;
}

export interface Facts {
  // A view follows the request's session at the request it draws by and what
  // it declares beyond it. A follow whose first document cannot be made
  // throws, having released what it took.
  follow(facts: ViewFacts, declaration: FollowDeclaration): Followed;
}

// ─── The in-process arm ──────────────────────────────────────────────────────

export interface InProcessFactsDeps {
  readonly providers: PayloadProviders;
  // The daemon's one update fact, stamped by its watch
  // (src/daemon/update-notice.ts): every session's document carries it.
  readonly update: () => Fact<UpdateNotice>;
  // [LAW:single-enforcer] The one owner of every `shell` and `file` source's
  // runs: a run is one per identity, however many follows declare it.
  readonly runs: SourceRuns;
}

// [LAW:no-silent-failure] A run's lane as a document answers it. A digest
// the document lacks is answered by `missing`, the arm's own word on whether
// the run is coming, never by a reaction's timing.
function runLaneOver(
  identity: SourceIdentity,
  document: () => SessionFacts,
  missing: (digest: SourceDigest) => Reading<never>,
): SourceLane {
  const digest = digestOf(identity);
  const run = () => document().runs[digest];
  return {
    digest,
    current: (): Reading<JsonValue> => {
      const fact = run();
      return fact === undefined ? missing(digest) : unstamped(fact.reading);
    },
    fault: () => run()?.fault ?? null,
  };
}

// What a follow holds of its declaration: the request and the lanes that
// declaration took — one record, written whole by each declaration, so a
// reader never joins one declaration's request to another's lanes.
interface Declared {
  readonly facts: ViewFacts;
  readonly lanes: DeclaredLanes;
}

// The line as last stamped, and why the stamp after it could not be made.
interface Stamped {
  readonly line: FactsLine;
  readonly failure: string | null;
}

// What a stamp reads, or what stopped it reading: a derivation that throws is
// a stamp that did not complete, not a reaction that never ran.
type Moved =
  | {
      readonly kind: "read";
      readonly readings: Readings;
      readonly update: Fact<UpdateNotice>;
    }
  | { readonly kind: "failed"; readonly reason: string };

// [LAW:single-enforcer] The one stamp of a document, against the one it
// replaces. The prior value itself is returned when nothing moved (the
// document's identity is `assembleFacts`'s verdict), so nothing holding it is
// touched; a stamp that cannot be made keeps the prior line and says why.
//
// [LAW:no-silent-failure] A failed stamp is a value the view reads
// (`failure`), not only a line in the daemon's log.
function stamped(
  prior: Stamped,
  moved: Moved,
  at: Instant,
  session: SessionId,
): Stamped {
  if (moved.kind === "failed") return failedWith(prior, moved.reason);
  try {
    const facts = assembleFacts(
      prior.line.facts,
      session,
      moved.readings,
      moved.update,
      at,
    );
    // The line is the document's: a fault clearing over the same document is
    // the prior line with its failure gone, never a second line of it with
    // an instant no fact was stamped at, which a recorder would write.
    const line = facts === prior.line.facts ? prior.line : { at, facts };
    return line === prior.line && prior.failure === null
      ? prior
      : { line, failure: null };
  } catch (e) {
    return failedWith(prior, `stamping the facts document: ${String(e)}`);
  }
}

// [LAW:single-enforcer] The arm today's daemon and demo run on: the one
// taker of a view's holds on the daemon's shared entries (a repo, a pane, a
// plugin's session file, a directory set's scans), and the one assembly of a
// session's document from what those owners hold. The holds are taken where
// the follow is declared, released by the declaration that no longer names
// them, and closed by the follow's dispose; the document is stamped in a
// reaction on the providers' clock, in the turn an owner's reading moves.
//
// [LAW:no-ambient-temporal-coupling] The document is stamped in a reaction's
// effect, never a derivation: a stamp is the turn's instant, and a computed
// that read the clock and its own prior answer would answer by when it ran.
//
// [LAW:one-source-of-truth] exception: the follow's derivations are its own,
// not the view's variable store's. The arm is Gather's side of the seam and
// reads nothing of a renderer; the store is the renderer's one holder of what
// its templates derive, and is not at this depth to hold these. The follow's
// one reaction holds them and its dispose, which the view's release calls,
// lets them go.
//
// A request's wait is this arm's own: a request starts the re-read of its
// session's transcript lanes and draws once they land, which is what keeps
// the bar's sums current on the tick that follows a message. The split ends
// it (spec §13 has no acknowledgement), and a recording never had it.
export function inProcessFacts({
  providers,
  update,
  runs,
}: InProcessFactsDeps): Facts {
  const { clock, log } = providers;
  return {
    follow(facts, declaration) {
      const session = facts.sessionId;
      const holds = new Holds();
      // [LAW:single-enforcer] What the follow runs for the view's `shell` and
      // `file` sources: the identities the view declared through `runs`
      // (below), each added by its declaration's hold and taken out by its
      // release, and the lanes of their runs, held in a Holds of the
      // follow's own and so ended by its dispose. Apart from `holds`, which
      // a request's re-declaration of the built-ins reconciles.
      const declaredRuns = observable.map<SourceDigest, SourceIdentity>(
        undefined,
        { deep: false },
      );
      const runHolds = new Holds();
      const runLanes = observable.map<SourceDigest, SourceLane>(undefined, {
        deep: false,
      });
      // [LAW:no-ambient-temporal-coupling] Re-declared synchronously, in the
      // turn a declaration is taken or released, so the run a moved key
      // names is held before the one it leaves is released: the caller's
      // Holds takes the new declaration before it releases the old.
      const declareRuns = (): void => {
        const { result } = runHolds.declare(() =>
          [...declaredRuns].map(
            ([digest, identity]) =>
              [digest, runs.declare(runHolds, identity)] as const,
          ),
        );
        runInAction(() => runLanes.replace(result));
      };
      const sid = JSON.stringify(session);
      // [LAW:no-silent-failure] A declaration that throws is logged here,
      // where it runs — a reaction's tracked expression that throws reaches
      // only the console MobX prints to, which nobody reads in a detached
      // daemon. It keeps the holds it had, and its lanes answer its failure,
      // naming the cause.
      //
      // [LAW:dataflow-not-control-flow] A lane whose owner throws is a fault
      // answered on that lane (declareLanes), and a declaration that throws
      // whole is answered the same way on every lane, so the bar draws with
      // its ⚠ on the open, each request and a pick alike, never a request
      // that fails on every tick or a pick that only logs. What the throw took
      // stays held until a declaration that returns releases it, or the
      // follow's dispose closes it.
      const lanesFor = (
        facts: ViewFacts,
        { sources }: FollowDeclaration,
      ): DeclaredLanes => {
        try {
          const {
            result: { lanes, faults },
            acquired,
            released,
          } = holds.declare(() =>
            declareLanes(providers, holds, facts, sources),
          );
          for (const fault of faults) {
            log("error", `session view declaration threw sid=${sid} ${fault}`);
          }
          // [LAW:verifiable-goals] A declaration that moved a hold — a request
          // naming another key — says so; one that kept what the view held,
          // every other request's, writes nothing.
          if (acquired + released > 0) {
            log(
              "info",
              `session view declared sid=${sid} acquired=${acquired} released=${released} held=${holds.size}`,
            );
          }
          return lanes;
        } catch (e) {
          log(
            "error",
            `session view declaration threw sid=${sid}: ${inspect(e)}`,
          );
          return settledLanes(
            failed(`view declaration threw: ${String(e)}`, "read"),
            [...sources.keys()],
          );
        }
      };
      const declared = observable.box<Declared>(
        { facts, lanes: lanesFor(facts, declaration) },
        { deep: false },
      );
      // [LAW:one-source-of-truth] What the owners are read by: the request
      // and the lanes of ONE declaration.
      const inputs = computed((): PayloadInputs => {
        const { facts } = declared.get();
        return {
          hookData: facts.hookData,
          cwd: facts.cwd,
          hints: facts.hints,
          // The lanes as declared now, read at each call: a settle in flight
          // waits out the lanes a follow during it took, not the ones it
          // started with.
          deps: { ...providers, lanes: () => declared.get().lanes },
        };
      });
      // What the session's owners and the view's runs hold now, read once per
      // turn. A run's value is what its parser made of text, so JSON.
      const readings = computed(
        (): Readings => ({
          ...readingsOf(inputs.get()),
          runs: new Map(
            [...runLanes].map(([digest, lane]): [SourceDigest, RunReading] => [
              digest,
              {
                reading: lane.current() as Reading<JsonValue>,
                fault: lane.fault(),
              },
            ]),
          ),
        }),
      );
      // [LAW:one-source-of-truth] The reaction is installed before the first
      // stamp, so the derivations above are observed from the follow's first
      // read: a computed nobody observes is recomputed on every read, and the
      // opening stamp and each settle would read the owners again. Its effect
      // runs only once a reading moves, which is after the box below exists.
      let box: IObservableValue<Stamped>;
      const stop = reaction(
        (): Moved => {
          try {
            return { kind: "read", readings: readings.get(), update: update() };
          } catch (e) {
            return {
              kind: "failed",
              reason: `reading the owners: ${String(e)}`,
            };
          }
        },
        (moved) =>
          runInAction(() => {
            const prior = box.get();
            const next = stamped(prior, moved, instantAt(clock), session);
            if (next.failure !== null && next !== prior) {
              // [LAW:no-silent-failure] Told to the log as well as to the bar.
              log("error", `session facts sid=${sid}: ${next.failure}`);
            }
            box.set(next);
          }),
        {
          // The expression above cannot throw; the effect's catch is `stamped`.
          onError: (e) =>
            log("error", `session facts threw sid=${sid}: ${inspect(e)}`),
        },
      );
      // The first document is stamped here, with no prior, so the box is
      // total from its first read and every field is pending until an owner
      // answers. A throw in it is a failed follow: what the follow took is
      // released, so a view that keeps failing to open leaks nothing.
      try {
        const at = instantAt(clock);
        box = observable.box<Stamped>(
          {
            line: {
              at,
              facts: assembleFacts(
                undefined,
                session,
                readings.get(),
                update(),
                at,
              ),
            },
            failure: null,
          },
          { deep: false },
        );
      } catch (e) {
        stop();
        holds.close();
        throw e;
      }
      return {
        runs: {
          declare: (callerHolds, identity) => {
            const digest = digestOf(identity);
            callerHolds.take(`facts.run:${digest}`, () => {
              runInAction(() => declaredRuns.set(digest, identity));
              declareRuns();
              return () => {
                runInAction(() => declaredRuns.delete(digest));
                declareRuns();
              };
            });
            // Declared, and not stamped yet: the follow's reaction stamps it
            // at the end of the turn this declaration runs in.
            return runLaneOver(
              identity,
              () => box.get().line.facts,
              (missing) =>
                declaredRuns.has(missing)
                  ? pendingOf("unread")
                  : failed(
                      `the run of ${whereOf(identity.read)} is not declared by this view`,
                      "read",
                    ),
            );
          },
        },
        stamped: () => box.get().line,
        failure: () => box.get().failure,
        follow: (facts, declaration) => {
          const lanes = lanesFor(facts, declaration);
          runInAction(() => declared.set({ facts, lanes }));
        },
        settle: (at) => {
          const refreshed: Refreshed = new Map();
          return {
            refreshed,
            landed: settlePayload(inputs.get(), at, refreshed),
          };
        },
        dispose: () => {
          stop();
          runHolds.close();
          holds.close();
        },
      };
    },
  };
}

// ─── The recording arm ───────────────────────────────────────────────────────

// [LAW:effects-at-boundaries] Pure over a parsed recording, never a path or a
// clock: the parser (src/facts/recording.ts) is the edge the text crosses, and
// the one checker of what a recording is — one session's, with a document to
// open on — so a follow knows the session it holds and refuses another by
// name. A document's sequence counts one follow's stamps from 1, so a sequence
// that starts again is the session followed again (a reload's successor, the
// view an idle sweep retired opened by the next request), shown where the
// live bar showed it.
//
// [LAW:one-source-of-truth] Where the replay stands is the line its walk has
// reached, the one order the recording has: every follow's document is the
// last one the walk reached, so a view the cache opens again mid-replay shows
// what the live bar showed there, not the opening document again, and a
// document stamped in the millisecond after a draw reaches the next draw, not
// that one.
//
// [LAW:no-silent-failure] A follow of a session the recording does not hold
// throws naming both: pending means not yet, and a recording never will, so an
// all-pending document for it would be an answer-shaped void.
//
// A recording starts nothing and waits on nothing, so a request's settling is
// the empty record, landed; and a follow again changes nothing, because the
// keys a request names chose nothing here.
export interface RecordingFacts extends Facts {
  // The walk reached `line`: every follow's document is it from here.
  reach(line: FactsLine): void;
}

// [LAW:no-silent-failure] A run the reached document lacks is coming only if
// a later document holds it: the walk will reach that one. Any other is a
// failure naming the run (a config edited since the recording, a source added,
// a recording across a save replayed against the file from before it), never
// a pending that will not land.
export function recordingFacts({
  session: held,
  opening,
  lines,
}: Pick<Recording, "session" | "opening"> & {
  readonly lines: readonly ReplayLine[];
}): RecordingFacts {
  const ahead = digestsAhead(opening, lines);
  const reached = observable.box<FactsLine>(opening, { deep: false });
  const runs: SourceLanes = {
    declare: (_holds, identity) =>
      runLaneOver(
        identity,
        () => reached.get().facts,
        (digest) =>
          ahead.get(reached.get())!.has(digest)
            ? pendingOf("unread")
            : failed(
                `this recording holds no run of ${whereOf(identity.read)} from here on`,
                "read",
              ),
      ),
  };
  return {
    follow(facts) {
      if (facts.sessionId !== held) {
        throw new Error(
          `this recording holds session ${JSON.stringify(held)}, not ${JSON.stringify(facts.sessionId)}`,
        );
      }
      return {
        runs,
        stamped: () => reached.get(),
        failure: () => null,
        follow: () => {},
        settle: () => ({ refreshed: new Map(), landed: Promise.resolve() }),
        dispose: () => {},
      };
    },
    reach: (line) => {
      // [LAW:no-silent-failure] The walk reaches the recording's own lines.
      if (!ahead.has(line)) {
        throw new Error(
          "the walk reached a document this recording does not hold",
        );
      }
      runInAction(() => reached.set(line));
    },
  };
}

// Each document of a recording, the opening one included, by the digests of
// the runs some document after it holds.
function digestsAhead(
  opening: FactsLine,
  lines: readonly ReplayLine[],
): ReadonlyMap<FactsLine, ReadonlySet<SourceDigest>> {
  const documents = [opening, ...lines.filter((line) => line.kind === "facts")];
  const ahead = new Map<FactsLine, ReadonlySet<SourceDigest>>();
  let later = new Set<SourceDigest>();
  for (const document of documents.reverse()) {
    ahead.set(document, later);
    later = new Set([...later, ...Object.keys(document.facts.runs)]);
  }
  return ahead;
}
