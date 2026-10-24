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
  currentOf,
  outcomeOf,
  pending,
  settle,
  type Current,
  type Readable,
} from "../../utils/reading";
import type { Holds, Release } from "../../utils/holds";

// Logger callable for cache refresh / eviction events.
// Daemon passes `dlog` so these land in daemon.log at the right level for
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
// the repo's watch, and one period over the repos something holds. A draw
// reads through current(), a request through getGitInfo(); both share one
// state per repo (keyed by the *effective git directory*), one watch, and one
// launch category ("git").
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
// reader of a value a pass went by without, the first PR ask or a PR key owed
// to whoever shows it next. A pass none of these asked for is the period's.
type PassReason = "watch" | "first" | "resume" | "pr";

// [LAW:types-are-the-program] One repo the cache knows. The watch lives as long
// as the state does — closing and reopening it per value leaked native memory
// on macOS (brandon-unfiled-3248.576q; src/daemon/cache/watchers.ts). Its one
// use is `holders`, the holds homes' reads take on it, which run the period and
// keep it from eviction. A change on a repo nothing holds reads nothing; it
// marks every value missed, so its next read reads at once.
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
  holders: number;
  // The reasons a pass was asked for since the last one began.
  readonly asked: Set<PassReason>;
  pr: PrSource | null;
}

interface ResolutionCacheEntry {
  readonly dir: Promise<Outcome<string>>;
  readonly computedAt: number;
  // What `dir` answered, once it has — or, until then, what the resolution it
  // replaced answered: a draw reads which repo a directory is without
  // awaiting.
  known: Outcome<string> | undefined;
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
  refreshes: number;
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
  if (pr.reading.kind === "read") pr.reading = pending();
}

// [LAW:no-silent-failure] A pass that read no branch has none to key an owed
// PR by: the PR answers what the values did, so a reader waiting on it is
// answered, and it stays owed for the next pass that reads one. A key known
// current keeps its answer, and a lookup in flight lands as it would.
function unkeyedPr(pr: PrSource, failures: ReadonlySet<string>): PrMove {
  if (pr.missed && pr.reading.kind === "pending") {
    settle(pr, failures.size > 0 ? failed([...failures].join("; ")) : ABSENT);
  }
  return "unkeyed";
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
    return this.resolution(workingDir, projectDir).dir;
  }

  private resolution(
    workingDir: string,
    projectDir: string | undefined,
  ): ResolutionCacheEntry {
    const key = `${workingDir}|${projectDir ?? ""}`;
    const now = Date.now();

    const existing = this.resolutions.get(key);
    if (existing && now - existing.computedAt < RESOLUTION_TTL_MS) {
      // LRU touch: the cwd being rendered every tick must survive eviction.
      this.resolutions.delete(key);
      this.resolutions.set(key, existing);
      return existing;
    }

    // [LAW:no-silent-failure] A THROW is a bug in the resolver, which returns
    // outcomes by construction: it is answered as the failure it is, logged
    // below and believed for the window like any other — so a reader waiting
    // on the resolution is answered, never sent to ask again. The executor
    // makes a throw before the resolver's promise a rejection too.
    const dir = new Promise<Outcome<string>>((resolve) =>
      resolve(this.inner.resolveEffectiveGitDir(workingDir, projectDir)),
    ).catch((e: unknown) => failed(`resolver threw: ${String(e)}`));
    // [LAW:one-source-of-truth] A resolution read again keeps the answer it
    // replaces until its own lands: a draw takes the stored value, so the
    // window ending is never a moment the repo is not known.
    const entry: ResolutionCacheEntry = {
      dir,
      computedAt: now,
      known: existing?.known,
    };
    this.resolutions.set(key, entry);
    // A failed answer is logged once, by the resolution that made it: it is
    // believed for the window, so a read of it never logs it again.
    void dir.then((outcome) => {
      entry.known = outcome;
      if (outcome.kind === "failed") {
        this.logger(
          "warn",
          `git resolve failed (${workingDir}): ${outcome.reason}`,
        );
      }
    });
    while (this.resolutions.size > this.maxRepos) {
      const oldest = this.resolutions.keys().next().value;
      if (oldest === undefined) break;
      this.resolutions.delete(oldest);
    }
    return entry;
  }

  // [LAW:single-enforcer] The one read: the repo's value as it stands, never
  // awaited, so a draw takes it in the turn it draws. `holds` is the home
  // reading: it holds the repo from this read until a declaration of the
  // home's takes it no more, or the home is disposed, which is what keeps the
  // repo on the period. A
  // value never read is pending, its first pass queued; a PR is composed from
  // its own source, pending on its own while its key is not answered, so the
  // rest of the value draws as it stands.
  //
  // [LAW:no-silent-failure] Git logs its own failures — a refresh's by the
  // refresh, a resolution's by the resolution — so its caller logs none. A
  // read that THROWS is a bug none of those saw, logged here where it
  // surfaces, and answered as failed.
  current(
    holds: Holds,
    workingDir: string,
    options: GitInfoOptions = {},
    projectDir?: string,
  ): Current<GitInfo> {
    const look = this.look(holds, workingDir, options, projectDir);
    return look.kind === "resolving"
      ? { kind: "pending", landed: look.dir.then(() => {}) }
      : look.value;
  }

  // The read's answer, PR included, waited for while either is not answered
  // yet: one ask, so one hold, then the sources' own landings. The promise
  // never rejects.
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

  // [LAW:single-enforcer] A home's declaration of what its draws read: the
  // hold a read of the same keys takes, its first pass queued — a read
  // nobody made, so it counts no hit or miss. A directory still resolving
  // takes no hold.
  declare(
    holds: Holds,
    workingDir: string,
    options: GitInfoOptions = {},
    projectDir?: string,
  ): void {
    this.asked(holds, workingDir, options, projectDir);
  }

  // Which repo the directory is — still resolving, or resolved and its value
  // as it stands.
  private look(
    holds: Holds,
    workingDir: string,
    options: GitInfoOptions,
    projectDir: string | undefined,
  ):
    | { readonly kind: "resolving"; readonly dir: Promise<Outcome<string>> }
    | { readonly kind: "resolved"; readonly value: Current<GitInfo> } {
    const resolved = (value: Current<GitInfo>) =>
      ({ kind: "resolved", value }) as const;
    try {
      const asked = this.asked(holds, workingDir, options, projectDir);
      if (asked.kind === "resolving") return asked;
      if (asked.kind === "not-a-repo") return resolved(asked.outcome);
      const { value, pr } = asked;
      if (value.reading.kind === "pending") this.misses++;
      else this.hits++;
      const info = currentOf(value);
      if (pr === null || info.kind !== "ok") return resolved(info);
      // A pass stores a branch's values and moves the PR's key in one turn,
      // so the two answer for the same pass.
      return resolved(ok({ ...info.value, pullRequest: currentOf(pr) }));
    } catch (e) {
      this.logger("error", `git read threw: ${String(e)}`);
      return resolved(failed(`git: ${String(e)}`));
    }
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
    | { readonly kind: "resolving"; readonly dir: Promise<Outcome<string>> }
    | { readonly kind: "not-a-repo"; readonly outcome: Current<GitInfo> }
    | {
        readonly kind: "asked";
        readonly value: GitValue;
        readonly pr: PrSource | null;
      } {
    const resolution = this.resolution(workingDir, projectDir);
    const dir = resolution.known;
    if (dir === undefined) return { kind: "resolving", dir: resolution.dir };
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

  // A watch fire: the repo changed since any read in flight began.
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
      holders: 0,
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
      if (pr.missed) state.asked.add("pr");
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
    const by = state.asked.size === 0 ? "period" : [...state.asked].join(",");
    state.asked.clear();
    const values: GitValue[] = [];
    // A value something reads, or something waits on, is read; the rest are
    // missed, read by the pass their next reader queues.
    for (const value of state.values.values()) {
      if (value.readers > 0 || value.reading.kind === "pending") {
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
    this.logger(
      "info",
      `git refresh ${state.root} by=${by} values=${values.length} failed=${failures.size} pr=${prMove} took=${Date.now() - startedAt}ms`,
    );
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
      // Its key is the first pass's to set.
      missed: true,
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
    if (pr.reading.kind === "read") pr.reading = pending();
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
    state.watcher.release();
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
    // In-flight resolutions resolve naturally; clearing the map means a fresh
    // provider re-asks rather than inheriting this one's answers.
    this.resolutions.clear();
    if (this.ownsWatchers) this.watchers.closeAll();
  }
}
