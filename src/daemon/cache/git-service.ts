// The daemon's git reads: the spawns that answer a repository's status, its
// commit times and its remotes, each memoized on the fact that dates it. The
// shapes they answer in, and the status parse, are shared (src/segments/git.ts).

import fs from "node:fs";
import path from "node:path";
import type { LaunchResult, Launcher } from "../../proc/launcher";
import { ABSENT, failed, ok, orElse, type Outcome } from "../../utils/outcome";
import { debug } from "../../utils/logger";
import { FORGE_CLI } from "../../repository-cli";
import {
  commonDirOf,
  gitDirNamed,
  gitEntryAt,
  gitRootOf,
} from "../../utils/git-root";
import {
  type PullRequest,
  type GitRead,
  classify,
  detectForge,
  type GitRemote,
  REMOTES_ARGS,
  remotesOf,
  repoRemoteUrl,
  forgeRemoteUrl,
  repoNameFromUrl,
  repoWebUrl,
  classifyForgePr,
  type CoreStatus,
  parseStatusV2,
  parseGithubPr,
  parseGitlabMr,
} from "../../segments/git";

// [LAW:dataflow-not-control-flow] Lift a pure, nullable derivation onto the
// Outcome it derives from, in one total fold: a read that failed stays failed
// (its reason survives to the boundary), and a derivation that found nothing
// becomes the domain's `absent`. Callers get a derived field whose three states
// line up with the read's, without re-deciding the policy at each site.
function derived<A, B>(
  from: Outcome<A>,
  project: (value: A) => B | null,
): Outcome<B> {
  if (from.kind !== "ok") return from;
  const value = project(from.value);
  return value === null ? ABSENT : ok(value);
}

// Trim an ok stdout; an empty answer is the domain's "there is none".
function nonEmpty(o: Outcome<string>): Outcome<string> {
  if (o.kind !== "ok") return o;
  const v = o.value.trim();
  return v ? ok(v) : ABSENT;
}

// One commit timestamp is 40 bytes of key and a number, and a bar sees a handful
// of commits per session; the bound exists so a long-lived daemon walking many
// repos cannot grow this without limit, not because the entries are large.
const COMMIT_TIME_CACHE_MAX = 256;

const REMOTES_CACHE_MAX = 256;

// [LAW:types-are-the-program] A memo and the stamp that makes it valid, together:
// a remembered answer without the fact that dates it is not a cache, it is a
// guess.
interface RemotesMemo {
  readonly stamp: string;
  readonly remotes: Promise<Outcome<GitRemote[]>>;
}

// [LAW:one-source-of-truth] The config file's IDENTITY, not a spelling of a path
// to it: `dev:ino` names the file itself, so two worktrees of one repo share one
// memo even though their two routes to that file disagree textually — a linked
// worktree's `.git` pointer holds the path git wrote, which on macOS is the
// physical one (/private/var/…) where the caller's own path is logical (/var/…).
// Keying on the text gave one file two memos, which is how the second reader
// re-spawned for an answer already in hand.
//
// `stamp` is `mtimeMs:size` rather than the mtime alone: a real `git remote add`
// was measured leaving the mtime unchanged at one-second resolution while the size
// moved, and a MISSED change is the costly direction (a false one costs a single
// spawn). Both come from the one stat this already had to make.
//
// `null` means the file could not be stat'd, which is the one answer that must not
// be memoised — there is nothing to date it by.
interface ConfigIdentity {
  readonly key: string;
  readonly stamp: string;
}

function configIdentity(configPath: string): ConfigIdentity | null {
  try {
    const st = fs.statSync(configPath);
    return { key: `${st.dev}:${st.ino}`, stamp: `${st.mtimeMs}:${st.size}` };
  } catch {
    return null;
  }
}

export class GitService {
  // [LAW:locality-or-seam] Who a read's program belongs to: the daemon's, so its
  // close refuses the next read of a pass under way.
  constructor(private readonly launcher: Launcher) {}

  // [LAW:types-are-the-program] args is a string[] so the boundary type
  // forbids the only-space-free-arguments contract the prior whitespace-split
  // implementation relied on. Returns the full LaunchResult — the typed
  // termination cause `launch` already computed — so `classify` can map it to
  // an Outcome without a thrown Error flattening that information away.
  // [LAW:locality-or-seam] `protected`, not private: the per-fetch spawn COUNT
  // is a property this class is now accountable for (brandon-git-cache-y9h), and
  // the only way to assert it is to be able to see every invocation go past. A
  // counting subclass in test/git-spawn-budget.test.ts is that seam; the
  // daemon's own GitDataProvider already extends this class.
  protected async execGitAsync(
    args: readonly string[],
    options: { cwd: string; timeout: number },
  ): Promise<LaunchResult> {
    return this.launcher.launch({
      bin: "git",
      args: [...args],
      cwd: options.cwd,
      envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: options.timeout,
      category: "git",
    });
  }

  // [LAW:locality-or-seam] Public so the daemon's GitDataProvider can key its
  // cache + watcher on the *effective* git directory — the same directory the
  // shell-runner will run git commands in. Caching on `findGitRoot(workingDir)`
  // alone is wrong when `projectDir` is set and is itself a git repo: the
  // shell-runner picks `projectDir` (see `computeGitInfo`'s gitDir resolution
  // below), but a workingDir-keyed cache would store that data under a
  // different key and wire invalidation to the wrong watcher. The contract:
  // `resolveEffectiveGitDir(workingDir, projectDir)` returns exactly the
  // directory `computeGitInfo` will use as `gitDir`. Both surfaces must agree.
  resolveEffectiveGitDir(
    workingDir: string,
    projectDir?: string,
  ): Outcome<string> {
    const working = gitEntryAt(workingDir);
    if (working.kind === "failed") return working;
    // [LAW:single-enforcer] A worktree stays the execution directory even
    // when Claude Code names the repository's main checkout as its project.
    if (working.kind === "ok" && working.value.isFile()) return ok(workingDir);
    if (projectDir && projectDir !== workingDir) {
      const project = gitEntryAt(projectDir);
      if (project.kind === "ok") return ok(projectDir);
      if (project.kind === "failed") return project;
    }
    return working.kind === "ok"
      ? ok(workingDir)
      : this.findGitRoot(workingDir);
  }

  // [LAW:locality-or-seam] public so daemon-side caches can key on the
  // repoRoot they'd otherwise have to re-derive. `absent` keeps its meaning —
  // "not in a git repository", the everyday domain answer.
  //
  // [LAW:one-source-of-truth] The repo root is the nearest directory with a
  // checked .git entry. Before this, two resolvers answered one question and disagreed
  // — measured on a repo whose config sets `core.worktree = /elsewhere`:
  //
  //   cwd         git's answer   the short-circuit   the old rev-parse
  //   /repo       /elsewhere     /repo               /private/tmp/…/elsewhere
  //   /repo/sub   /elsewhere     (falls through)     /private/tmp/…/elsewhere
  //
  // so the bar rendered /repo's state while sitting in /repo and a completely
  // different tree's state one directory down. `rev-parse` also answers with the
  // PHYSICAL path where the short-circuit answers with the logical one, so ONE
  // repo could occupy two cache keys depending on which arm replied. The ascent
  // collapses both onto the rule the short-circuits already commit to: one
  // predicate, one spelling of a path.
  //
  // [LAW:effects-at-boundaries] Pure synchronous fs — the shape
  // `getOngoingOperation` and `resolveGitDir` in this same class already have —
  // so a declaration knows its repo in the turn it asks (brandon-unfiled-3248.
  // 8ro6, step 4). Observable effect: a session whose cwd is outside any repo
  // spawns no `git` at all, where before it spawned one per render forever —
  // `getGitInfo`'s `absent` is deliberately not cached, so nothing bounded it.
  //
  // Two deliberate differences from `git rev-parse --show-toplevel`, both making
  // the ascent find MORE repos rather than fewer, neither reachable without an
  // unusual configuration: `core.worktree` is not honoured (the short-circuit
  // never honoured it either), and the ascent does not stop at a filesystem
  // boundary the way git does without GIT_DISCOVERY_ACROSS_FILESYSTEM.
  // `GIT_DIR`/`GIT_WORK_TREE` are not honoured either: the launcher withholds
  // them from the daemon's children, since they describe whichever shell
  // spawned the daemon rather than the session being rendered.
  //
  findGitRoot(workingDir: string): Outcome<string> {
    return gitRootOf(workingDir);
  }

  // [LAW:one-source-of-truth] No inner cache here. The daemon-side
  // GitDataProvider (src/daemon/cache/git.ts) is the single cache. Layering
  // a per-process cache on top of an already-cached call would double the
  // invalidation surface — exactly the trap that kz8.3 collapses.
  //
  // [LAW:no-silent-failure] Never rejects: helpers return outcomes by
  // construction, and an unexpected throw (a bug) is surfaced as a `failed`
  // outcome whose reason reaches the consuming boundary's log — not a blank
  // bar, not a swallowed branch.
  async getGitInfo(
    workingDir: string,
    projectDir?: string,
  ): Promise<Outcome<GitRead>> {
    try {
      return await this.computeGitInfo(workingDir, projectDir);
    } catch (e) {
      return failed(
        `git: ${e instanceof Error ? e.message : String(e)}`,
        "read",
      );
    }
  }

  private async computeGitInfo(
    workingDir: string,
    projectDir?: string,
  ): Promise<Outcome<GitRead>> {
    const found = this.resolveEffectiveGitDir(workingDir, projectDir);
    if (found.kind !== "ok") return found;
    const gitDir = found.value;

    // branch/status/ahead-behind/sha/upstream are the core, and one
    // `git status --porcelain=v2 --branch` yields them all: without branch and
    // status there is no useful read, so a failed core fetch fails the whole
    // outcome rather than dressing up as a clean repo on a fallback branch.
    const core = await this.getCoreAsync(gitDir);
    if (core.kind !== "ok") return core;

    // Heavy operations stay serial — each is an expensive git invocation and
    // running them one at a time bounds concurrent git load per fetch.
    const committedAt = await this.committedAt(gitDir, core.value.oid);
    // [LAW:one-source-of-truth] repoName and repoUrl are two projections of ONE
    // remotes read, so they can never disagree about origin, and a failed read
    // fails both alike, by construction.
    const remotes = await this.getRemotesAsync(gitDir);

    return ok({
      branch: core.value.branch,
      status: core.value.status,
      aheadBehind: core.value.aheadBehind,
      head: core.value.oid,
      // sha, upstream, and the worktree counts all rode in on the core call —
      // attaching them here is a memory read, not another spawn.
      workingTree: core.value.workingTree,
      // [LAW:locality-or-seam] The 7-char truncation is a DISPLAY policy, so it
      // lives with the display field rather than in the parser: `CoreStatus`
      // keeps the one fact git reported. `git rev-parse --short` auto-lengthens
      // on collision, but re-spawning it to recover that would undo this
      // segment's whole point — one porcelain=v2 read instead of a fan-out — and
      // this value is display-only. The full oid is what keys the
      // commit-timestamp cache, so ambiguity here stays cosmetic instead of
      // becoming a wrong lookup.
      sha: derived(core.value.oid, (o) => o.slice(0, 7)),
      upstream: core.value.upstream,
      committedAt,
      stashCount: this.getStashCount(gitDir),
      repoName: derived(remotes, (r) => this.repoNameFrom(r, gitDir)),
      repoUrl: derived(remotes, repoWebUrl),
      operation: this.getOngoingOperation(gitDir),
    });
  }

  // [LAW:locality-or-seam] Public so the daemon-side provider can watch the
  // real HEAD/index files even for git worktrees. For a regular repo this is
  // `<workingDir>/.git`. For a worktree, `<workingDir>/.git` is a *file*
  // naming the worktree-metadata dir, where HEAD and index live — watching
  // `<workingDir>/.git/HEAD` would fail (no such path) and the cache would
  // never invalidate.
  //
  // [LAW:no-silent-failure] exception: this is a watch target, not an answer.
  // A `.git` that names nothing readable (a directory, an unreadable or
  // malformed file) watches the dotGit path, so callers always get a string.
  resolveGitDir(workingDir: string): string {
    return orElse(gitDirNamed(workingDir), path.join(workingDir, ".git"));
  }

  private getOngoingOperation(workingDir: string): Outcome<string> {
    try {
      const gitDir = this.resolveGitDir(workingDir);

      if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return ok("MERGE");
      if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD")))
        return ok("CHERRY-PICK");
      if (fs.existsSync(path.join(gitDir, "REVERT_HEAD"))) return ok("REVERT");
      if (fs.existsSync(path.join(gitDir, "BISECT_LOG"))) return ok("BISECT");
      if (
        fs.existsSync(path.join(gitDir, "rebase-merge")) ||
        fs.existsSync(path.join(gitDir, "rebase-apply"))
      )
        return ok("REBASE");

      return ABSENT;
    } catch (e) {
      return failed(
        `git operation probe: ${e instanceof Error ? e.message : String(e)}`,
        "read",
      );
    }
  }

  // [LAW:decomposition] Two facts were folded into one call, and only one of them
  // is a property of the repo. The commit's TIMESTAMP never changes — a sha names
  // one commit forever — while "how long ago" is that timestamp minus a clock
  // read. Split apart, the repo fact becomes cacheable with no TTL at all (the
  // daemon's GitDataProvider keys it on the oid) and the clock read belongs to
  // the render: `git.timeSinceCommit`, a projection, subtracts this from the instant the bar is
  // drawn at, so a GitInfo cached for a whole TTL window never carries an age
  // frozen at its fetch. Folded together, the spawn could only ever be cached
  // for as long as the answer was allowed to be wrong.
  //
  // An unborn HEAD has no commit to time, and says so without spawning anything:
  // `oid` is already absent, and that absence IS the answer the old non-zero
  // `git log` exit was translated into.
  private async committedAt(
    gitDir: string,
    oid: Outcome<string>,
  ): Promise<Outcome<number>> {
    if (oid.kind !== "ok") return oid;
    return this.commitTimestamp(gitDir, oid.value);
  }

  // [LAW:one-source-of-truth] exception: the class header rules out a cache here,
  // and this is one — with the reason that rule exists absent. The rule forbids
  // layering a per-process cache over an already-cached call because it "would
  // double the invalidation surface"; this map has NO invalidation surface. An oid
  // is content-addressed, so the commit it names has one committer date, the same
  // one forever and in every repo holding the object. There is no staleness to
  // coordinate, so there is no second invalidation to get wrong.
  //
  // It lives here rather than in the daemon's GitDataProvider, where the design
  // doc put it, because the provider computes GitInfo on a SEPARATE inner
  // GitService: an override on the provider would never be called. The cache has
  // to be where the spawn is.
  //
  // What it buys: `git log -1` fired once per cache miss — once per 30 s TTL
  // window on an active repo — to answer a question that had not changed since the
  // last commit. It now fires once per commit. The age is this timestamp
  // subtracted from each draw's instant, which is why splitting that
  // derivation out is what made this cacheable at all.
  //
  // Only `ok` is stored: `absent`/`failed` are transient (a commit the status call
  // just named should be readable), and pinning one under a key that never expires
  // would make a blip permanent. The promise is the value, so caching and
  // coalescing are one fact.
  private readonly commitTimes = new Map<string, Promise<Outcome<number>>>();

  private async commitTimestamp(
    gitDir: string,
    oid: string,
  ): Promise<Outcome<number>> {
    const hit = this.commitTimes.get(oid);
    if (hit !== undefined) {
      // LRU touch: re-insert so the oldest key is the least recently asked for.
      this.commitTimes.delete(oid);
      this.commitTimes.set(oid, hit);
      return hit;
    }
    const pending = this.readCommitTimestamp(gitDir, oid);
    this.commitTimes.set(oid, pending);
    void pending.then(
      (outcome) => {
        if (outcome.kind !== "ok" && this.commitTimes.get(oid) === pending) {
          this.commitTimes.delete(oid);
        }
      },
      () => {
        if (this.commitTimes.get(oid) === pending) {
          this.commitTimes.delete(oid);
        }
      },
    );
    while (this.commitTimes.size > COMMIT_TIME_CACHE_MAX) {
      const oldest = this.commitTimes.keys().next().value;
      if (oldest === undefined) break;
      this.commitTimes.delete(oldest);
    }
    return pending;
  }

  // The spawn itself. Naming the commit rather than leaving it implicit in HEAD is
  // what makes the value content-addressed, and it closes a race the implicit form
  // had: HEAD could move between the status call that reported the oid and this
  // one, so the timestamp could describe a different commit than the sha shown
  // beside it.
  private async readCommitTimestamp(
    gitDir: string,
    oid: string,
  ): Promise<Outcome<number>> {
    // non-zero = the commit is not there to read — a domain answer, `absent`.
    // `--` ends the revision list so an oid can never be read as a pathspec.
    const r = nonEmpty(
      classify(
        "git log -1",
        await this.execGitAsync(["log", "-1", "--format=%ct", oid, "--"], {
          cwd: gitDir,
          timeout: 2000,
        }),
        "absent",
      ),
    );
    if (r.kind !== "ok") return r;

    const committedAt = parseInt(r.value, 10);
    if (Number.isNaN(committedAt)) {
      return failed(`git log -1: unparseable timestamp "${r.value}"`, "parse");
    }
    return ok(committedAt);
  }

  // [LAW:decomposition] The COMMON git directory — where refs shared between a
  // repo and its linked worktrees live. `resolveGitDir` answers the other,
  // per-worktree question, which is the right one for HEAD and index and exactly
  // why it exists. `refs/stash` is not of that kind: measured, a linked
  // worktree's `git stash list` reports the MAIN repo's stashes, and the reflog
  // backing them exists ONLY under the common dir. Reading the per-worktree
  // gitdir would answer zero stashes for every worktree, silently.
  resolveCommonGitDir(gitDir: string): string {
    // No `commondir` file is the ordinary case: this already IS the common dir.
    // [LAW:no-silent-failure] exception: as resolveGitDir's, a read target —
    // an unreadable `commondir` reads the git dir itself.
    return orElse(commonDirOf(gitDir), gitDir);
  }

  // [LAW:one-source-of-truth] `git stash list` counts REFLOG ENTRIES for
  // `refs/stash`, not the ref — measured two ways: a hand-written
  // `logs/refs/stash` is precisely what `git stash list` reports, and a
  // `refs/stash` that exists with no reflog counts zero from both. libgit2
  // spells the same fact as `git_reflog_read` + `git_reflog_entrycount`. So the
  // count is this file's line count, and the counting expression below is the one
  // the `stash list` output already went through — only its input changed. A
  // reflog message cannot contain a newline, so lines and entries agree.
  //
  // [LAW:no-silent-failure] The three states survive the swap. ENOENT is a REAL
  // count of 0 — no stash was ever pushed here — while any other read error is
  // `failed`, so the meaning-erasure the old catch-to-0 created stays
  // unrepresentable. Sync, because reading one small file is not worth a
  // microtask: its former `Promise.all` partner is the only spawn left.
  private getStashCount(workingDir: string): Outcome<number> {
    const reflog = path.join(
      this.resolveCommonGitDir(this.resolveGitDir(workingDir)),
      "logs",
      "refs",
      "stash",
    );
    let text: string;
    try {
      text = fs.readFileSync(reflog, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok(0);
      return failed(
        `git stash reflog ${reflog}: ${e instanceof Error ? e.message : String(e)}`,
        "read",
      );
    }
    const entries = text.trim();
    return ok(entries ? entries.split("\n").length : 0);
  }

  // [LAW:one-source-of-truth] The one read of this repo's remotes per call site.
  // `repoName` and `repoUrl` share a single call from `computeGitInfo`, so those
  // two can never disagree about which remote is origin — that pair used to be
  // one `config --get remote.origin.url` each.
  //
  // The PR cache deliberately keeps its OWN call (`getRepoRemoteUrl`, from
  // src/daemon/cache/git.ts): the forge lookup is a network resource cached
  // under its own longer TTL, keyed `repoRoot|branch|remote`, and folding its
  // remote read into GitInfo would tie a network cache's input to the local
  // cache's fs-watched refresh cycle — the separation those two TTLs exist to
  // create. So this is one read per lifecycle, not one read overall.
  //
  // `--local` scopes the read to THIS repository's config. Without it the read
  // merges system → global → local, so a stray `remote.origin.url` in
  // ~/.gitconfig sorts FIRST and would hijack repoUrl, repoName and the PR cache
  // key for every repo on the machine — a regression against the `git config
  // --get` this replaced, whose last-wins was really scope precedence. Scoping
  // also makes config order unambiguous, so "first url" is a fact rather than a
  // bet about which scope won.
  //
  // `--get-regexp` exits 1 when NOTHING matches, which is a repo with no remotes
  // configured — a domain answer, so it lands as an EMPTY LIST rather than an
  // `absent` arm. [LAW:dataflow-not-control-flow] Every projection then reads
  // "no remotes" off the empty set (no repoUrl, basename repoName) instead of
  // carrying a second no-value state through three consumers. Exit 128 (an
  // unreadable or corrupt config) is NOT that answer and stays `failed`, so a
  // broken repo never renders as an empty one. [LAW:no-silent-failure]
  // [LAW:one-source-of-truth] The memo is keyed by the CONFIG FILE's identity, not
  // by the working directory and not by a path, because the file is what the answer
  // depends on: two worktrees of one repo share one config, so they share one memo,
  // and one repo cannot hold two answers. See `configIdentity` for why a path would
  // not have been enough.
  //
  // Remotes change roughly never, and this was re-read on every cache miss. The
  // stamp is the config's `mtimeMs:size` rather than its mtime alone — a real `git
  // remote add` was measured leaving the mtime unchanged at one-second resolution
  // while the size moved, and a missed change is the costly direction here (a
  // false one costs a single spawn). Deliberately NOT parsing .git/config: `git
  // config` honours `include` and `includeIf`, so a hand-rolled INI reader is an
  // enumeration gap with a wrong answer at the end of it. Keeping the spawn behind
  // the memo gets the saving with none of that exposure.
  //
  // The honest edges, both of which the spawn itself would not have: a remote added
  // through an INCLUDED file whose own mtime changed is not seen, and neither is
  // one in a `config.worktree` under `extensions.worktreeConfig`. A stat that fails
  // yields no stamp and therefore no memo, so an unreadable config re-reads rather
  // than freezing an answer.
  async getRemotesAsync(workingDir: string): Promise<Outcome<GitRemote[]>> {
    const configPath = path.join(
      this.resolveCommonGitDir(this.resolveGitDir(workingDir)),
      "config",
    );
    const identity = configIdentity(configPath);
    if (identity === null) return this.readRemotes(workingDir);
    const { key, stamp } = identity;

    const memo = this.remotesByConfig.get(key);
    if (memo !== undefined && memo.stamp === stamp) {
      this.remotesByConfig.delete(key);
      this.remotesByConfig.set(key, memo);
      return memo.remotes;
    }

    const remotes = this.readRemotes(workingDir);
    this.remotesByConfig.set(key, { stamp, remotes });
    // Only a settled `ok` is worth keeping: an empty list is a real answer, while
    // `failed` (exit 128, an unreadable config) is a condition to re-ask about
    // rather than one to hold until the file changes.
    void remotes.then(
      (outcome) => {
        const held = this.remotesByConfig.get(key);
        if (outcome.kind !== "ok" && held?.remotes === remotes) {
          this.remotesByConfig.delete(key);
        }
      },
      () => {
        const held = this.remotesByConfig.get(key);
        if (held?.remotes === remotes) this.remotesByConfig.delete(key);
      },
    );
    while (this.remotesByConfig.size > REMOTES_CACHE_MAX) {
      const oldest = this.remotesByConfig.keys().next().value;
      if (oldest === undefined) break;
      this.remotesByConfig.delete(oldest);
    }
    return remotes;
  }

  private readonly remotesByConfig = new Map<string, RemotesMemo>();

  private async readRemotes(workingDir: string): Promise<Outcome<GitRemote[]>> {
    return remotesOf(
      await this.execGitAsync(REMOTES_ARGS, { cwd: workingDir, timeout: 2000 }),
    );
  }

  // [LAW:effects-at-boundaries] Pure projection over remotes the caller already
  // read — no spawn of its own, so it cannot disagree with the sibling repoUrl
  // projection about what origin is.
  //
  // A local-only repo's name is its directory name BY POLICY (the display
  // contract for repos without a remote) — never as an error fallback; a failed
  // remotes read stays failed at the call site instead of borrowing this rule.
  private repoNameFrom(
    remotes: readonly GitRemote[],
    workingDir: string,
  ): string {
    const url = repoRemoteUrl(remotes);
    return (
      (url === null ? null : repoNameFromUrl(url)) ?? path.basename(workingDir)
    );
  }

  // [LAW:locality-or-seam] Public so the daemon's GitDataProvider can read the
  // remote to fold into its PR cache key (the PR value depends on the remote; a
  // re-pointed remote must be a new key). Raw, unparsed — the forge detector
  // reads the host from it. No remotes → `absent` (hence no forge PR concept),
  // distinct from a failed read.
  //
  // Named for the repo rather than for `origin` because it no longer reads
  // `origin` specifically — it projects `forgeRemoteUrl` over the same picked
  // remote repoName and repoUrl use, preferring a url a forge CLI recognizes.
  // That preference is the point: `detectForge` gates the whole PR lookup, so a
  // browsable-but-unrecognized mirror listed first would silently decide the
  // branch has no PR.
  async getRepoRemoteUrl(workingDir: string): Promise<Outcome<string>> {
    const remotes = await this.getRemotesAsync(workingDir);
    if (remotes.kind !== "ok") return remotes;
    const url = forgeRemoteUrl(remotes.value);
    return url === null ? ABSENT : ok(url);
  }

  // [LAW:single-enforcer] One boundary for forge-CLI spawns. Mirrors
  // execGitAsync but carries the "forge" launch category and a longer timeout
  // (this is a network call, not a local git read). Returns the typed
  // LaunchResult so classifyForgePr maps every termination cause to an Outcome.
  private async execForgeAsync(
    bin: string,
    args: readonly string[],
    options: { cwd: string; timeout: number },
  ): Promise<LaunchResult> {
    return this.launcher.launch({
      bin,
      args: [...args],
      cwd: options.cwd,
      timeoutMs: options.timeout,
      category: "forge",
    });
  }

  // [LAW:effects-at-boundaries] Resolve the branch's PR/MR via the forge
  // CLI. Pure dispatch over a remote the CALLER has already read: pick the
  // forge by host, run its CLI, fold the launch result into an Outcome. The
  // remote is a parameter (not read here) so the cache layer can fold it into
  // its key in the same read — no caching here; the daemon's GitDataProvider
  // owns the PR cache + TTL (a network resource wants a longer, independent
  // lifecycle than local git state). `absent` when the host is no recognized
  // forge; the CLI dispatch then classifies the rest.
  async resolvePullRequest(
    workingDir: string,
    remoteUrl: string,
  ): Promise<Outcome<PullRequest>> {
    const forge = detectForge(remoteUrl);
    if (forge === "github") {
      return classifyForgePr(
        "gh pr view",
        await this.execForgeAsync(
          FORGE_CLI.github,
          ["pr", "view", "--json", "number,state,url,headRefOid"],
          { cwd: workingDir, timeout: 5000 },
        ),
        /no (open )?pull requests? found/i,
        parseGithubPr,
      );
    }
    if (forge === "gitlab") {
      return classifyForgePr(
        "glab mr view",
        await this.execForgeAsync(
          FORGE_CLI.gitlab,
          ["mr", "view", "--output", "json"],
          {
            cwd: workingDir,
            timeout: 5000,
          },
        ),
        /no (open )?merge requests? (found|available)/i,
        parseGitlabMr,
      );
    }
    // Recognized neither host → no forge integration for this remote.
    return ABSENT;
  }

  // [LAW:single-enforcer] The one core git read. `git status --porcelain=v2
  // --branch` reports branch, short SHA, upstream, ahead/behind, and worktree
  // status in a single subprocess — the fan-out this method replaces spawned up
  // to six (status -b, two rev-list, a branch fallback, rev-parse HEAD, rev-parse
  // @{u}). Parsing is delegated to the pure `parseStatusV2`.
  private async getCoreAsync(workingDir: string): Promise<Outcome<CoreStatus>> {
    debug(`[GIT-EXEC] Running git status --porcelain=v2 in ${workingDir}`);
    const r = classify(
      "git status --porcelain=v2 --branch",
      await this.execGitAsync(["status", "--porcelain=v2", "--branch"], {
        cwd: workingDir,
        timeout: 2000,
      }),
      // `git status` has no non-zero domain answer; any failure means the
      // core state is unknown — no fabricated "clean" on a fallback branch.
      "failed",
    );
    if (r.kind !== "ok") return r;
    return ok(parseStatusV2(r.value));
  }
}
