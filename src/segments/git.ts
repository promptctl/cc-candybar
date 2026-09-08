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

export interface PullRequest {
  number: number;
  state: string;
  url: string;
}

// [LAW:types-are-the-program] Every on-demand field is an Outcome: undefined = not
// requested, `absent` = the domain has none, `failed` = carries its reason out.
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
  repoUrl?: Outcome<string>;
  isWorktree?: boolean;
  // [LAW:no-silent-failure] `failed` (the forge was asked and couldn't answer)
  // stays distinct from `absent`; the render boundary surfaces it visibly.
  pullRequest?: Outcome<PullRequest>;
}

export interface GitInfoOptions {
  showSha?: boolean;
  showWorkingTree?: boolean;
  showOperation?: boolean;
  showTag?: boolean;
  showTimeSinceCommit?: boolean;
  showStashCount?: boolean;
  showUpstream?: boolean;
  showRepoName?: boolean;
  showRepoUrl?: boolean;
  // A network call: the daemon's cache layer owns it, never computeGitInfo.
  showPullRequest?: boolean;
}

// [LAW:dataflow-not-control-flow] Whether a non-zero exit means "there is none" is
// per-command knowledge and enters as data. Transport failures are always `failed`.
function classify(
  label: string,
  result: LaunchResult,
  // How this command spells "there is none": "absent" — any non-zero exit; a
  // number — only that exit code; "failed" — none ever. [LAW:no-silent-failure]
  nonZero: "absent" | "failed" | number,
): Outcome<string> {
  if (result.ok) return ok(result.stdout);
  if (result.reason === "non-zero" && nonZero === "absent") return ABSENT;
  if (result.reason === "non-zero" && nonZero === result.exitCode)
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

function firstLine(s: string): string {
  return s.trim().split("\n", 1)[0] ?? "";
}

// [LAW:dataflow-not-control-flow] Lift a nullable derivation onto the Outcome it
// derives from: a failed read stays failed, a null derivation becomes `absent`.
function derived<A, B>(
  from: Outcome<A>,
  project: (value: A) => B | null,
): Outcome<B> {
  if (from.kind !== "ok") return from;
  const value = project(from.value);
  return value === null ? ABSENT : ok(value);
}

function nonEmpty(o: Outcome<string>): Outcome<string> {
  if (o.kind !== "ok") return o;
  const v = o.value.trim();
  return v ? ok(v) : ABSENT;
}

// [LAW:one-type-per-behavior] gh and glab differ only in no-PR stderr and JSON
// field names, so each supplies its (noPrPattern, parse) to one classifier.
export type ForgeName = "github" | "gitlab";

// Credentials are absent by construction — the parser never carries userinfo out.
export interface RemoteRef {
  readonly scheme: string;
  readonly host: string;
  readonly port: string;
  readonly path: string;
}

// A DOS drive path is LOCAL, not `host:path` — else the scp arm below claims the
// drive letter as a hostname. The separator keeps a single-letter ssh alias
// (`h:repo.git`) parsing. [LAW:one-type-per-behavior] exception: git only compiles
// drive handling on Windows; rejecting on POSIX too is a deliberate infidelity.
const DOS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

// [LAW:single-enforcer] THE one decision of what shape a raw remote string is, so
// "which forge?" and "what page?" cannot classify one string differently. Rewriting
// git's scp shorthand into ssh:// means one parser sees every shape; null = no host.
export function parseRemoteRef(raw: string): RemoteRef | null {
  const trimmed = raw.trim();
  if (DOS_DRIVE_PATH.test(trimmed)) return null;

  // The IPv6 arm goes FIRST or the generic arm stops at a colon inside the brackets.
  // A single-slash `file:/srv/x` deliberately lands here: git reads it as ssh too.
  const scp =
    trimmed.match(/^(?:[^@/]+@)?(\[[^\]]+\]):(.*)$/) ??
    trimmed.match(/^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.*)$/);
  const candidate = scp
    ? `ssh://${scp[1]}/${scp[2]!.replace(/^\/+/, "")}`
    : trimmed;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  return {
    scheme: url.protocol.replace(/:$/, ""),
    host: url.hostname.toLowerCase(),
    port: url.port,
    path: url.pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
  };
}

function remoteHost(remoteUrl: string): string | null {
  return parseRemoteRef(remoteUrl)?.host || null;
}

// [LAW:types-are-the-program] Branch on the HOST, not a substring of the URL.
export function detectForge(remoteUrl: string): ForgeName | null {
  const host = remoteHost(remoteUrl);
  if (!host) return null;
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (/(^|\.)gitlab\./.test(host)) return "gitlab";
  return null;
}

export interface GitRemote {
  readonly name: string;
  // EVERY url, in config order: a repo can fetch from a mirror and push to a forge.
  readonly urls: readonly string[];
}

// [LAW:effects-at-boundaries] Pure text→data. The name capture is greedy so a dotted
// remote name keeps its dots; a line with no URL is a remote with no URL.
export function parseRemotes(stdout: string): GitRemote[] {
  const urlsByName = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^remote\.(.+)\.url\s+(\S.*)$/);
    if (!match) continue;
    const urls = urlsByName.get(match[1]!) ?? [];
    urls.push(match[2]!.trim());
    urlsByName.set(match[1]!, urls);
  }
  return [...urlsByName].map(([name, urls]) => ({ name, urls }));
}

// [LAW:one-source-of-truth] THE url that says which repository a remote IS. Forge
// dispatch is a different question — see `forgeRemoteUrl`.
function identifyingUrl(remote: GitRemote): string | null {
  return (
    remote.urls.find((u) => remoteWebUrl(u) !== null) ?? remote.urls[0] ?? null
  );
}

// [LAW:one-source-of-truth] THE remote this repo IS, so its NAME and its LINK cannot
// describe two repositories. If origin is a local mirror, that mirror IS this repo.
function pickRepoRemote(remotes: readonly GitRemote[]): GitRemote | null {
  return remotes.find((r) => r.name === "origin") ?? remotes[0] ?? null;
}

export function repoRemoteUrl(remotes: readonly GitRemote[]): string | null {
  const remote = pickRepoRemote(remotes);
  return remote ? identifyingUrl(remote) : null;
}

// [LAW:one-type-per-behavior] "Where do I ask about pull requests?" is not "which
// url identifies the repo": `detectForge` gates the whole lookup, so prefer a url a
// forge CLI recognizes.
export function forgeRemoteUrl(remotes: readonly GitRemote[]): string | null {
  const remote = pickRepoRemote(remotes);
  if (!remote) return null;
  return (
    remote.urls.find((u) => detectForge(u) !== null) ?? identifyingUrl(remote)
  );
}

// Reads the PARSED path so the name and the page agree by construction; the raw
// string is the fallback, leaving the directory basename for a repo with NO remote.
export function repoNameFromUrl(url: string): string | null {
  const parsed = parseRemoteRef(url);
  const segments = (parsed?.path ?? url.replace(/[\\/]+$/, "")).split("/");
  const name = (segments[segments.length - 1] ?? "").replace(/\.git$/, "");
  return name || null;
}

// [LAW:parse-dont-validate] The returned string IS the proof: URL-parsed, http(s),
// credentials stripped — the render boundary re-checks nothing.
// [LAW:one-type-per-behavior] ssh→https is host-agnostic BY DESIGN; a hostname
// allow-list would be blind to every self-hosted forge.
export function remoteWebUrl(raw: string): string | null {
  const ref = parseRemoteRef(raw);
  if (!ref) return null;

  // [LAW:dataflow-not-control-flow] The scheme answers with VALUES. An ssh port says
  // nothing about where the web UI listens, so that arm answers "".
  const web = ((): { scheme: string; port: string } | null => {
    if (ref.scheme === "https") return { scheme: "https", port: ref.port };
    if (ref.scheme === "http") return { scheme: "http", port: ref.port };
    if (ref.scheme === "ssh" || ref.scheme === "git")
      return { scheme: "https", port: "" };
    return null;
  })();
  if (!web || !ref.host) return null;

  const repoPath = ref.path.replace(/\.git$/, "");
  if (!repoPath) return null;

  const authority = web.port ? `${ref.host}:${web.port}` : ref.host;
  return `${web.scheme}://${authority}/${repoPath}`;
}

export function repoWebUrl(remotes: readonly GitRemote[]): string | null {
  const url = repoRemoteUrl(remotes);
  return url === null ? null : remoteWebUrl(url);
}

export function classifyForgePr(
  label: string,
  result: LaunchResult,
  noPrPattern: RegExp,
  parse: (stdout: string) => Outcome<PullRequest>,
): Outcome<PullRequest> {
  if (result.ok) return parse(result.stdout);
  // ENOENT (no forge CLI on PATH) is a configuration absence. [LAW:no-silent-failure]
  // Every other spawn failure means the CLI is present but could not launch.
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

// [LAW:types-are-the-program] Everything one `git status --porcelain=v2 --branch`
// yields, so ahead/behind SHARES FATE with status instead of failing separately.
interface CoreStatus {
  branch: string;
  status: "clean" | "dirty" | "conflicts";
  workingTree: WorkingTree;
  aheadBehind: Outcome<AheadBehind>;
  sha: Outcome<string>;
  upstream: Outcome<string>;
}

// [LAW:effects-at-boundaries] Pure text→data; the subprocess lives in getCoreAsync.
// Porcelain v2: `# branch.<field>` headers, then entries — `1`/`2` carry XY
// index/worktree columns ('.' = unmodified), `u` is a conflict, `?` untracked.
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
        // Fixed 7-char truncation is the display contract: the sha is never a lookup
        // key, so rev-parse's collision-lengthening is not worth a second spawn.
        sha = v === "(initial)" ? ABSENT : ok(v.slice(0, 7));
      } else if (rest.startsWith("branch.head ")) {
        const v = rest.slice("branch.head ".length).trim();
        branch = v === "(detached)" ? "detached" : v;
      } else if (rest.startsWith("branch.upstream ")) {
        upstream = ok(rest.slice("branch.upstream ".length).trim());
      } else if (rest.startsWith("branch.ab ")) {
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

  // [LAW:locality-or-seam] Returns exactly the directory `computeGitInfo` uses as
  // `gitDir`, so the daemon's cache and watcher key on it. Both must agree.
  async resolveEffectiveGitDir(
    workingDir: string,
    projectDir?: string,
  ): Promise<Outcome<string>> {
    if (this.isWorktree(workingDir)) return ok(workingDir);
    if (projectDir && this.isGitRepo(projectDir)) return ok(projectDir);
    if (this.isGitRepo(workingDir)) return ok(workingDir);
    return this.findGitRoot(workingDir);
  }

  // [LAW:locality-or-seam] Public so daemon caches key on repoRoot without re-deriving it.
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

  // [LAW:one-source-of-truth] No inner cache; a second would double the
  // invalidation surface. [LAW:no-silent-failure] Never rejects — an unexpected
  // throw surfaces as a `failed` outcome carrying its reason.
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
      // A worktree's .git points to the main repo, so git must run from here.
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

    // A failed core fails the whole outcome rather than dressing up as a clean repo.
    const core = await this.getCoreAsync(gitDir);
    if (core.kind !== "ok") return core;

    const result: GitInfo = {
      branch: core.value.branch,
      status: core.value.status,
      aheadBehind: core.value.aheadBehind,
    };

    if (options.showWorkingTree) result.workingTree = core.value.workingTree;
    if (options.showSha) result.sha = core.value.sha;
    if (options.showUpstream) result.upstream = core.value.upstream;

    if (options.showTag) {
      result.tag = await this.getNearestTagAsync(gitDir);
    }
    if (options.showTimeSinceCommit) {
      result.timeSinceCommit = await this.getTimeSinceLastCommitAsync(gitDir);
    }

    // [LAW:one-source-of-truth] repoName and repoUrl are two projections of ONE
    // remotes read, so they cannot disagree and both cost a single spawn.
    const [stashCount, remotes] = await Promise.all([
      options.showStashCount ? this.getStashCountAsync(gitDir) : undefined,
      options.showRepoName || options.showRepoUrl
        ? this.getRemotesAsync(gitDir)
        : undefined,
    ]);
    if (stashCount !== undefined) result.stashCount = stashCount;
    if (remotes !== undefined && options.showRepoName) {
      result.repoName = derived(remotes, (r) => this.repoNameFrom(r, gitDir));
      result.isWorktree = isWorktreeDir;
    }
    if (remotes !== undefined && options.showRepoUrl) {
      result.repoUrl = derived(remotes, repoWebUrl);
    }

    if (options.showOperation) {
      result.operation = this.getOngoingOperation(gitDir);
    }

    return ok(result);
  }

  // [LAW:locality-or-seam] Public so the daemon can watch the REAL HEAD/index even
  // for a worktree, whose `.git` is a file naming the metadata dir they live in.
  // [LAW:no-defensive-null-guards] The try/catch is a trust-boundary guard, not a
  // silent skip: fs races fall back to dotGit rather than throwing.
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
      // Fall through to dotGit.
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
    // An empty stash list is a REAL count of 0; only a transport failure is `failed`.
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

  // [LAW:one-source-of-truth] One remotes read per call site, so repoName and
  // repoUrl cannot disagree about origin.
  // `--local` scopes the read to THIS repo — unscoped, git merges system → global →
  // local, so a stray ~/.gitconfig `remote.origin.url` would sort first and hijack
  // every repo on the machine. [LAW:dataflow-not-control-flow] Exit 1 (no matches) is
  // an EMPTY LIST; exit 128 (unreadable config) stays `failed`.
  async getRemotesAsync(workingDir: string): Promise<Outcome<GitRemote[]>> {
    const r = classify(
      "git config --get-regexp remote url",
      await this.execGitAsync(
        ["config", "--local", "--get-regexp", "^remote\\..*\\.url$"],
        { cwd: workingDir, timeout: 2000 },
      ),
      1,
    );
    if (r.kind === "failed") return r;
    return ok(r.kind === "ok" ? parseRemotes(r.value) : []);
  }

  // [LAW:effects-at-boundaries] Pure projection over remotes the caller already read.
  // A local-only repo's name is its directory name BY POLICY, never as an error fallback.
  private repoNameFrom(
    remotes: readonly GitRemote[],
    workingDir: string,
  ): string {
    const url = repoRemoteUrl(remotes);
    return (
      (url === null ? null : repoNameFromUrl(url)) ?? path.basename(workingDir)
    );
  }

  // [LAW:locality-or-seam] Public so the daemon folds the remote into its PR cache
  // key — a re-pointed remote must be a new key.
  async getRepoRemoteUrl(workingDir: string): Promise<Outcome<string>> {
    const remotes = await this.getRemotesAsync(workingDir);
    if (remotes.kind !== "ok") return remotes;
    const url = forgeRemoteUrl(remotes.value);
    return url === null ? ABSENT : ok(url);
  }

  // [LAW:single-enforcer] One boundary for forge-CLI spawns.
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

  // [LAW:effects-at-boundaries] Dispatch over a remote the CALLER has already read,
  // so the cache layer folds it into its key in that same read. No caching here.
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

  // [LAW:single-enforcer] The one core git read.
  private async getCoreAsync(workingDir: string): Promise<Outcome<CoreStatus>> {
    debug(`[GIT-EXEC] Running git status --porcelain=v2 in ${workingDir}`);
    const r = classify(
      "git status --porcelain=v2 --branch",
      await this.execGitAsync(["status", "--porcelain=v2", "--branch"], {
        cwd: workingDir,
        timeout: 2000,
      }),
      // `git status` has no non-zero domain answer: never a fabricated "clean".
      "failed",
    );
    if (r.kind !== "ok") return r;
    return ok(parseStatusV2(r.value));
  }
}
