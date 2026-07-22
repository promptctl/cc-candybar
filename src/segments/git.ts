import fs from "node:fs";
import path from "node:path";
import { launch, type LaunchResult } from "../proc/launch";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";
import { debug } from "../utils/logger";

export interface WorkingTree {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

// [LAW:types-are-the-program] The branch's open PR/MR as the forge reports it.
// `number` and `url` are the click target; `state` is the forge's status string
// (GitHub "OPEN", GitLab "opened") — carried so a consumer can color/label it,
// though resolvePullRequest only ever returns a PR whose state is open (a
// merged/closed PR for the branch is the domain's `absent`, not a value).
export interface PullRequest {
  number: number;
  state: string;
  url: string;
}

// [LAW:types-are-the-program] Every on-demand field is an Outcome, so "this
// value is unknown because the fetch failed" is representable distinct from
// a real 0/""/basename — the states the old catch-and-substitute blocks
// erased. An undefined field means "not requested" (its `show*` flag was
// off); `absent` means the domain genuinely has none (no upstream, no tags,
// no stash); `failed` carries the reason to the consuming boundary, which
// owns the log effect. branch/status stay plain: a fetch that cannot
// determine them is a failed fetch, not a GitInfo.
export interface GitInfo {
  branch: string;
  status: "clean" | "dirty" | "conflicts";
  aheadBehind: Outcome<AheadBehind>;
  workingTree?: WorkingTree;
  sha?: Outcome<string>;
  operation?: Outcome<string>;
  tag?: Outcome<string>;
  timeSinceCommit?: Outcome<number>;
  stashCount?: Outcome<number>;
  upstream?: Outcome<string>;
  repoName?: Outcome<string>;
  isWorktree?: boolean;
  // [LAW:no-silent-failure] The forge lookup's three outcomes are all kept
  // distinct here: `ok` is an open PR, `absent` is "this branch has none / no
  // forge / no forge CLI", `failed` is "the forge was asked but couldn't
  // answer" (auth, network, API error). The render boundary surfaces `failed`
  // as a VISIBLE marker — collapsing it to `absent` would make a transient
  // outage look like the PR vanished. Undefined = `showPullRequest` was off.
  pullRequest?: Outcome<PullRequest>;
}

// [LAW:one-source-of-truth] The one shape of getGitInfo's `show*` toggles. Each
// flag opts into an extra git invocation; an unset flag leaves its GitInfo field
// undefined (not requested). Every caller that builds these options
// (render-payload's gitOptionsFromClosure, the cache override) references THIS
// type, so the toggle set cannot drift between producer and consumer.
export interface GitInfoOptions {
  showSha?: boolean;
  showWorkingTree?: boolean;
  showOperation?: boolean;
  showTag?: boolean;
  showTimeSinceCommit?: boolean;
  showStashCount?: boolean;
  showUpstream?: boolean;
  showRepoName?: boolean;
  // Opts into the forge (gh/glab) PR/MR lookup — a network call, so it is the
  // one option whose fetch the daemon caches on a longer, independent TTL than
  // the rest of GitInfo (see src/daemon/cache/git.ts). Never resolved by the
  // inner GitService's computeGitInfo; the cache layer owns the lookup+cache.
  showPullRequest?: boolean;
}

// [LAW:dataflow-not-control-flow] One classifier for every git invocation.
// Whether a non-zero exit is the domain answering "there is none" (describe
// with no tags, rev-parse @{u} with no upstream) or a real failure is
// per-command knowledge — it enters here as data, not as a catch block at
// every callsite. Transport failures (timeout, spawn error, signal) are
// always `failed`: git did not answer.
function classify(
  label: string,
  result: LaunchResult,
  nonZero: "absent" | "failed",
): Outcome<string> {
  if (result.ok) return ok(result.stdout);
  if (result.reason === "non-zero" && nonZero === "absent") return ABSENT;
  const detail = [
    result.reason,
    result.exitCode != null ? `exit ${result.exitCode}` : null,
    result.error ?? firstLine(result.stderr),
  ]
    .filter(Boolean)
    .join(", ");
  return failed(`${label}: ${detail}`);
}

function firstLine(s: string): string {
  return s.trim().split("\n", 1)[0] ?? "";
}

// Trim an ok stdout; an empty answer is the domain's "there is none".
function nonEmpty(o: Outcome<string>): Outcome<string> {
  if (o.kind !== "ok") return o;
  const v = o.value.trim();
  return v ? ok(v) : ABSENT;
}

// [LAW:one-type-per-behavior] `gh` and `glab` are two instances of one act:
// "ask a forge CLI for the branch's PR, fold the typed launch result into an
// Outcome<PullRequest>." The accept/reject shape table is identical across
// both — only the no-PR stderr signature and the JSON field names differ — so
// the classification lives here once and each forge supplies its own
// (noPrPattern, parse) as data.
//
// [LAW:no-silent-failure] The full shape table, enumerated so no input leaks:
//   ok + parse ok (open PR)         → ok            (the value)
//   ok + parse ok (not open)        → absent        (branch's PR is done)
//   ok + parse fails                → failed        (forge answered garbage)
//   non-zero + no-PR stderr         → absent        (genuine "none for branch")
//   spawn-error ENOENT (no CLI)     → absent        (no forge integration)
//   spawn-error other (EACCES, …)   → failed        (CLI present but unlaunchable)
//   non-zero (auth/net/not-a-repo)  → failed        (forge couldn't answer)
//   timeout / signal / rate-limited → failed        (forge couldn't answer)
export type ForgeName = "github" | "gitlab";

// [LAW:types-are-the-program] Extract the host from a git remote, handling the
// two shapes git uses: scp-like `[user@]host:path` and URL `scheme://[user@]
// host[:port]/path`. The URL form is checked first — its `host` in a scp regex
// would mis-capture the scheme (`https` before `://`). Returns null for an
// unrecognized shape (local path, unknown syntax).
function remoteHost(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  const proto = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i);
  if (proto) return proto[1]!.toLowerCase();
  const scp = url.match(/^(?:[^@/]+@)?([^/:]+):/);
  if (scp) return scp[1]!.toLowerCase();
  return null;
}

// [LAW:types-are-the-program] Branch on the HOST, not a substring of the whole
// URL — a non-GitLab remote whose path merely contains "gitlab" (a repo named
// `gitlab`) must not dispatch to glab. Self-hosted GitLab is detected by a
// `gitlab.`-prefixed host label (gitlab.example.com); a GitLab on an arbitrary
// hostname is undetectable here and falls through to null (absent), same as
// GitHub Enterprise on a custom domain.
export function detectForge(remoteUrl: string): ForgeName | null {
  const host = remoteHost(remoteUrl);
  if (!host) return null;
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (/(^|\.)gitlab\./.test(host)) return "gitlab";
  return null;
}

export function classifyForgePr(
  label: string,
  result: LaunchResult,
  noPrPattern: RegExp,
  parse: (stdout: string) => Outcome<PullRequest>,
): Outcome<PullRequest> {
  if (result.ok) return parse(result.stdout);
  // ENOENT (no forge CLI on PATH) is a static configuration absence, not a
  // transient lookup failure — it never showed a PR, so showing nothing costs
  // nothing. [LAW:no-silent-failure] Every OTHER spawn failure (EACCES,
  // resource limits) means the CLI is present but could not launch — a real
  // failure that must stay visible, so it falls through to the `failed` path.
  if (result.reason === "spawn-error" && /ENOENT/i.test(result.error ?? ""))
    return ABSENT;
  if (result.reason === "non-zero" && noPrPattern.test(result.stderr))
    return ABSENT;
  const detail = [
    result.reason,
    result.exitCode != null ? `exit ${result.exitCode}` : null,
    result.error ?? firstLine(result.stderr),
  ]
    .filter(Boolean)
    .join(", ");
  return failed(`${label}: ${detail}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// [LAW:decomposition] The core git snapshot as a SINGLE `git status
// --porcelain=v2 --branch` yields it. That one invocation reports branch,
// short SHA, upstream, ahead/behind, and the full worktree status — so the
// prior fan-out (status -b + two rev-list + a branch-fallback + rev-parse HEAD
// + rev-parse @{u}, up to six spawns) collapses to one. Fewer spawns per cache
// miss is the whole point of brandon-daemon-perf-bb9.1; folding these also
// makes ahead/behind SHARE FATE with status (same subprocess) instead of being
// an independently-failable partial state ([LAW:types-are-the-program]).
interface CoreStatus {
  branch: string;
  status: "clean" | "dirty" | "conflicts";
  workingTree: WorkingTree;
  // Each an Outcome so "no upstream / unborn HEAD" (absent) stays distinct from
  // a value — the same three-state contract every on-demand field carries.
  aheadBehind: Outcome<AheadBehind>;
  sha: Outcome<string>;
  upstream: Outcome<string>;
}

// [LAW:effects-at-boundaries] Pure text→data: the subprocess (the effect) lives
// in getCoreAsync; this parses its stdout. Exported so the accept/reject shape
// table is unit-testable without spawning git.
//
// Porcelain v2 header lines (`# branch.<field> <value>`) carry branch/oid/
// upstream/ab; entry lines classify the worktree:
//   `1 XY …` ordinary change  → XY[0]=index, XY[1]=worktree ('.' = unmodified)
//   `2 XY …` rename/copy       → same XY columns
//   `u …`    unmerged          → a conflict
//   `? path` untracked
//   `! path` ignored (never requested here; skipped)
// The `(initial)` oid (unborn HEAD) and `(detached)` head are git's sentinels
// for "no commit yet" and "detached" — mapped to absent-sha and the "detached"
// branch label respectively, matching the prior fallback-chain behavior.
export function parseStatusV2(stdout: string): CoreStatus {
  let branch = "detached";
  let sha: Outcome<string> = ABSENT;
  let upstream: Outcome<string> = ABSENT;
  let aheadBehind: Outcome<AheadBehind> = ABSENT;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const line of stdout.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# ")) {
      const rest = line.slice(2);
      if (rest.startsWith("branch.oid ")) {
        const v = rest.slice("branch.oid ".length).trim();
        sha = v === "(initial)" ? ABSENT : ok(v.slice(0, 7));
      } else if (rest.startsWith("branch.head ")) {
        const v = rest.slice("branch.head ".length).trim();
        branch = v === "(detached)" ? "detached" : v;
      } else if (rest.startsWith("branch.upstream ")) {
        upstream = ok(rest.slice("branch.upstream ".length).trim());
      } else if (rest.startsWith("branch.ab ")) {
        // Format is exactly "+<ahead> -<behind>"; a shape mismatch leaves
        // aheadBehind absent rather than fabricating a count.
        const m = rest
          .slice("branch.ab ".length)
          .trim()
          .match(/^\+(\d+)\s+-(\d+)$/);
        if (m) {
          aheadBehind = ok({
            ahead: parseInt(m[1]!, 10),
            behind: parseInt(m[2]!, 10),
          });
        }
      }
      continue;
    }

    const kind = line[0];
    if (kind === "1" || kind === "2") {
      const xy = line.slice(2, 4);
      if (xy[0] !== ".") staged++;
      if (xy[1] !== ".") unstaged++;
    } else if (kind === "u") {
      conflicts++;
    } else if (kind === "?") {
      untracked++;
    }
  }

  let status: "clean" | "dirty" | "conflicts" = "clean";
  if (conflicts > 0) status = "conflicts";
  else if (staged || unstaged || untracked) status = "dirty";

  return {
    branch,
    status,
    aheadBehind,
    sha,
    upstream,
    workingTree: { staged, unstaged, untracked, conflicts },
  };
}

// `gh pr view --json number,state,url` → one JSON object. Only an OPEN PR is a
// value; a MERGED/CLOSED PR for the branch is the domain's `absent`.
export function parseGithubPr(stdout: string): Outcome<PullRequest> {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (e) {
    return failed(
      `gh pr view: unparseable JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!isRecord(json)) return failed("gh pr view: JSON is not an object");
  const { number, state, url } = json;
  if (
    typeof number !== "number" ||
    typeof state !== "string" ||
    typeof url !== "string"
  ) {
    return failed("gh pr view: missing number/state/url");
  }
  if (state.toUpperCase() !== "OPEN") return ABSENT;
  return ok({ number, state, url });
}

// `glab mr view --output json` → one JSON object (iid / state / web_url). State
// "opened" is the open MR; anything else is `absent`. NOTE: verified against
// glab's documented JSON shape, not runtime-exercised here (glab not installed
// on the dev machine) — the github path is the runtime-verified one.
export function parseGitlabMr(stdout: string): Outcome<PullRequest> {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (e) {
    return failed(
      `glab mr view: unparseable JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!isRecord(json)) return failed("glab mr view: JSON is not an object");
  const iid = json.iid;
  const state = json.state;
  const url = json.web_url;
  if (
    typeof iid !== "number" ||
    typeof state !== "string" ||
    typeof url !== "string"
  ) {
    return failed("glab mr view: missing iid/state/web_url");
  }
  if (state.toLowerCase() !== "opened") return ABSENT;
  return ok({ number: iid, state, url });
}

export class GitService {
  private isGitRepo(workingDir: string): boolean {
    try {
      return fs.existsSync(path.join(workingDir, ".git"));
    } catch {
      return false;
    }
  }

  // [LAW:types-are-the-program] args is a string[] so the boundary type
  // forbids the only-space-free-arguments contract the prior whitespace-split
  // implementation relied on. Returns the full LaunchResult — the typed
  // termination cause `launch` already computed — so `classify` can map it to
  // an Outcome without a thrown Error flattening that information away.
  private async execGitAsync(
    args: readonly string[],
    options: { cwd: string; timeout: number },
  ): Promise<LaunchResult> {
    return launch({
      bin: "git",
      args: [...args],
      cwd: options.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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
  async resolveEffectiveGitDir(
    workingDir: string,
    projectDir?: string,
  ): Promise<Outcome<string>> {
    if (this.isWorktree(workingDir)) return ok(workingDir);
    if (projectDir && this.isGitRepo(projectDir)) return ok(projectDir);
    if (this.isGitRepo(workingDir)) return ok(workingDir);
    return this.findGitRoot(workingDir);
  }

  // [LAW:locality-or-seam] public so daemon-side caches can key on the
  // repoRoot they'd otherwise have to re-derive. `absent` is rev-parse's
  // non-zero exit — "not in a git repository", the everyday domain answer.
  async findGitRoot(workingDir: string): Promise<Outcome<string>> {
    return nonEmpty(
      classify(
        "git rev-parse --show-toplevel",
        await this.execGitAsync(["rev-parse", "--show-toplevel"], {
          cwd: workingDir,
          timeout: 2000,
        }),
        "absent",
      ),
    );
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
    options: GitInfoOptions = {},
    projectDir?: string,
  ): Promise<Outcome<GitInfo>> {
    try {
      return await this.computeGitInfo(workingDir, options, projectDir);
    } catch (e) {
      return failed(`git: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async computeGitInfo(
    workingDir: string,
    options: GitInfoOptions = {},
    projectDir?: string,
  ): Promise<Outcome<GitInfo>> {
    let gitDir: string;
    const isWorktreeDir = this.isWorktree(workingDir);

    if (isWorktreeDir) {
      // Worktree's .git is a file pointing to the main repo;
      // git commands must run from the worktree directory.
      gitDir = workingDir;
    } else if (projectDir && this.isGitRepo(projectDir)) {
      gitDir = projectDir;
    } else if (this.isGitRepo(workingDir)) {
      gitDir = workingDir;
    } else {
      const foundGitRoot = await this.findGitRoot(workingDir);
      if (foundGitRoot.kind !== "ok") return foundGitRoot;
      gitDir = foundGitRoot.value;
    }

    // branch/status/ahead-behind/sha/upstream are the core, and one
    // `git status --porcelain=v2 --branch` yields them all: without branch and
    // status there is no useful GitInfo, so a failed core fetch fails the whole
    // outcome rather than dressing up as a clean repo on a fallback branch.
    const core = await this.getCoreAsync(gitDir);
    if (core.kind !== "ok") return core;

    const result: GitInfo = {
      branch: core.value.branch,
      status: core.value.status,
      aheadBehind: core.value.aheadBehind,
    };

    // sha, upstream, and the worktree counts all rode in on the core call —
    // attaching them here is a memory read, not another spawn.
    if (options.showWorkingTree) result.workingTree = core.value.workingTree;
    if (options.showSha) result.sha = core.value.sha;
    if (options.showUpstream) result.upstream = core.value.upstream;

    // Heavy operations stay serial — each is an expensive git invocation and
    // running them one at a time bounds concurrent git load per fetch.
    if (options.showTag) {
      result.tag = await this.getNearestTagAsync(gitDir);
    }
    if (options.showTimeSinceCommit) {
      result.timeSinceCommit = await this.getTimeSinceLastCommitAsync(gitDir);
    }

    // Light operations run in parallel. Helpers never reject — failure is a
    // value in the outcome — so plain Promise.all replaces the allSettled +
    // untyped resultMap machinery the swallowing design required.
    const [stashCount, repoName] = await Promise.all([
      options.showStashCount ? this.getStashCountAsync(gitDir) : undefined,
      options.showRepoName ? this.getRepoNameAsync(gitDir) : undefined,
    ]);
    if (stashCount !== undefined) result.stashCount = stashCount;
    if (repoName !== undefined) {
      result.repoName = repoName;
      result.isWorktree = isWorktreeDir;
    }

    if (options.showOperation) {
      result.operation = this.getOngoingOperation(gitDir);
    }

    return ok(result);
  }

  // [LAW:locality-or-seam] Public so the daemon-side provider can watch the
  // real HEAD/index files even for git worktrees. For a regular repo this is
  // `<workingDir>/.git`. For a worktree, `<workingDir>/.git` is a *file*
  // containing `gitdir: <abs-path-to-worktree-metadata-dir>` and the actual
  // HEAD/index live inside that metadata dir — watching `<workingDir>/.git/HEAD`
  // would fail (no such path) and the cache would never invalidate. Returning
  // the resolved gitDir lets the provider point watchers at real files.
  //
  // [LAW:no-defensive-null-guards] The try/catch is a trust-boundary guard,
  // not a silent skip — fs races (file removed between existsSync and
  // statSync), permission errors, or unreadable .git files fall back to the
  // dotGit path so callers always get a string, never a throw.
  resolveGitDir(workingDir: string): string {
    const dotGit = path.join(workingDir, ".git");
    try {
      if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
        const content = fs.readFileSync(dotGit, "utf-8");
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match?.[1]) {
          return path.resolve(workingDir, match[1].trim());
        }
      }
    } catch {
      // Fall through to the dotGit fallback below.
    }
    return dotGit;
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
      );
    }
  }

  private async getNearestTagAsync(
    workingDir: string,
  ): Promise<Outcome<string>> {
    // non-zero = no tags reachable — describe's domain answer.
    return nonEmpty(
      classify(
        "git describe --tags",
        await this.execGitAsync(["describe", "--tags", "--abbrev=0"], {
          cwd: workingDir,
          timeout: 2000,
        }),
        "absent",
      ),
    );
  }

  private async getTimeSinceLastCommitAsync(
    workingDir: string,
  ): Promise<Outcome<number>> {
    // non-zero = no commits yet (empty repo) — a domain answer.
    const r = nonEmpty(
      classify(
        "git log -1",
        await this.execGitAsync(["log", "-1", "--format=%ct"], {
          cwd: workingDir,
          timeout: 2000,
        }),
        "absent",
      ),
    );
    if (r.kind !== "ok") return r;

    const commitTime = parseInt(r.value) * 1000;
    if (Number.isNaN(commitTime)) {
      return failed(`git log -1: unparseable timestamp "${r.value}"`);
    }
    const now = Date.now();
    return ok(Math.floor((now - commitTime) / 1000));
  }

  private async getStashCountAsync(
    workingDir: string,
  ): Promise<Outcome<number>> {
    // An empty stash list is a REAL count of 0; only a transport/exit failure
    // is `failed` — the meaning-erasure the old catch-to-0 created is
    // unrepresentable now. `stash list` never exits non-zero as an answer.
    const r = classify(
      "git stash list",
      await this.execGitAsync(["stash", "list"], {
        cwd: workingDir,
        timeout: 2000,
      }),
      "failed",
    );
    if (r.kind !== "ok") return r;
    const stashList = r.value.trim();
    return ok(stashList ? stashList.split("\n").length : 0);
  }

  private async getRepoNameAsync(workingDir: string): Promise<Outcome<string>> {
    const r = classify(
      "git config remote.origin.url",
      await this.execGitAsync(["config", "--get", "remote.origin.url"], {
        cwd: workingDir,
        timeout: 2000,
      }),
      // `config --get` exits 1 when the key is unset — "no remote", a domain
      // answer, not a failure.
      "absent",
    );
    if (r.kind === "failed") return r;

    // A local-only repo's name is its directory name BY POLICY (the display
    // contract for repos without a remote) — never as an error fallback; a
    // failed `git config` above stays failed instead of borrowing this rule.
    const remoteUrl = r.kind === "ok" ? r.value.trim() : "";
    if (!remoteUrl) return ok(path.basename(workingDir));

    const match = remoteUrl.match(/\/([^/]+?)(\.git)?$/);
    return ok(match?.[1] || path.basename(workingDir));
  }

  // [LAW:locality-or-seam] Public so the daemon's GitDataProvider can read the
  // remote to fold into its PR cache key (the PR value depends on the remote;
  // a re-pointed origin must be a new key). Raw origin URL (unparsed) — the
  // forge detector reads the host from it. `config --get` exits 1 when unset →
  // `absent` (no remote, hence no forge PR concept), distinct from a failure.
  async getRemoteOriginUrl(workingDir: string): Promise<Outcome<string>> {
    return nonEmpty(
      classify(
        "git config remote.origin.url",
        await this.execGitAsync(["config", "--get", "remote.origin.url"], {
          cwd: workingDir,
          timeout: 2000,
        }),
        "absent",
      ),
    );
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
    return launch({
      bin,
      args: [...args],
      cwd: options.cwd,
      env: { ...process.env },
      timeoutMs: options.timeout,
      category: "forge",
    });
  }

  // [LAW:effects-at-boundaries] Resolve the branch's open PR/MR via the forge
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
          "gh",
          ["pr", "view", "--json", "number,state,url"],
          { cwd: workingDir, timeout: 5000 },
        ),
        /no (open )?pull requests? found/i,
        parseGithubPr,
      );
    }
    if (forge === "gitlab") {
      return classifyForgePr(
        "glab mr view",
        await this.execForgeAsync("glab", ["mr", "view", "--output", "json"], {
          cwd: workingDir,
          timeout: 5000,
        }),
        /no (open )?merge requests? (found|available)/i,
        parseGitlabMr,
      );
    }
    // Recognized neither host → no forge integration for this remote.
    return ABSENT;
  }

  private isWorktree(workingDir: string): boolean {
    try {
      const gitDir = path.join(workingDir, ".git");
      if (fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
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
