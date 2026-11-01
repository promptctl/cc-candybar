import path from "node:path";
import {
  type GitService,
  gitInfoFailures,
  type GitInfo,
  type GitInfoOptions,
  type PullRequest,
} from "../../segments/git";
import { ABSENT, failed, ok, type Outcome } from "../../utils/outcome";
import { quietLogger } from "../../utils/logger";
import { valueOf as logfmtValue } from "../../utils/logfmt";
import {
  RefreshLedger,
  type RefreshTrigger,
  type Refreshes,
} from "../../utils/refresh-ledger";
import {
  WatcherRegistry,
  type DirTarget,
  type HeldWatch,
  type WatchMove,
  type WatchSpec,
} from "./watchers";
import { boundKey, boundOf } from "../../utils/folder-identity";
import { TrailingEdge } from "../../utils/trailing-edge";
import { Period, periodOf, type Every } from "../../utils/period";
import {
  answerPending,
  currentOf,
  renew,
  settle,
  settledLane,
  unread,
  type Current,
  type Lane,
  type Readable,
} from "../../utils/reading";
import type { Holds, Release } from "../../utils/holds";

// Logger callable for cache refresh / eviction events.
// Daemon passes its log so these land in daemon.log at the right level for
// ops/debugging; a test constructing the provider alone takes the default
// debug-routed logger, which touches no daemon log file.
// [LAW:no-defensive-null-guards] Default is non-null; injection replaces
// the implementation, never adds a "no logger" mode.
export type GitProviderLogger = (
  level: "info" | "warn" | "error",
  message: string,
) => void;

// [LAW:one-source-of-truth] One provider for git data in the daemon, and the
// one owner that schedules every read of it (brandon-unfiled-3248.8ro6, step
// 1). A read never fetches a repo the cache has read before: it takes the
// value stored, and the stored value is refreshed by exactly two triggers —
// the repo's watch, and one period over the repos something holds. A home
// declares what it reads (`declare`) and reads the lane it was handed; every
// lane of a repo shares one state (keyed by the *effective git directory*),
// one watch, and one launch category ("git").
//
// [LAW:one-source-of-truth] The repo key derives from `resolveEffectiveGitDir`,
// which returns the exact directory the shell-runner will run git in (taking
// `projectDir` and worktree-ness into account). Keying off only
// `findGitRoot(workingDir)` would cache repo B's data under repo A's key
// whenever `projectDir` overrides workingDir's repo.

// The period a held repo is re-read on. It covers the working-tree edits no
// watch sees (a saved file moves no `.git` name) and the watch events a
// filesystem drops (network mounts, some FUSE volumes), which is what the old
// five-minute mtime walk backstopped; a visit refetches outright where the
// walk only compared mtimes and could not see a working-tree edit at all.
export const GIT_PERIOD_MS = 30_000;
// How long "which repo is this directory in" is believed. Not a source: an
// answer about the directory, re-asked by the first read after it expires, so
// `git init` in a directory the bar has seen is visible within one window.
const RESOLUTION_TTL_MS = 30_000;
const DEFAULT_MAX_REPOS = 64;
// The one key of a repo's own refresh loop.
const PASS = "pass";

// [LAW:decomposition] The forge PR lookup is a network resource with its own
// lifecycle: it changes ~twice in a PR's life and the watch on `.git` says
// nothing about remote PR state. So it has its OWN period, chosen by the last
// lookup's outcome — a `failed` lookup is retried sooner, so a transient forge
// outage is not pinned to the bar for the full ok-period — and its own key (the
// branch and the remote), so a branch switch or a re-pointed origin is a fresh
// lookup, never the old branch's answer.
export const PR_PERIOD: Every = { okMs: 5 * 60_000, failedMs: 45_000 };
// How many of a repo's PR keys keep their latest answer: the branches a user
// switches between, each answered from its own last lookup on the way back.
const PR_KEYS_KEPT = 16;

// Every toggle but the PR: the PR is its own source (above), composed onto a
// read rather than fetched inside one.
type GitOptions = Omit<GitInfoOptions, "showPullRequest">;

// One option set's value in a repo. [LAW:no-ambient-temporal-coupling] A pass
// reads only the values something reads (`readers`: the homes holding it), so an option set a preset stopped
// placing stops costing its reads; `missed` says a pass, or a change on a repo
// nobody used, went by without it, so its next reader reads it at once while
// taking the value stored (cmt-2bc3832b, brandon-unfiled-3248.8ro6).
interface GitValue extends Readable<GitInfo> {
  readonly options: GitOptions;
  readers: number;
  missed: boolean;
}

// The branch's PR. `key` is the branch and remote the reading answers for
// ("" until the first pass moves it), moved only by a git pass, which reads
// the remote beside the values it pairs with. `seen` keeps the latest answer
// of each key looked up, so a branch switched back to is answered from its
// own key's last lookup — never another key's — and its period resumes where
// that lookup left off.
// `holders` are the homes showing the PR: only they run its period, read the
// remote and look a key up, so a PR nothing shows calls no forge and spawns no
// `git remote` (cmt-2bc3832b) — while every pass still keys it, by the branch it
// read and the remote last read, so a key nobody shows stays the branch's.
// `missed` says the key is not known to answer what its reader reads: a key
// that moved while nobody showed it, or one a hold reads beside a value a pass
// went by without. It is pending, its period stopped, and a lookup landing then
// is kept in `seen` alone, so it never answers for another branch; the pass the
// hold queues keys it beside that value, from `seen` when the key did not move.
interface PrSource extends Readable<PullRequest> {
  readonly period: Period;
  readonly seen: Map<string, PrAnswer>;
  holders: number;
  missed: boolean;
  key: string;
  remote: Outcome<string>;
  inFlight: { readonly key: string; readonly done: Promise<void> } | null;
}

interface PrAnswer {
  readonly outcome: Outcome<PullRequest>;
  readonly at: number;
}

// What a pass did to the PR's key, for its refresh event: no PR source, the
// same key, a key answered from its own last lookup, or a key looked up.
// `owed` is a key nobody shows, keyed once something does; `unkeyed` a pass
// that read no branch to key it by.
type PrMove = "-" | "kept" | "recalled" | "looked-up" | "owed" | "unkeyed";

// What asked for a pass, beside the period: a watch fire, a new option set, a
// reader of a value a pass went by without, the first PR ask, or a hold's
// return to a PR whose key is owed. A pass none of these asked for is the
// period's.
type PassReason = "watch" | "first" | "resume" | "pr" | "owed";

// [LAW:one-source-of-truth] A pass's trigger in the ledger's vocabulary: a
// first value asked for (a new option set, a PR's first key) makes it a first
// read, else a watch or a hold's return makes it a change, else its period
// started it. Which reasons it answered stay on its event (`asked=`).
function triggerOf(
  asked: readonly PassReason[],
): Extract<RefreshTrigger, "first" | "period" | "change"> {
  if (asked.includes("first") || asked.includes("pr")) return "first";
  return asked.length === 0 ? "period" : "change";
}

// [LAW:types-are-the-program] One repo the cache knows. The watch lives as long
// as the state and the directories it bound do — closing and reopening it per
// value leaked native memory on macOS (brandon-unfiled-3248.576q;
// src/daemon/cache/watchers.ts), and a pass rebinds it only when its paths
// name other directories. Its one use is `holders`, the holds homes' reads
// take on it, which run the period and keep it from eviction. A change on a
// repo nothing holds reads nothing; it marks every value missed, so its next
// read reads at once.
interface RepoState {
  readonly root: string;
  // [LAW:single-enforcer] The repo's one serialized refresh loop, owned by its
  // state so a state dropped mid-read and built again never queues on the old
  // one's loop. What a trigger does while a pass is running is decided by its
  // kind: a change (a watch fire, a new option set) queues exactly one more
  // pass, so the last change always lands (brandon-unfiled-3248.xjma); an ask
  // (a period tick) shares the pass in flight, which already answers it.
  readonly refresh: TrailingEdge;
  // The watch the registry holds for the repo, under the key `watchSpec`
  // derived when it was bound.
  watch: HeldWatch;
  readonly period: Period;
  readonly values: Map<string, GitValue>;
  holders: number;
  // The reasons a pass was asked for since the last one began.
  readonly asked: Set<PassReason>;
  pr: PrSource | null;
}

interface ResolutionCacheEntry {
  readonly known: Outcome<string>;
  readonly computedAt: number;
}

// `held` counts the repos a home holds — the ones the period visits.
// `refreshes` counts the passes that read a repo (each reads the option sets
// something reads); `changes` the watch fires that queued one.
export interface GitCacheStats {
  size: number;
  held: number;
  hits: number;
  misses: number;
  changes: number;
  watchers: number;
}

// [LAW:single-enforcer] What one hold holds: the repo, one option set of it,
// and its PR when shown — so a home reading another closure takes a hold of its
// own, and the closure it left is released by the home's next declaration.
function holdKey(root: string, value: string, showsPr: boolean): string {
  return `git:${root}|${value}|${showsPr ? "pr" : "-"}`;
}

function optionsKey(options: GitOptions): string {
  const keys = Object.keys(options).sort() as Array<keyof GitOptions>;
  const normalized: Record<string, unknown> = {};
  for (const k of keys) normalized[k as string] = options[k];
  return JSON.stringify(normalized);
}

// `gitDir` must be the *resolved* git directory (the value
// `GitService.resolveGitDir(repoRoot)` returns). For a normal repo that's
// `<repoRoot>/.git`; for a worktree it's the worktree-metadata dir nested
// under the main repo's `.git/worktrees/`. Either way, `HEAD` and `index`
// live directly inside `gitDir`.
//
// They are watched as NAMES in `gitDir`, never as files: git replaces both by
// renaming a `.lock` file over them, and a watch on the file follows the inode
// git just unlinked — it fires once and never again (measured, macOS).
//
// `commonDir` is the git directory the refs live in (`resolveCommonGitDir`):
// the gitDir itself for a main checkout, the main repo's for a linked
// worktree, whose own metadata dir holds no refs at all. The branch refs are
// watched as a tree, because a branch name's slashes are directories
// (`refs/heads/fix/thing`) and a watch one level deep never hears a ref move
// below them. A ref-only move — `reset --soft`, `update-ref`, an amend with
// nothing staged — rewrites nothing but its ref.
//
// The tree is `refs/heads`, not `refs`: on Linux a recursive watch is Node's
// own walk, one inotify watch and one stat per entry and a re-read of a
// directory on every event in it, so its cost is the tree's size. Local
// branches are tens to hundreds; remote refs and tags are the remote's to
// grow, and a fetch rewriting thousands of them would re-walk the directory
// per ref. Those still reach the bar on the period.
// [LAW:dataflow-not-control-flow] One shape for both layouts: the stat of
// each directory names it for the key and decides nothing, and the stat
// cannot throw. A tree that cannot be opened is a refusal the registry logs
// and counts, and the period is what refreshes a repo whose watch is refused.
//
// A directory watch binds the inode at its path when it opens, not the path:
// a git directory deleted and recreated at its path (`worktree remove` then
// `worktree add` of the same name, `rm -rf` then a re-clone) is a new
// directory the old watch never hears (Linux; FSEvents follows paths). So the
// spec's key names what the watch binds — each target's path and the identity
// of the directory there now — and the registry's `follow` rebinds on a new
// key. Every pass derives the spec again, so a recreated repo is heard within
// one period, and a layout change at the same path (a clone replaced by a
// worktree) is the same case.
function watchSpec(root: string, gitDir: string, commonDir: string): WatchSpec {
  const dirs: DirTarget[] = [
    { path: gitDir, filenames: ["HEAD", "index"] },
    { path: path.join(commonDir, "refs", "heads"), recursive: true },
  ];
  const bounds = dirs.map((d) => boundOf(d.path));
  const named = dirs.map((d, i) => `${d.path}@${boundKey(bounds[i]!)}`);
  return {
    key: `git:${root}:${named.join("|")}`,
    targets: { dirs },
    unbound: bounds.some((b) => typeof b === "string" || "unreadable" in b),
  };
}

// [LAW:one-source-of-truth] The branch one pass read, from whichever of its
// reads answered — never a value the pass skipped, whose stored branch may be
// one the repo has since left.
function branchOf(
  outcomes: ReadonlyArray<Outcome<GitInfo>>,
): string | undefined {
  return outcomes.find((outcome) => outcome.kind === "ok")?.value.branch;
}

// The PR's key is not known to be the branch's now (`PrSource.missed`).
function owe(pr: PrSource): void {
  pr.missed = true;
  renew(pr, "unread");
}

// [LAW:no-silent-failure] A pass that read no branch has none to key an owed
// PR by: the PR answers what the values did, so a reader waiting on it is
// answered, and it stays owed for the next pass that reads one. A key known
// current keeps its answer, and a lookup in flight lands as it would.
function unkeyedPr(pr: PrSource, failures: ReadonlySet<string>): PrMove {
  if (pr.missed && pr.reading.get().kind === "pending") {
    settle(pr, failures.size > 0 ? failed([...failures].join("; ")) : ABSENT);
  }
  return "unkeyed";
}

// A lane's read: the value as it stands, with its PR when shown. A pass
// stores a branch's values and moves the PR's key in one turn, so the two
// answer for the same pass.
function composed(value: GitValue, pr: PrSource | null): Current<GitInfo> {
  const info = currentOf(value);
  if (pr === null || info.kind !== "ok") return info;
  return ok({ ...info.value, pullRequest: currentOf(pr) });
}

function threw(label: string): (e: unknown) => Outcome<never> {
  return (e) => failed(`${label} threw: ${String(e)}`);
}

export class GitDataProvider {
  private readonly repos = new Map<string, RepoState>();
  // [LAW:one-source-of-truth] The gitDir-resolution cache, keyed by the two
  // inputs resolution reads — `workingDir|projectDir`. It answers WHICH repo
  // (if any) a directory belongs to, which `repos` cannot: a state exists only
  // once something asks for its repo. Untracked, the question is re-asked on
  // every render — a walk to the filesystem root outside a repo
  // (brandon-git-cache-y2t, -y9h) — and it coalesces concurrent resolutions
  // of one directory into one.
  private readonly resolutions = new Map<string, ResolutionCacheEntry>();
  private hits = 0;
  private misses = 0;
  private changes = 0;
  private readonly gitRefreshes: Refreshes<"first" | "period" | "change">;
  private readonly prRefreshes: Refreshes<"first" | "period">;
  private readonly inner: GitService;
  private readonly periodMs: number;
  private readonly maxRepos: number;
  private readonly watchers: WatcherRegistry;
  private readonly ownsWatchers: boolean;
  private readonly logger: GitProviderLogger;

  constructor(opts: {
    periodMs?: number;
    maxRepos?: number;
    inner: GitService;
    watchers?: WatcherRegistry;
    // [LAW:single-enforcer] One injection point. Daemon passes its log;
    // non-daemon consumers leave the default (debug-routed, quiet
    // unless CC_CANDYBAR_DEBUG is set).
    logger?: GitProviderLogger;
    ledger?: RefreshLedger;
  }) {
    this.inner = opts.inner;
    this.periodMs = opts.periodMs ?? GIT_PERIOD_MS;
    this.maxRepos = opts.maxRepos ?? DEFAULT_MAX_REPOS;
    this.logger = opts.logger ?? quietLogger;
    const ledger = opts.ledger ?? new RefreshLedger(this.logger);
    this.gitRefreshes = ledger.declare({
      name: "git",
      scope: "repo",
      refresh: ["first", "period", "change"],
    });
    this.prRefreshes = ledger.declare({
      name: "pr",
      scope: "repo",
      refresh: ["first", "period"],
    });
    if (opts.watchers) {
      this.watchers = opts.watchers;
      this.ownsWatchers = false;
    } else {
      // Auto-constructed registry shares the same logger, so cache and watcher
      // events land together; with the default logger both stay quiet.
      this.watchers = new WatcherRegistry({ logger: this.logger });
      this.ownsWatchers = true;
    }
  }

  getWatcherRegistry(): WatcherRegistry {
    return this.watchers;
  }

  getStats(): GitCacheStats {
    let held = 0;
    for (const state of this.repos.values()) if (state.holders > 0) held++;
    return {
      size: this.repos.size,
      held,
      hits: this.hits,
      misses: this.misses,
      changes: this.changes,
      watchers: this.watchers.size(),
    };
  }

  // One TTL over ALL THREE outcome kinds [LAW:one-type-per-behavior]: being
  // that stale about "is this a repo" promises nothing new. The walk is
  // synchronous fs (`GitService.resolveEffectiveGitDir`), so a declaration
  // knows its repo in the turn it asks and takes its hold then; the window
  // bounds the walk to one per directory per window (brandon-git-cache-y2t),
  // and only a declaration consults it — a draw reads the lane it was handed
  // and never resolves.
  private resolution(
    workingDir: string,
    projectDir: string | undefined,
  ): Outcome<string> {
    const key = `${workingDir}|${projectDir ?? ""}`;
    const now = Date.now();

    const existing = this.resolutions.get(key);
    if (existing && now - existing.computedAt < RESOLUTION_TTL_MS) {
      // LRU touch: the cwd being rendered every tick must survive eviction.
      this.resolutions.delete(key);
      this.resolutions.set(key, existing);
      return existing.known;
    }

    // [LAW:no-silent-failure] A THROW is a bug in the resolver, which returns
    // outcomes by construction: it is answered as the failure it is, logged
    // below and believed for the window like any other.
    let known: Outcome<string>;
    try {
      known = this.inner.resolveEffectiveGitDir(workingDir, projectDir);
    } catch (e) {
      known = failed(`resolver threw: ${String(e)}`);
    }
    this.resolutions.set(key, { known, computedAt: now });
    // A failed answer is logged once, by the resolution that made it: it is
    // believed for the window, so a declaration of it never logs it again.
    if (known.kind === "failed") {
      this.logger(
        "warn",
        `git resolve failed (${workingDir}): ${known.reason}`,
      );
    }
    while (this.resolutions.size > this.maxRepos) {
      const oldest = this.resolutions.keys().next().value;
      if (oldest === undefined) break;
      this.resolutions.delete(oldest);
    }
    return known;
  }

  // [LAW:single-enforcer] The one way into a repo: a home's declaration of
  // what its draws read. `holds` takes the repo, the option set and, when
  // shown, its PR — held until a declaration of the home's takes them no
  // more, or the home is disposed, which is what keeps the repo on the
  // period — and the lane reads them as they stand, never awaited and taking
  // nothing. A value never read is pending, its first pass queued; a PR is
  // composed from its own source, pending on its own while its key is not
  // answered, so the rest of the value draws as it stands.
  //
  // [LAW:no-silent-failure] Git logs its own failures — a refresh's by the
  // refresh, a resolution's by the resolution — so its caller logs none. A
  // declaration that THROWS is a bug none of those saw, reported by the view's
  // declaration (declareLanes).
  declare(
    holds: Holds,
    workingDir: string,
    options: GitInfoOptions = {},
    projectDir?: string,
  ): Lane<GitInfo> {
    const asked = this.asked(holds, workingDir, options, projectDir);
    if (asked.kind === "not-a-repo") return settledLane(asked.outcome);
    const { value, pr } = asked;
    // A declaration finding the value stored is a hit; one that must wait
    // for its first read is a miss. A lane's reads count nothing: a frame
    // reads at its own rate.
    if (value.reading.get().kind === "pending") this.misses++;
    else this.hits++;
    return { current: () => composed(value, pr) };
  }

  // [LAW:one-source-of-truth] The one place a home asks a repo by directory:
  // the effective gitDir is the state + watch identity, and an absent (not a
  // repo) or failed resolution is the answer.
  private asked(
    holds: Holds,
    workingDir: string,
    options: GitInfoOptions,
    projectDir: string | undefined,
  ):
    | { readonly kind: "not-a-repo"; readonly outcome: Outcome<never> }
    | {
        readonly kind: "asked";
        readonly value: GitValue;
        readonly pr: PrSource | null;
      } {
    const dir = this.resolution(workingDir, projectDir);
    if (dir.kind !== "ok") return { kind: "not-a-repo", outcome: dir };
    const { showPullRequest, ...gitOptions } = options;
    return {
      kind: "asked",
      ...this.ask(
        this.repo(dir.value),
        holds,
        gitOptions,
        showPullRequest === true,
      ),
    };
  }

  // A watch's window, whatever it says: the repo changed since any read in
  // flight began.
  changed(root: string): void {
    const state = this.repos.get(root);
    if (!state) return;
    this.changes++;
    if (state.holders === 0) {
      for (const value of state.values.values()) value.missed = true;
      return;
    }
    this.changedPass(state, "watch");
  }

  // LRU touch: re-inserting moves the repo to the newest end. A state the
  // cache has dropped is not put back.
  private touch(state: RepoState): void {
    if (this.repos.get(state.root) !== state) return;
    this.repos.delete(state.root);
    this.repos.set(state.root, state);
  }

  private repo(root: string): RepoState {
    const existing = this.repos.get(root);
    if (existing) {
      this.touch(existing);
      return existing;
    }
    const state: RepoState = {
      root,
      refresh: new TrailingEdge(),
      watch: this.followWatch(root, null).watch,
      period: new Period(() => {
        void state.refresh.share(PASS, () => this.refreshPass(state));
      }),
      values: new Map(),
      holders: 0,
      asked: new Set(),
      pr: null,
    };
    this.repos.set(root, state);
    return state;
  }

  // [LAW:one-source-of-truth] The one derivation of a repo's watch, for the
  // state's build and for every pass: the git directories resolved from the
  // root as they stand now, followed by the registry's one rule. A pass calls
  // it first, before any await, so the watch follows the repo's paths.
  private followWatch(
    root: string,
    held: HeldWatch | null,
  ): { readonly watch: HeldWatch; readonly move: WatchMove } {
    const gitDir = this.inner.resolveGitDir(root);
    const spec = watchSpec(
      root,
      gitDir,
      this.inner.resolveCommonGitDir(gitDir),
    );
    // A pass between a worktree's removal and its re-add keeps the watch it
    // holds (`follow`), and the period rebinds once the path names a
    // directory again. The build holds nothing, and a slot the OS refused is
    // the registry's period to retry.
    const followed = this.watchers.follow(held, spec, () => this.changed(root));
    // [LAW:nothing-unseen] A rebind is the fact that the directories moved,
    // and which the repo hears now: a change that fires nothing is read
    // against this line, as the config cache's bind line.
    if (followed.move === "rebound") {
      this.logger(
        "info",
        `git watch bound root=${root} dirs=${spec.targets.dirs.map((d) => d.path).join(",")} deaf=${followed.watch.handle.deaf.length}`,
      );
    }
    return followed;
  }

  private changedPass(state: RepoState, reason: PassReason): void {
    state.asked.add(reason);
    state.refresh.run(PASS, () => this.refreshPass(state));
  }

  // The loop's work. Nobody awaits it — a watch fire or a tick starts it — so
  // [LAW:no-silent-failure] a throw is logged here as the bug it is, never an
  // unhandled rejection. [LAW:no-ambient-temporal-coupling] The period lands
  // when the pass ENDS, after its every await, so a tick that shares a running
  // pass is always followed by the landing that schedules the next one.
  private async refreshPass(state: RepoState): Promise<void> {
    try {
      await this.pass(state);
    } catch (e) {
      this.logger("error", `git refresh threw (${state.root}): ${String(e)}`);
    } finally {
      state.period.landed(this.periodMs);
    }
  }

  // One hold of a home: the repo, the value it reads and the PR it shows. A
  // value or a PR key a pass went by without is read by the pass `ask` queues,
  // while this reader takes what is stored. [LAW:one-source-of-truth] A PR read
  // beside a value a pass went by without would answer the branch the latest
  // pass read, not the one that value holds, so it is owed: the reader waits
  // for the pass that reads the value and keys the PR in one turn
  // ([LAW:single-enforcer] `movePr`).
  private hold(
    state: RepoState,
    value: GitValue,
    pr: PrSource | null,
  ): Release {
    state.holders++;
    if (pr !== null) {
      pr.holders++;
      if (value.missed) owe(pr);
      if (pr.missed) state.asked.add("owed");
    }
    // A value a pass went by without is read by the next.
    value.readers++;
    if (value.missed) state.asked.add("resume");
    this.held(state);
    this.evict();
    return () => {
      state.holders--;
      value.readers--;
      if (pr !== null) pr.holders--;
      this.held(state);
    };
  }

  // Whatever an ask added to `asked` is read by ONE pass, queued once it is all
  // in place. A new one must be read even if a pass is in flight that does not
  // include it, so it queues a pass rather than sharing one; a reason already
  // in `asked` means such a pass is queued, and it will see this one too.
  private queue(state: RepoState, before: number): void {
    if (state.asked.size > before) {
      state.refresh.run(PASS, () => this.refreshPass(state));
    }
  }

  private held(state: RepoState): void {
    state.period.hold(state.holders > 0);
    state.pr?.period.hold(state.pr.holders > 0 && !state.pr.missed);
  }

  // A repo's value for one option set, created pending on its first ask.
  private valueOf(
    state: RepoState,
    key: string,
    options: GitOptions,
  ): GitValue {
    const known = state.values.get(key);
    if (known !== undefined) return known;
    const value: GitValue = {
      options,
      reading: unread(),
      readers: 0,
      missed: false,
    };
    state.values.set(key, value);
    state.asked.add("first");
    return value;
  }

  // What one read asks of its repo: its option set's value and, when it shows
  // the PR, the PR source — each created pending on first ask — held by `holds`
  // before any pass is queued, so the pass sees its reader, and a first value
  // and the PR's first key ride one pass (which reads the remote beside the
  // values).
  private ask(
    state: RepoState,
    holds: Holds,
    options: GitOptions,
    showsPr: boolean,
  ): { readonly value: GitValue; readonly pr: PrSource | null } {
    const before = state.asked.size;
    const key = optionsKey(options);
    const value = this.valueOf(state, key, options);
    if (showsPr && state.pr === null) {
      state.pr = this.prSource(state);
      state.asked.add("pr");
    }
    const pr = showsPr ? state.pr : null;
    holds.take(holdKey(state.root, key, showsPr), () =>
      this.hold(state, value, pr),
    );
    this.queue(state, before);
    return { value, pr };
  }

  // One pass: read every option set something reads and, for a PR something
  // shows, the remote beside the branch they read; store the outcomes, log
  // each failure once, and move the PR's key — all in
  // one turn once the reads land, so no read sees a branch's values beside
  // another branch's PR. Each pass that lands writes one refresh event.
  private async pass(state: RepoState): Promise<void> {
    if (this.repos.get(state.root) !== state) return;
    const startedAt = Date.now();
    const asked = [...state.asked];
    state.asked.clear();
    const followed = this.followWatch(state.root, state.watch);
    state.watch = followed.watch;
    const values: GitValue[] = [];
    // A value something reads, or something waits on, is read; the rest are
    // missed, read by the pass their next reader queues.
    for (const value of state.values.values()) {
      if (value.readers > 0 || value.reading.get().kind === "pending") {
        values.push(value);
      } else value.missed = true;
    }
    const pr = state.pr;
    const [outcomes, remote] = await Promise.all([
      Promise.all(
        values.map((value) =>
          this.inner
            .getGitInfo(state.root, value.options)
            .catch(threw("git fetch")),
        ),
      ),
      pr !== null && pr.holders > 0 ? this.remoteOf(state) : null,
    ]);
    // Dropped or closed while the read was out: nothing of it is stored.
    if (this.repos.get(state.root) !== state) return;
    const failures = new Set<string>();
    values.forEach((value, i) => {
      const outcome = outcomes[i]!;
      value.missed = false;
      settle(value, outcome);
      if (outcome.kind === "failed") failures.add(outcome.reason);
      if (outcome.kind === "ok") {
        for (const f of gitInfoFailures(outcome.value)) failures.add(f);
      }
    });
    // An `absent` repo — a removed worktree, a deleted `.git` — is stored as
    // absent like any outcome. A state has one lifetime rule: kept while in
    // use, and bounded by the LRU once nothing uses it.
    const branch = branchOf(outcomes);
    // A pass reading no value moves no PR; an unshown PR is keyed by the remote
    // last read.
    const prMove: PrMove =
      pr === null || values.length === 0
        ? "-"
        : branch === undefined
          ? unkeyedPr(pr, failures)
          : this.movePr(state, pr, branch, remote ?? pr.remote);
    this.held(state);
    // [LAW:no-silent-failure] Logged once, by the refresh that failed, every
    // reason it met on the one event; a read of the stored value never logs
    // it again.
    this.gitRefreshes.recorded(
      `${state.root} asked=${asked.join(",") || "-"} values=${values.length} pr=${prMove} watch=${followed.move}`,
      triggerOf(asked),
      failures.size === 0 ? ok(null) : failed([...failures].join("; ")),
      Date.now() - startedAt,
    );
  }

  // The branch's PR source, pending until the pass its first ask queues gives
  // it a key: [LAW:single-enforcer] the key moves only in a pass, beside the
  // values it pairs with.
  private prSource(state: RepoState): PrSource {
    const pr: PrSource = {
      period: new Period(() => {
        void this.readPr(state, pr, "period");
      }),
      seen: new Map(),
      holders: 0,
      // Its key is the first pass's to set.
      missed: true,
      key: "",
      remote: ABSENT,
      reading: unread(),
      inFlight: null,
    };
    return pr;
  }

  // [LAW:no-silent-failure] A `failed` remote read (git couldn't run) is the
  // PR's failure; only `absent` (no remote configured) means "no forge PR".
  private remoteOf(state: RepoState): Promise<Outcome<string>> {
    return this.inner.getRepoRemoteUrl(state.root).catch(threw("git remote"));
  }

  // [LAW:one-source-of-truth] The PR's key is every input its value depends on
  // — the branch and the remote — so a branch switch or a re-pointed origin is
  // a new key: its reading is pending until the new lookup lands, and an old
  // key's answer is never stored for a new one. The same key is left to its
  // own period. [LAW:decomposition] The lookup is the PR source's own work,
  // started here and never awaited by a git pass, so a slow forge never holds
  // back the next local refresh.
  private movePr(
    state: RepoState,
    pr: PrSource,
    branch: string,
    remote: Outcome<string>,
  ): PrMove {
    const key = `${branch}|${remote.kind === "ok" ? remote.value : remote.kind}`;
    if (key === pr.key && !pr.missed) return "kept";
    pr.key = key;
    pr.remote = remote;
    const known = pr.seen.get(key);
    if (known !== undefined) {
      pr.seen.delete(key);
      pr.seen.set(key, known);
      pr.missed = false;
      settle(pr, known.outcome);
      pr.period.landed(periodOf(PR_PERIOD, known.outcome), known.at);
      return "recalled";
    }
    if (pr.holders === 0) {
      owe(pr);
      return "owed";
    }
    renew(pr, "unread");
    pr.missed = false;
    void this.readPr(state, pr, "first");
    return "looked-up";
  }

  // One lookup for the PR's current key; an ask for a key already being looked
  // up shares that lookup. The forge dispatch delegates to
  // inner.resolvePullRequest — this layer is the source's lifecycle only.
  private readPr(
    state: RepoState,
    pr: PrSource,
    by: "first" | "period",
  ): Promise<void> {
    const key = pr.key;
    if (pr.inFlight?.key === key) return pr.inFlight.done;
    const remote = pr.remote;
    const startedAt = Date.now();
    const lookup: Promise<Outcome<PullRequest>> =
      remote.kind === "ok"
        ? this.inner
            .resolvePullRequest(state.root, remote.value)
            .catch(threw("PR lookup"))
        : Promise.resolve(remote.kind === "failed" ? remote : ABSENT);
    const done = lookup.then((outcome) => {
      if (pr.inFlight?.key === key) pr.inFlight = null;
      if (this.repos.get(state.root) !== state) return;
      this.prRefreshes.recorded(
        `${state.root} key=${logfmtValue(key)}`,
        by,
        outcome,
        Date.now() - startedAt,
      );
      // Kept under its own key whether or not the PR has moved on since.
      const at = Date.now();
      pr.seen.delete(key);
      pr.seen.set(key, { outcome, at });
      for (const oldest of pr.seen.keys()) {
        if (pr.seen.size <= PR_KEYS_KEPT) break;
        pr.seen.delete(oldest);
      }
      if (pr.key !== key || pr.missed) return;
      settle(pr, outcome);
      pr.period.landed(periodOf(PR_PERIOD, outcome), at);
    });
    pr.inFlight = { key, done };
    return done;
  }

  private drop(state: RepoState): void {
    // [LAW:no-silent-failure] A reader waiting on a first value of a dropped
    // state is answered, never left waiting on a pass that will store nothing.
    const gone = failed(`git state dropped: ${state.root}`);
    for (const value of state.values.values()) answerPending(value, gone);
    if (state.pr !== null) answerPending(state.pr, gone);
    this.repos.delete(state.root);
    state.refresh.clear();
    state.watch.handle.release();
    state.period.dispose();
    state.pr?.period.dispose();
  }

  // The LRU bounds the repos nothing holds; a held repo is never evicted, so
  // those are bounded by their holders (the render cache's budget).
  private evict(): void {
    for (const state of this.repos.values()) {
      if (this.repos.size <= this.maxRepos) return;
      if (state.holders > 0) continue;
      this.drop(state);
      this.logger("info", `gitCache evict ${state.root}`);
    }
  }

  close(): void {
    // In-flight passes still resolve (an await on inner.getGitInfo cannot be
    // cancelled) but find their state gone and store nothing; no queued pass is
    // honoured after this (drop clears each loop).
    for (const state of this.repos.values()) this.drop(state);
    this.repos.clear();
    this.resolutions.clear();
    if (this.ownsWatchers) this.watchers.closeAll();
  }
}
