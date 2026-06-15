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

export function detectForge(remoteUrl: string): ForgeName | null {
  if (/github\.com/i.test(remoteUrl)) return "github";
  // Matches gitlab.com and self-hosted GitLab (gitlab.example.com).
  if (/gitlab/i.test(remoteUrl)) return "gitlab";
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

    // branch/status are the core: without them there is no useful GitInfo,
    // so a failed core fetch fails the whole outcome rather than dressing
    // up as a clean repo on a fallback branch.
    const core = await this.getStatusWithBranchAsync(gitDir);
    if (core.kind !== "ok") return core;
    const aheadBehind = await this.getAheadBehindAsync(gitDir);

    const result: GitInfo = {
      branch: core.value.branch,
      status: core.value.status,
      aheadBehind,
    };

    if (options.showWorkingTree) {
      result.workingTree = core.value.workingTree;
    }

    // Heavy operations stay serial — each is an expensive git invocation and
    // running them one at a time bounds concurrent git load per fetch.
    if (options.showSha) {
      result.sha = await this.getShaAsync(gitDir);
    }
    if (options.showTag) {
      result.tag = await this.getNearestTagAsync(gitDir);
    }
    if (options.showTimeSinceCommit) {
      result.timeSinceCommit = await this.getTimeSinceLastCommitAsync(gitDir);
    }

    // Light operations run in parallel. Helpers never reject — failure is a
    // value in the outcome — so plain Promise.all replaces the allSettled +
    // untyped resultMap machinery the swallowing design required.
    const [stashCount, upstream, repoName] = await Promise.all([
      options.showStashCount ? this.getStashCountAsync(gitDir) : undefined,
      options.showUpstream ? this.getUpstreamAsync(gitDir) : undefined,
      options.showRepoName ? this.getRepoNameAsync(gitDir) : undefined,
    ]);
    if (stashCount !== undefined) result.stashCount = stashCount;
    if (upstream !== undefined) result.upstream = upstream;
    if (repoName !== undefined) {
      result.repoName = repoName;
      result.isWorktree = isWorktreeDir;
    }

    if (options.showOperation) {
      result.operation = this.getOngoingOperation(gitDir);
    }

    return ok(result);
  }

  private async getShaAsync(workingDir: string): Promise<Outcome<string>> {
    // non-zero = no HEAD to resolve (empty repo) — a domain answer.
    return nonEmpty(
      classify(
        "git rev-parse HEAD",
        await this.execGitAsync(["rev-parse", "--short=7", "HEAD"], {
          cwd: workingDir,
          timeout: 2000,
        }),
        "absent",
      ),
    );
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

  private async getUpstreamAsync(workingDir: string): Promise<Outcome<string>> {
    // non-zero = no upstream configured — the everyday domain answer.
    return nonEmpty(
      classify(
        "git rev-parse @{u}",
        await this.execGitAsync(["rev-parse", "--abbrev-ref", "@{u}"], {
          cwd: workingDir,
          timeout: 2000,
        }),
        "absent",
      ),
    );
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

  // Raw origin URL (unparsed) — the forge detector reads the host from it.
  // `config --get` exits 1 when unset → `absent` (no remote, hence no forge PR
  // concept), distinct from a real failure.
  private async getRemoteOriginUrlAsync(
    workingDir: string,
  ): Promise<Outcome<string>> {
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
  // CLI. Pure dispatch: read the remote, pick the forge by host, run its CLI,
  // fold the launch result into an Outcome. No caching here — the daemon's
  // GitDataProvider owns the PR cache + TTL (a network resource wants a longer,
  // independent lifecycle than local git state). `absent` when there is no
  // remote or no recognized forge; the CLI dispatch then classifies the rest.
  async resolvePullRequest(workingDir: string): Promise<Outcome<PullRequest>> {
    const remote = await this.getRemoteOriginUrlAsync(workingDir);
    // [LAW:no-silent-failure] A `failed` remote read (git itself couldn't run —
    // timeout, spawn-error) is a real failure that must surface, NOT collapse
    // into "no PR". Only `absent` (no remote configured) means there is
    // genuinely no forge PR to show.
    if (remote.kind === "failed") return remote;
    if (remote.kind === "absent") return ABSENT;

    const forge = detectForge(remote.value);
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

  private async getStatusWithBranchAsync(workingDir: string): Promise<
    Outcome<{
      branch: string;
      status: "clean" | "dirty" | "conflicts";
      workingTree: WorkingTree;
    }>
  > {
    debug(`[GIT-EXEC] Running git status in ${workingDir}`);
    const r = classify(
      "git status --porcelain -b",
      await this.execGitAsync(["status", "--porcelain", "-b"], {
        cwd: workingDir,
        timeout: 2000,
      }),
      // `git status` has no non-zero domain answer; any failure means the
      // core state is unknown — no fabricated "clean" on a fallback branch.
      "failed",
    );
    if (r.kind !== "ok") return r;

    const lines = r.value.split("\n");

    let branch: string | null = null;
    let status: "clean" | "dirty" | "conflicts" = "clean";
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    let conflicts = 0;

    for (const line of lines) {
      if (!line) continue;

      if (line.startsWith("## ")) {
        const branchLine = line.substring(3);
        const branchMatch = branchLine.split("...")[0];
        if (branchMatch && branchMatch !== "HEAD (no branch)") {
          branch = branchMatch;
        }
        continue;
      }

      if (line.length >= 2) {
        const indexStatus = line.charAt(0);
        const worktreeStatus = line.charAt(1);

        if (indexStatus === "?" && worktreeStatus === "?") {
          untracked++;
          if (status === "clean") status = "dirty";
          continue;
        }

        const statusPair = indexStatus + worktreeStatus;
        if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(statusPair)) {
          conflicts++;
          status = "conflicts";
          continue;
        }

        if (indexStatus !== " " && indexStatus !== "?") {
          staged++;
          if (status === "clean") status = "dirty";
        }
        if (worktreeStatus !== " " && worktreeStatus !== "?") {
          unstaged++;
          if (status === "clean") status = "dirty";
        }
      }
    }

    if (branch === null) {
      const fallback = await this.getFallbackBranch(workingDir);
      // A transport failure resolving the branch fails the core: rendering
      // a fake "detached" for a repo whose branch merely couldn't be read
      // would be the same meaning-erasure this type exists to forbid.
      if (fallback.kind === "failed") return fallback;
      branch = fallback.kind === "ok" ? fallback.value : "detached";
    }

    return ok({
      branch,
      status,
      workingTree: { staged, unstaged, untracked, conflicts },
    });
  }

  private async getFallbackBranch(
    workingDir: string,
  ): Promise<Outcome<string>> {
    // Both commands answer "detached" with a non-zero exit (symbolic-ref) or
    // empty output (show-current) — `absent` means genuinely detached.
    const primary = nonEmpty(
      classify(
        "git branch --show-current",
        await this.execGitAsync(["branch", "--show-current"], {
          cwd: workingDir,
          timeout: 2000,
        }),
        "absent",
      ),
    );
    if (primary.kind !== "absent") return primary;
    return nonEmpty(
      classify(
        "git symbolic-ref HEAD",
        await this.execGitAsync(["symbolic-ref", "--short", "HEAD"], {
          cwd: workingDir,
          timeout: 2000,
        }),
        "absent",
      ),
    );
  }

  private async getAheadBehindAsync(
    workingDir: string,
  ): Promise<Outcome<AheadBehind>> {
    debug(`[GIT-EXEC] Running git ahead/behind in ${workingDir}`);
    const [aheadResult, behindResult] = await Promise.all([
      this.execGitAsync(["rev-list", "--count", "@{u}..HEAD"], {
        cwd: workingDir,
        timeout: 2000,
      }),
      this.execGitAsync(["rev-list", "--count", "HEAD..@{u}"], {
        cwd: workingDir,
        timeout: 2000,
      }),
    ]);
    // non-zero = no upstream to compare against — the domain answer for any
    // local-only branch, distinct from a transport failure.
    const ahead = classify("git rev-list @{u}..HEAD", aheadResult, "absent");
    const behind = classify("git rev-list HEAD..@{u}", behindResult, "absent");
    if (ahead.kind === "failed") return ahead;
    if (behind.kind === "failed") return behind;
    if (ahead.kind === "absent" || behind.kind === "absent") return ABSENT;
    return ok({
      ahead: parseInt(ahead.value.trim()) || 0,
      behind: parseInt(behind.value.trim()) || 0,
    });
  }
}
