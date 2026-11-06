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
import type { FactsLine } from "../facts/recording";
import type { UpdateNotice } from "../facts/session-facts";
import type { Timekeeper } from "../time";
import { Holds } from "../utils/holds";
import { instantAt, type Instant } from "../utils/instant";
import type { DaemonLogger } from "../utils/logger";
import { assembleFacts } from "./facts-assembly";
import type { PayloadProviders } from "./payload-providers";
import {
  declareLanes,
  readingsOf,
  settlePayload,
  type DeclaredLanes,
  type DeclaredSources,
  type PayloadInputs,
  type Readings,
  type Refreshed,
  type ViewFacts,
} from "./render-payload";
import type { SessionId } from "./session-id";

// What a view declares of a session beyond the request it draws by: the
// payload paths its preset reads, and the plugin sources its config declares
// at the storage keys the state's build took for them.
export interface FollowDeclaration {
  readonly closure: ReadonlySet<string>;
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
  // hints or another directory, a preset placing other segments. Synchronous,
  // in the caller's own turn, so a frame drawn in that turn draws the view
  // declared for it.
  follow(facts: ViewFacts, declaration: FollowDeclaration): void;
  // What a request arriving at `at` starts of the facts. `at` is the request's
  // instant, so what is sampled at it (tok/s) and what is drawn at it read one
  // clock reading.
  settle(at: Instant): Settling;
  // The follow's holds, timers and reactions go. A view disposed without it
  // leaks every hold its declaration took.
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
}

// What a follow holds of its declaration: the request, what it declares, and
// the lanes that declaration took — one record, written whole by each
// declaration, so a reader never joins one declaration's request to another's
// lanes.
interface Declared {
  readonly facts: ViewFacts;
  readonly declaration: FollowDeclaration;
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

// [LAW:one-source-of-truth] A stamp that fails for the reason it already
// failed for is that stamp: a fault that persists must not mint a new value
// per owner landing, which would wake every view and log again for a bar that
// has not changed.
const failedWith = (prior: Stamped, reason: string): Stamped =>
  prior.failure === reason ? prior : { ...prior, failure: reason };

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
}: InProcessFactsDeps): Facts {
  const { clock, log } = providers;
  return {
    follow(facts, declaration) {
      const session = facts.sessionId;
      const holds = new Holds();
      const sid = JSON.stringify(session);
      // [LAW:no-silent-failure] A declaration that throws is logged here,
      // where it runs — a reaction's tracked expression that throws reaches
      // only the console MobX prints to, which nobody reads in a detached
      // daemon. It keeps the holds it had, and its lanes answer its failure,
      // naming the cause.
      const lanesFor = (
        facts: ViewFacts,
        { closure, sources }: FollowDeclaration,
      ): DeclaredLanes => {
        // A lane whose owner throws is a fault the declaration answers on
        // that lane (declareLanes); a declaration that throws whole is a bug,
        // which fails the open or the request it ran for, loudly.
        const {
          result: { lanes, faults },
          acquired,
          released,
        } = holds.declare(() =>
          declareLanes(providers, holds, facts, closure, sources),
        );
        for (const fault of faults) {
          log("error", `session view declaration threw sid=${sid} ${fault}`);
        }
        // [LAW:verifiable-goals] A declaration that moved a hold — a preset
        // click, a request naming another key — says so; one that kept what
        // the view held, every other request's, writes nothing.
        if (acquired + released > 0) {
          log(
            "info",
            `session view declared sid=${sid} acquired=${acquired} released=${released} held=${holds.size}`,
          );
        }
        return lanes;
      };
      const declared = observable.box<Declared>(
        { facts, declaration, lanes: lanesFor(facts, declaration) },
        { deep: false },
      );
      // [LAW:one-source-of-truth] What the owners are read by: the request
      // and the closure and lanes of ONE declaration, never a closure from one
      // paired with another's lanes.
      const inputs = computed((): PayloadInputs => {
        const { facts, declaration } = declared.get();
        return {
          hookData: facts.hookData,
          cwd: facts.cwd,
          hints: facts.hints,
          neededInputPaths: declaration.closure,
          // The lanes as declared now, read at each call: a settle in flight
          // waits out the lanes a follow during it took, not the ones it
          // started with.
          deps: { ...providers, lanes: () => declared.get().lanes },
        };
      });
      // What the session's owners hold now, read once per turn.
      const readings = computed(() =>
        readingsOf(inputs.get(), declared.get().declaration.sources),
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
        stamped: () => box.get().line,
        failure: () => box.get().failure,
        follow: (facts, declaration) => {
          const lanes = lanesFor(facts, declaration);
          runInAction(() => declared.set({ facts, declaration, lanes }));
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
          holds.close();
        },
      };
    },
  };
}

// ─── The recording arm ───────────────────────────────────────────────────────

// [LAW:parse-dont-validate] A recording is one session's stream in time order
// (spec §14): the lines it is built over name one session and never step back,
// checked once here, so a follow knows the session it holds and refuses
// another by name, and a line's offset from the first is its place in the
// replay.
function recordingOf(lines: readonly FactsLine[]): {
  readonly session: SessionId;
  readonly at0: Instant;
} {
  const sessions = new Set(lines.map((line) => line.facts.session));
  if (sessions.size !== 1) {
    throw new Error(
      sessions.size === 0
        ? "a recording holds one session's stream, and this one holds no line"
        : `a recording holds one session's stream, and this one names ${[...sessions].map((s) => JSON.stringify(s)).join(", ")}`,
    );
  }
  const back = lines.findIndex(
    (line, i) => i > 0 && line.at < lines[i - 1]!.at,
  );
  if (back !== -1) {
    throw new Error(
      `a recording's lines are in time order, and line ${back + 1} (at ${lines[back]!.at}) is before line ${back} (at ${lines[back - 1]!.at})`,
    );
  }
  // A document's sequence counts one follow's stamps from 1, so a sequence that
  // starts again is the session followed again: the view the idle sweep
  // retired opened by the next request, or a reload's successor. The replay
  // shows that opening document at its instant, as the live bar did. What it
  // cannot tell apart is two follows writing at once, which is the recorder's
  // to prevent.
  return { session: [...sessions][0]!, at0: lines[0]!.at };
}

// [LAW:effects-at-boundaries] Pure over typed lines and a Timekeeper, never a
// path: the parser (src/facts/recording.ts) is the edge the text crosses. A
// follow's line at any moment is the last whose offset from the first the
// handed clock has reached, and each later line lands when the clock reaches
// its offset, so under a held clock a replay runs at any speed.
//
// [LAW:no-ambient-temporal-coupling] Where the replay stands is the clock's
// position in the recording, not the instant of the follow: a view the cache
// opens again mid-replay (a reload, a request after an idle sweep) shows what
// the live bar showed at that instant, not the opening line again.
//
// [LAW:no-silent-failure] A follow of a session the recording does not hold
// throws naming both: pending means not yet, and a recording never will, so an
// all-pending document for it would be an answer-shaped void. So does a follow
// before the recording's first line, where it has no document at all.
//
// A recording starts nothing and waits on nothing, so a request's settling is
// the empty record, landed; and a follow again changes nothing, because the
// keys a request names chose nothing here.
export function recordingFacts(
  lines: readonly FactsLine[],
  clock: Pick<Timekeeper, "after" | "now">,
): Facts {
  const { session: held, at0 } = recordingOf(lines);
  // Whole milliseconds, as the clock reads them, so a line's offset and the
  // clock's position in the recording are compared in one unit.
  const msOf = (at: Instant): number => Math.round(at * 1000);
  const offsetMs = (line: FactsLine): number => msOf(line.at) - msOf(at0);
  return {
    follow(facts) {
      if (facts.sessionId !== held) {
        throw new Error(
          `this recording holds session ${JSON.stringify(held)}, not ${JSON.stringify(facts.sessionId)}`,
        );
      }
      const elapsedMs = clock.now() - msOf(at0);
      const reached = lines.filter((line) => offsetMs(line) <= elapsedMs);
      if (reached.length === 0) {
        throw new Error(
          `this recording begins at ${at0}, and the clock reads ${instantAt(clock)}`,
        );
      }
      const box = observable.box<FactsLine>(reached.at(-1)!, { deep: false });
      const timers = lines
        .filter((line) => offsetMs(line) > elapsedMs)
        .map((line) =>
          clock.after(offsetMs(line) - elapsedMs, () =>
            runInAction(() => box.set(line)),
          ),
        );
      return {
        stamped: () => box.get(),
        failure: () => null,
        follow: () => {},
        settle: () => ({ refreshed: new Map(), landed: Promise.resolve() }),
        dispose: () => {
          for (const clear of timers) clear();
        },
      };
    },
  };
}

// ─── The recorder ────────────────────────────────────────────────────────────

// [LAW:one-type-per-behavior] An arm over an arm: every follow is the
// delegate's, and each line the delegate's follow stamps is handed out as it
// is stamped, the opening one included. What the lines go to — a file, a
// test's array — is the caller's edge. Replaying them through
// `recordingFacts` under a clock started at the first line's instant draws
// what the delegate's renderer drew at each instant.
export function recordedFacts(
  facts: Facts,
  record: (line: FactsLine) => void,
  log: DaemonLogger,
): Facts {
  return {
    follow(request, declaration) {
      const followed = facts.follow(request, declaration);
      const stop = reaction(() => followed.stamped(), record, {
        fireImmediately: true,
        // [LAW:no-silent-failure] A line the edge cannot write is told to the
        // log: a reaction's effect that throws reaches only the console MobX
        // prints to, and the follow would go on stamping lines nobody kept.
        onError: (e) =>
          log(
            "error",
            `recording sid=${JSON.stringify(request.sessionId)}: ${inspect(e)}`,
          ),
      });
      return {
        ...followed,
        dispose: () => {
          stop();
          followed.dispose();
        },
      };
    },
  };
}
