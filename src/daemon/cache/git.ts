import fs from "node:fs";
import path from "node:path";
import {
  GitService,
  gitInfoFailures,
  type GitInfo,
  type GitInfoOptions,
  type PullRequest,
} from "../../segments/git";
import { ABSENT, failed, ok, type Outcome } from "../../utils/outcome";
import { quietLogger } from "../../utils/logger";
import {
  WatcherRegistry,
  type DirTarget,
  type WatcherHandle,
  type WatchTargets,
} from "./watchers";
import { TrailingEdge } from "../../utils/trailing-edge";
import { Period, periodOf, type Every } from "../../utils/period";
import {
  answerPending,
  outcomeOf,
  pending,
  settle,
  type Readable,
} from "../../utils/reading";
import type { Holds, Release } from "../../utils/holds";

// Logger callable for cache refresh / eviction / subscriber-error events.
// Daemon passes `dlog` so these land in daemon.log at the right level for
// ops/debugging; non-daemon consumers (var-system in tests, future library use)
// take the default debug-routed logger so var-system module load never touches
// daemon log files.
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
// the repo's watch, and one period over the repos something holds. Segments
// read through getGitInfo(); var-system's `kind: "git"` variables are pushed
// each refresh through subscribe(). Both share one state per repo (keyed by
// the *effective git directory*), one watch, and one launch category ("git").
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

// Options applied to subscribe()'s value. var-system's six GitField values
// (branch, sha, dirty, ahead, behind, stash) all project from these flags —
// keep them in lockstep with the projection in src/var-system/sources.ts.
// Anything not asked for here is undefined on the snapshot delivered to
// subscribers, which makes the projection's missing-field paths reachable and
// tested.
const SUBSCRIBE_OPTIONS: GitOptions = {
  showSha: true,
  showStashCount: true,
};

// Every toggle but the PR: the PR is its own source (above), composed onto a
// read rather than fetched inside one.
type GitOptions = Omit<GitInfoOptions, "showPullRequest">;

// One option set's value in a repo. [LAW:no-ambient-temporal-coupling] A pass
// reads only the values something reads (`readers`: the homes holding it, and
// each subscription of the subscribed set), so an option set a preset stopped
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
// `holders` are the homes showing the PR: only they run its period and look a
// new key up, so a PR nothing shows calls no forge (cmt-2bc3832b). A pass
// still moves its key, so the key never answers for another branch; a new key
// nobody shows is left pending and `missed`, looked up by the hold that next
// shows it.
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
// `owed` is a new key nobody shows, looked up once something does.
type PrMove = "-" | "kept" | "recalled" | "looked-up" | "owed";

// What asked for a pass, beside the period: a watch fire, a new option set, a
// reader of a value (or a PR) a pass went by without, the first PR ask. A pass
// none of these asked for is the period's.
type PassReason = "watch" | "first" | "resume" | "pr";

// [LAW:types-are-the-program] One repo the cache knows. The watch lives as long
// as the state does — closing and reopening it per value leaked native memory
// on macOS (brandon-unfiled-3248.576q; src/daemon/cache/watchers.ts). Two uses
// keep it: `holders`, the holds homes take on it, which alone run the period —
// a read's, and a subscription's while its home is drawn; and
// `subscriptions`, the `kind: "git"` subscribers, which hear every change
// (a config's subscription lives as long as its entry, idle or not). A change
// on a repo nothing uses reads nothing; it marks every value missed, so its
// next use reads at once.
interface RepoState {
  readonly root: string;
  // [LAW:single-enforcer] The repo's one serialized refresh loop, owned by its
  // state so a state dropped mid-read and built again never queues on the old
  // one's loop. What a trigger does while a pass is running is decided by its
  // kind: a change (a watch fire, a new option set) queues exactly one more
  // pass, so the last change always lands (brandon-unfiled-3248.xjma); an ask
  // (a period tick) shares the pass in flight, which already answers it.
  readonly refresh: TrailingEdge;
  readonly watcher: WatcherHandle;
  readonly period: Period;
  readonly values: Map<string, GitValue>;
  readonly subscribers: Set<SubscribeCallback>;
  holders: number;
  subscriptions: number;
  // The reasons a pass was asked for since the last one began.
  readonly asked: Set<PassReason>;
  pr: PrSource | null;
}

function inUse(state: RepoState): boolean {
  return state.holders > 0 || state.subscriptions > 0;
}

interface ResolutionCacheEntry {
  readonly dir: Promise<Outcome<string>>;
  readonly computedAt: number;
}

// `held` counts the repos a home holds — the ones the period visits.
// `refreshes` counts the passes that read a repo (each reads every option set
// of it); `changes` the watch fires that queued one.
export interface GitCacheStats {
  size: number;
  held: number;
  hits: number;
  misses: number;
  changes: number;
  refreshes: number;
  watchers: number;
}

type SubscribeCallback = (info: GitInfo | null) => void;

// [LAW:types-are-the-program] subscribe() starts work that finishes later, so
// what it returns carries both facts about that work: how to stop listening, and
// when the first snapshot has actually landed (brandon-check-settle-dt7).
export interface GitSubscription {
  // Resolves once the first delivery is done — after gitDir resolution and the
  // first read, and equally after the single `null` delivery for a cwd that is
  // not a repo, or immediately if the caller unsubscribed before either. It is
  // the *completion* of that delivery, never a promise of the snapshot:
  // subscribers read values through the callback [LAW:one-source-of-truth].
  readonly firstDelivery: Promise<void>;
  readonly unsubscribe: () => void;
  // The subscribing home was drawn: it holds the repo (its period) again, as a
  // read does, so the home's idle sweep releases it once it is drawn no more
  // (cmt-113f8f1e item 2). Before the first delivery it holds nothing yet.
  readonly read: () => void;
}

// [LAW:single-enforcer] What one hold holds: the repo, one option set of it,
// and its PR when shown — so a home reading another closure takes a hold of its
// own, and the closure it left is released by the home's sweep alone.
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
// `refs/heads/` only exists in the main repo's gitDir, not under a worktree's
// metadata dir, so it is watched only where it is real — the `gitDir` watch on
// HEAD/index still covers branch and index changes in the worktree case.
function watcherTargets(gitDir: string): WatchTargets {
  const dirs: DirTarget[] = [{ path: gitDir, filenames: ["HEAD", "index"] }];
  const refsHeads = path.join(gitDir, "refs/heads");
  try {
    if (fs.statSync(refsHeads).isDirectory()) {
      dirs.push({ path: refsHeads });
    }
  } catch {
    // ENOENT (worktree case) or other fs error — skip the dir target.
  }
  return { files: [], dirs };
}

// The branch the repo's values last read, from whichever answered.
function branchOf(state: RepoState): string | undefined {
  for (const value of state.values.values()) {
    if (value.reading.kind === "read" && value.reading.outcome.kind === "ok") {
      return value.reading.outcome.value.branch;
    }
  }
  return undefined;
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
  // (brandon-git-cache-y2t, -y9h) — and it coalesces the burst of concurrent
  // resolutions `registerDslConfig` starts for a config's `kind: "git"`
  // variables.
  private readonly resolutions = new Map<string, ResolutionCacheEntry>();
  private hits = 0;
  private misses = 0;
  private changes = 0;
  private refreshCount = 0;
  private readonly inner: GitService;
  private readonly periodMs: number;
  private readonly maxRepos: number;
  private readonly watchers: WatcherRegistry;
  private readonly ownsWatchers: boolean;
  private readonly logger: GitProviderLogger;

  constructor(
    opts: {
      periodMs?: number;
      maxRepos?: number;
      inner?: GitService;
      watchers?: WatcherRegistry;
      // [LAW:single-enforcer] One injection point. Daemon passes `dlog`;
      // non-daemon consumers leave the default (debug-routed, quiet
      // unless CC_CANDYBAR_DEBUG is set).
      logger?: GitProviderLogger;
    } = {},
  ) {
    this.inner = opts.inner ?? new GitService();
    this.periodMs = opts.periodMs ?? GIT_PERIOD_MS;
    this.maxRepos = opts.maxRepos ?? DEFAULT_MAX_REPOS;
    this.logger = opts.logger ?? quietLogger;
    if (opts.watchers) {
      this.watchers = opts.watchers;
      this.ownsWatchers = false;
    } else {
      // Auto-constructed registry shares the same logger so daemon ops see
      // both cache and watcher events; var-system's default stays quiet.
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
      refreshes: this.refreshCount,
      watchers: this.watchers.size(),
    };
  }

  // One TTL over ALL THREE outcome kinds [LAW:one-type-per-behavior]: being
  // that stale about "is this a repo" promises nothing new. `failed` is the
  // kind that matters most: a resolution that fails by TIMEOUT costs two
  // seconds of a render, and retrying it every tick forever is the worst of
  // the three cases, not the one to leave uncached.
  resolveEffectiveGitDir(
    workingDir: string,
    projectDir?: string,
  ): Promise<Outcome<string>> {
    const key = `${workingDir}|${projectDir ?? ""}`;
    const now = Date.now();

    const existing = this.resolutions.get(key);
    if (existing && now - existing.computedAt < RESOLUTION_TTL_MS) {
      // LRU touch: the cwd being rendered every tick must survive eviction.
      this.resolutions.delete(key);
      this.resolutions.set(key, existing);
      return existing.dir;
    }

    const dir = this.inner.resolveEffectiveGitDir(workingDir, projectDir);
    this.resolutions.set(key, { dir, computedAt: now });
    // [LAW:no-silent-failure] A failed answer is logged once, by the resolution
    // that made it: it is believed for the window, so a read of it never logs
    // it again. A REJECTION is a bug in the resolver, not an answer worth
    // pinning for a window — resolveEffectiveGitDir returns outcomes by
    // construction, so drop the entry and let the next caller re-ask. The
    // rejection still reaches whoever awaited `dir`; this handler only evicts.
    void dir.then(
      (outcome) => {
        if (outcome.kind === "failed") {
          this.logger(
            "warn",
            `git resolve failed (${workingDir}): ${outcome.reason}`,
          );
        }
      },
      () => {
        if (this.resolutions.get(key)?.dir === dir) {
          this.resolutions.delete(key);
        }
      },
    );
    while (this.resolutions.size > this.maxRepos) {
      const oldest = this.resolutions.keys().next().value;
      if (oldest === undefined) break;
      this.resolutions.delete(oldest);
    }
    return dir;
  }

  // [LAW:single-enforcer] The one read. `holds` is the home reading: it holds
  // the repo from this read until the home releases its holds (idle, or
  // disposed), which is what keeps the repo on the period. A warm repo answers
  // from its stored value at once; only a value never read is awaited, and a
  // PR is composed from its own source.
  //
  // [LAW:no-silent-failure] Git logs its own failures — a refresh's by the
  // refresh, a resolution's by the resolution — so its caller logs none. A
  // read that THROWS is a bug none of those saw, logged here where it
  // surfaces; the promise never rejects.
  getGitInfo(
    holds: Holds,
    workingDir: string,
    options: GitInfoOptions = {},
    projectDir?: string,
  ): Promise<Outcome<GitInfo>> {
    return this.read(holds, workingDir, options, projectDir).catch(
      (e: unknown) => {
        this.logger("error", `git read threw: ${String(e)}`);
        return failed(`git: ${String(e)}`);
      },
    );
  }

  private async read(
    holds: Holds,
    workingDir: string,
    options: GitInfoOptions,
    projectDir: string | undefined,
  ): Promise<Outcome<GitInfo>> {
    // [LAW:one-source-of-truth] The effective gitDir is the state + watch
    // identity. An absent (not a repo) or failed resolution passes through as
    // the read's outcome.
    const resolved = await this.resolveEffectiveGitDir(workingDir, projectDir);
    if (resolved.kind !== "ok") return resolved;
    const state = this.repo(resolved.value);
    const { showPullRequest, ...gitOptions } = options;
    const { value, pr } = this.ask(
      state,
      holds,
      gitOptions,
      showPullRequest === true,
    );
    if (value.reading.kind === "pending") this.misses++;
    else this.hits++;
    const first = await outcomeOf(value);
    if (pr === null || first.kind !== "ok") return first;
    const pullRequest = await outcomeOf(pr);
    // The value as it stands once the PR has landed. A pass stores a branch's
    // values and moves the PR's key in one turn (or a pass that began before
    // the PR's first ask queues the one that will), so the two answer for the
    // same pass.
    const info = await outcomeOf(value);
    return info.kind === "ok" ? ok({ ...info.value, pullRequest }) : info;
  }

  // [LAW:dataflow-not-control-flow] Push surface for var-system. The callback
  // receives the current snapshot once (after the first read lands) and again
  // after each refresh. A subscriber keeps its repo in use — never evicted,
  // every change read — but holds no period: only a home drawing does.
  // Initial delivery is asynchronous — a consumer that needs to know when it
  // happened awaits the returned `firstDelivery` rather than counting ticks.
  //
  // [LAW:dataflow-not-control-flow] `holds` is the subscribing home's: the
  // subscription holds the repo through it as a read does, from its first
  // delivery and again each time the home is drawn (`read`), so a subscriber
  // whose home is drawn sees the working-tree edits only the period reads.
  subscribe(
    holds: Holds,
    workingDir: string,
    callback: SubscribeCallback,
  ): GitSubscription {
    let unsubscribed = false;
    let attached: { state: RepoState; release: Release } | null = null;

    const firstDelivery = (async () => {
      // The SAME resolution the read uses [LAW:one-source-of-truth]: N declared
      // git variables in a non-repo cwd are one resolution, not N.
      const resolved = await this.resolveEffectiveGitDir(workingDir);
      if (unsubscribed) return;

      if (resolved.kind !== "ok") {
        // Not in a git repo (absent) or resolution failed (logged by the
        // resolution): deliver null once. No watch, no follow-up.
        this.safeInvoke(callback, null);
        return;
      }
      const state = this.repo(resolved.value);
      state.subscriptions++;
      // The home's hold counts a reader before any pass is queued; the
      // subscription's own keeps the value read by every pass after it.
      const { value } = this.ask(state, holds, SUBSCRIBE_OPTIONS, false);
      value.readers++;
      attached = {
        state,
        release: () => {
          state.subscriptions--;
          value.readers--;
        },
      };
      const initial = await outcomeOf(value);
      if (unsubscribed) return;
      this.safeInvoke(callback, initial.kind === "ok" ? initial.value : null);
      // Joined only now, so the refresh that delivered `initial` to the others
      // does not deliver it to this one a second time.
      state.subscribers.add(callback);
    })();

    return {
      firstDelivery,
      unsubscribe: () => {
        unsubscribed = true;
        if (!attached) return;
        attached.state.subscribers.delete(callback);
        attached.release();
        attached = null;
      },
      read: () => {
        if (attached) this.ask(attached.state, holds, SUBSCRIBE_OPTIONS, false);
      },
    };
  }

  // A watch fire: the repo changed since any read in flight began.
  changed(root: string): void {
    const state = this.repos.get(root);
    if (!state) return;
    this.changes++;
    if (!inUse(state)) {
      for (const value of state.values.values()) value.missed = true;
      return;
    }
    this.changedPass(state, "watch");
  }

  private repo(root: string): RepoState {
    const existing = this.repos.get(root);
    if (existing) {
      // LRU touch: re-inserting moves the repo to the newest end.
      this.repos.delete(root);
      this.repos.set(root, existing);
      return existing;
    }
    const gitDir = this.inner.resolveGitDir(root);
    const state: RepoState = {
      root,
      refresh: new TrailingEdge(),
      watcher: this.watchers.acquire(
        `git:${root}`,
        watcherTargets(gitDir),
        () => this.changed(root),
      ),
      period: new Period(() => {
        void state.refresh.share(PASS, () => this.refreshPass(state));
      }),
      values: new Map(),
      subscribers: new Set(),
      holders: 0,
      subscriptions: 0,
      asked: new Set(),
      pr: null,
    };
    this.repos.set(root, state);
    return state;
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
  // value or a PR a pass went by without is read at once by the pass `ask`
  // queues, while this reader takes what is stored.
  private hold(
    state: RepoState,
    value: GitValue,
    pr: PrSource | null,
  ): Release {
    state.holders++;
    value.readers++;
    if (pr !== null) pr.holders++;
    if (value.missed) state.asked.add("resume");
    if (pr !== null && pr.missed) {
      pr.missed = false;
      void this.readPr(state, pr);
    }
    this.held(state);
    this.evict();
    return () => {
      state.holders--;
      value.readers--;
      if (pr !== null) pr.holders--;
      this.held(state);
    };
  }

  private held(state: RepoState): void {
    state.period.hold(state.holders > 0);
    state.pr?.period.hold(state.pr.holders > 0);
  }

  // A repo's value for one option set, created pending on its first ask.
  private valueOf(state: RepoState, options: GitOptions): GitValue {
    const key = optionsKey(options);
    const known = state.values.get(key);
    if (known !== undefined) return known;
    const value: GitValue = {
      options,
      reading: pending(),
      readers: 0,
      missed: false,
    };
    state.values.set(key, value);
    state.asked.add("first");
    return value;
  }

  // What one read asks of its repo: its option set's value and, when it shows
  // the PR, the PR source — each created pending on first ask — held by `holds`
  // before any pass is queued, so the pass sees its reader. Whatever is new or
  // missed is read by ONE pass, so a first value and the PR's first key ride
  // one pass (which reads the remote beside the values). A new one must be read
  // even if a pass is in flight that does not include it, so it queues a pass
  // rather than sharing one. A reason already in `asked` means such a pass is
  // queued, and it will see this one too.
  private ask(
    state: RepoState,
    holds: Holds,
    options: GitOptions,
    showsPr: boolean,
  ): { readonly value: GitValue; readonly pr: PrSource | null } {
    const before = state.asked.size;
    const value = this.valueOf(state, options);
    if (showsPr && state.pr === null) {
      state.pr = this.prSource(state);
      state.asked.add("pr");
    }
    const pr = showsPr ? state.pr : null;
    holds.take(holdKey(state.root, optionsKey(options), showsPr), () =>
      this.hold(state, value, pr),
    );
    if (state.asked.size > before) {
      state.refresh.run(PASS, () => this.refreshPass(state));
    }
    return { value, pr };
  }

  // One pass: read every option set of the repo and its remote, store the
  // outcomes, log each failure once, deliver to subscribers, and move the PR's
  // key — all in one turn once the reads land, so no read sees a branch's
  // values beside another branch's PR. Each pass that lands writes one refresh
  // event.
  private async pass(state: RepoState): Promise<void> {
    if (this.repos.get(state.root) !== state) return;
    const startedAt = Date.now();
    const by = state.asked.size === 0 ? "period" : [...state.asked].join(",");
    state.asked.clear();
    const values: GitValue[] = [];
    for (const value of state.values.values()) {
      if (value.readers > 0) values.push(value);
      else value.missed = true;
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
      pr === null ? null : this.remoteOf(state),
    ]);
    // Dropped or closed while the read was out: nothing of it is stored.
    if (this.repos.get(state.root) !== state) return;
    this.refreshCount++;
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
    // [LAW:no-silent-failure] Logged once, by the refresh that failed; a read
    // of the stored value never logs it again.
    for (const f of failures) {
      this.logger("warn", `git refresh failed (${state.root}): ${f}`);
    }
    this.deliver(state);
    // An `absent` repo — a removed worktree, a deleted `.git` — is stored as
    // absent like any outcome. A state has one lifetime rule: kept while in
    // use, and bounded by the LRU once nothing uses it.
    const branch = branchOf(state);
    const prMove: PrMove =
      pr !== null && remote !== null && branch !== undefined
        ? this.movePr(state, pr, branch, remote)
        : "-";
    this.logger(
      "info",
      `git refresh ${state.root} by=${by} values=${values.length} failed=${failures.size} pr=${prMove} took=${Date.now() - startedAt}ms`,
    );
  }

  private deliver(state: RepoState): void {
    const value = state.values.get(optionsKey(SUBSCRIBE_OPTIONS));
    if (value === undefined || value.reading.kind !== "read") return;
    const outcome = value.reading.outcome;
    const info = outcome.kind === "ok" ? outcome.value : null;
    // [LAW:dataflow-not-control-flow] Membership checked at call time: a
    // subscriber that unsubscribed during an earlier callback in this same
    // delivery must not receive it.
    for (const cb of [...state.subscribers]) {
      if (!state.subscribers.has(cb)) continue;
      this.safeInvoke(cb, info);
    }
  }

  // The branch's PR source, pending until the pass its first ask queues gives
  // it a key: [LAW:single-enforcer] the key moves only in a pass, beside the
  // values it pairs with.
  private prSource(state: RepoState): PrSource {
    const pr: PrSource = {
      period: new Period(() => {
        void this.readPr(state, pr);
      }),
      seen: new Map(),
      holders: 0,
      missed: false,
      key: "",
      remote: ABSENT,
      reading: pending(),
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
    if (key === pr.key) return "kept";
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
    if (pr.reading.kind === "read") pr.reading = pending();
    if (pr.holders === 0) {
      pr.missed = true;
      return "owed";
    }
    pr.missed = false;
    void this.readPr(state, pr);
    return "looked-up";
  }

  // One lookup for the PR's current key; an ask for a key already being looked
  // up shares that lookup. The forge dispatch delegates to
  // inner.resolvePullRequest — this layer is the source's lifecycle only.
  private readPr(state: RepoState, pr: PrSource): Promise<void> {
    const key = pr.key;
    if (pr.inFlight?.key === key) return pr.inFlight.done;
    const remote = pr.remote;
    const lookup: Promise<Outcome<PullRequest>> =
      remote.kind === "ok"
        ? this.inner
            .resolvePullRequest(state.root, remote.value)
            .catch(threw("PR lookup"))
        : Promise.resolve(remote.kind === "failed" ? remote : ABSENT);
    const done = lookup.then((outcome) => {
      if (pr.inFlight?.key === key) pr.inFlight = null;
      if (this.repos.get(state.root) !== state) return;
      if (outcome.kind === "failed") {
        this.logger(
          "warn",
          `git refresh failed (${state.root}): git.pr: ${outcome.reason}`,
        );
      }
      // Kept under its own key whether or not the PR has moved on since.
      const at = Date.now();
      pr.seen.delete(key);
      pr.seen.set(key, { outcome, at });
      for (const oldest of pr.seen.keys()) {
        if (pr.seen.size <= PR_KEYS_KEPT) break;
        pr.seen.delete(oldest);
      }
      if (pr.key !== key) return;
      settle(pr, outcome);
      pr.period.landed(periodOf(PR_PERIOD, outcome), at);
    });
    pr.inFlight = { key, done };
    return done;
  }

  private safeInvoke(cb: SubscribeCallback, info: GitInfo | null): void {
    try {
      cb(info);
    } catch (e) {
      this.logger(
        "warn",
        `git subscriber threw: ${(e as Error).message ?? String(e)}`,
      );
    }
  }

  private drop(state: RepoState): void {
    // [LAW:no-silent-failure] A reader waiting on a first value of a dropped
    // state is answered, never left waiting on a pass that will store nothing.
    const gone = failed(`git state dropped: ${state.root}`);
    for (const value of state.values.values()) answerPending(value, gone);
    if (state.pr !== null) answerPending(state.pr, gone);
    this.repos.delete(state.root);
    state.refresh.clear();
    state.watcher.release();
    state.period.dispose();
    state.pr?.period.dispose();
  }

  // The LRU bounds the repos nothing uses; a repo in use is never evicted, so
  // those are bounded by their users (the render cache's budget).
  private evict(): void {
    for (const state of this.repos.values()) {
      if (this.repos.size <= this.maxRepos) return;
      if (inUse(state)) continue;
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
    // In-flight resolutions resolve naturally; clearing the map means a fresh
    // provider re-asks rather than inheriting this one's answers.
    this.resolutions.clear();
    if (this.ownsWatchers) this.watchers.closeAll();
  }
}
