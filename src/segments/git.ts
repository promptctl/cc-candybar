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
  // The repo's browsable web page, derived from the same remotes read repoName
  // is. `absent` = the repo has no remote a browser can open (local-only, a
  // bare-path remote); `failed` = the remotes read itself failed.
  repoUrl?: Outcome<string>;
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
  // Shares ONE `git config --get-regexp` with showRepoName — turning both on
  // costs the same single spawn as turning either on alone.
  showRepoUrl?: boolean;
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
  // How this command spells "there is none":
  //   "absent" — ANY non-zero exit is the domain answer. `git describe --tags`
  //     and `git rev-parse @{u}` both exit 128 for their genuine absences, so a
  //     narrower rule would misread them as failures.
  //   a number — ONLY that exit code is the domain answer; every other non-zero
  //     is a real failure. `git config --get-regexp` exits 1 for "no matches"
  //     but 128 for an unreadable config, and folding those together would
  //     render a broken repo as an empty one. [LAW:no-silent-failure]
  //   "failed" — no non-zero exit is ever a domain answer.
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

// [LAW:types-are-the-program] A git remote decomposed into the four facts every
// consumer of one actually wants. Credentials are absent by construction — the
// parser never carries userinfo out — so no downstream can leak a token it was
// never handed.
export interface RemoteRef {
  // Lowercase, no trailing colon: "https", "ssh", "git", "file", …
  readonly scheme: string;
  // Lowercased; "" for a hostless URL (`file:///srv/git/r`).
  readonly host: string;
  // "" when the remote names none.
  readonly port: string;
  // No leading or trailing slash. Still carries any `.git` suffix — trimming
  // that is a web-display rule, not a fact about the remote.
  readonly path: string;
}

// A DOS drive path is a LOCAL path, not `host:path`. git says so directly
// (`has_dos_drive_prefix`), and without this the scp arm below claims the drive
// letter as a hostname: `C:/repo.git` became `https://C/repo`, a live link to a
// host named `c`.
//
// The separator is required. `^[A-Za-z]:` alone would also reject `h:repo.git`,
// a single-letter ssh-config alias and a form people really use; requiring
// `[\\/]` keeps that working while still catching `C:/…` and `C:\…`.
//
// [LAW:one-type-per-behavior] exception: git's own drive-letter handling is
// compiled in only on Windows — on POSIX `git ls-remote "C:/x"` genuinely tries
// ssh host `c` — so rejecting unconditionally is a deliberate small infidelity
// to the producer. Reading `path.sep` here would make a pure parser ambient
// (`[LAW:effects-at-boundaries]`), and the asymmetry pays for it: on POSIX the
// only input whose answer changes is a single-letter host with a drive-shaped
// absolute path, which in practice is a pasted Windows path. No link beats a
// wrong link.
const DOS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

// [LAW:single-enforcer] THE one decision of what shape a raw remote string is.
// Both questions asked of a remote — "which forge is this?" (`remoteHost` →
// `detectForge`) and "what page does this open?" (`remoteWebUrl`) — are
// projections over this one answer, so they cannot classify the same string
// differently. They already had: two regexes ago, `detectForge` lowercased its
// host and `remoteWebUrl` did not, because WHATWG normalizes host case for
// "special" schemes (`https:`) and not for `ssh:` — so `git@GitHub.com:o/r.git`
// resolved to forge `github` but to page `https://GitHub.com/o/r`. The
// lowercase below is that fix, applied once where both readers see it.
//
// git spells an ssh remote two ways, and this collapses them: the URL form
// `scheme://[user@]host[:port]/path`, and the scp shorthand `[user@]host:path`
// — which per `git help clone` "is only recognized if there are no slashes
// before the first colon". Rewriting the shorthand into its ssh:// spelling
// means one parser (the URL parser) sees every shape.
//
// Returns null when the string names no host at all: a local path, a relative
// path, a drive path, an empty remote.
export function parseRemoteRef(raw: string): RemoteRef | null {
  const trimmed = raw.trim();
  if (DOS_DRIVE_PATH.test(trimmed)) return null;

  // git spells an scp host two ways and both must decode through here. The
  // bracketed IPv6 arm is tried FIRST because the generic arm would otherwise
  // stop at the first colon inside the brackets and claim `[2001` as the host.
  // Its user capture allows colons (`[^@/]+`) where the generic arm forbids
  // them: an IPv6 literal makes colons ordinary, so `user@[::1]:repo.git` must
  // still parse.
  //
  // The `(?!//)` is what keeps `https://…` out of the generic arm — there the
  // colon separates a scheme, not a host from a path. A single-slash
  // `file:/srv/x` deliberately DOES land here: git resolves it to ssh host
  // `file` too (verified with `git ls-remote`), and disagreeing with git about
  // what a repo's own remote means would be the worse answer.
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

// The host `detectForge` dispatches on. A remote with no host (a `file://`
// mirror) names no forge, same as an unparseable one.
function remoteHost(remoteUrl: string): string | null {
  return parseRemoteRef(remoteUrl)?.host || null;
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

// [LAW:types-are-the-program] One remote exactly as git reports it: the name it
// is configured under and its raw URL. The browsable page is deliberately NOT a
// field here — it is a DERIVATION (`remoteWebUrl`), so the raw form stays the
// single stored territory and every consumer draws its own map from it.
export interface GitRemote {
  readonly name: string;
  // EVERY configured url, in config order. A remote genuinely has N of them
  // (a repo can fetch from a local mirror and push to a forge), and modelling
  // it as one was the lossy map: the discarded url was sometimes the only one
  // naming a forge, which cost both the repo link and the PR lookup.
  readonly urls: readonly string[];
}

// [LAW:effects-at-boundaries] Pure text→data over `git config --get-regexp
// ^remote\..*\.url$` stdout, so the accept/reject table is unit-testable without
// spawning git. Each line is `remote.<name>.url <url>`; the name capture is
// greedy so a dotted remote name (`remote.my.fork.url` → `my.fork`) keeps its
// dots. A line carrying no URL is a remote with no URL, the domain's own
// "none", not a parse failure.
//
// Every url under a name is KEPT, in config order — see GitRemote. Which one
// represents the repository is `identifyingUrl`'s decision, made where the
// answer is used rather than by discarding data here.
//
// The read this parses is scoped `--local` (see getRemotesAsync), which is what
// makes config order unambiguous: across merged scopes git lists system →
// global → local, so an unscoped read would put the LEAST specific url first.
// That precedence — not push-mirror ordering — is why the `git config --get`
// this replaced returned the last value.
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

// [LAW:one-source-of-truth] THE url that identifies a remote's repository, for
// every consumer that needs one — its display name, its web page, and the forge
// the PR lookup dispatches on. The first url a browser can open wins, else the
// first configured: a remote that fetches from a local mirror and pushes to a
// forge keeps its forge identity, which is the case that broke when only the
// first url survived.
//
// Deliberately ONE rule rather than "prefer a url detectForge recognizes" on
// top. A remote listing a self-hosted Gitea page before a GitHub url resolves to
// the Gitea page and gets no PR — a correct link and an honest absence, which
// beats two selection rules competing over which url is the "real" one.
function identifyingUrl(remote: GitRemote): string | null {
  return (
    remote.urls.find((u) => remoteWebUrl(u) !== null) ?? remote.urls[0] ?? null
  );
}

// [LAW:one-source-of-truth] THE remote that represents this repo. `origin` is
// git's own name for the canonical one, else the first configured. One
// selection, so a repo's NAME and its LINK can never describe two different
// repositories — before this, repoName read origin while repoWebUrl walked past
// an unbrowsable origin to another remote, rendering `backup` beside a link to
// someone else's `realname`.
//
// Note the selection ignores browsability on purpose: if origin is a local
// mirror, that mirror IS this repo, and the honest render is its name with no
// link. Linking to a different remote's page was the lie.
function pickRepoRemote(remotes: readonly GitRemote[]): GitRemote | null {
  return remotes.find((r) => r.name === "origin") ?? remotes[0] ?? null;
}

// The identifying url of the remote that represents this repo — the one answer
// repoName and repoUrl both project from.
export function repoRemoteUrl(remotes: readonly GitRemote[]): string | null {
  const remote = pickRepoRemote(remotes);
  return remote ? identifyingUrl(remote) : null;
}

// [LAW:one-type-per-behavior] The url the forge lookup dispatches on, which is a
// DIFFERENT question from which url identifies the repo: "what repository is
// this?" (name, page) versus "where do I ask about pull requests?". They answer
// the same in every single-url config — essentially all of them — and diverge
// only when a remote genuinely names two hosts, which is exactly where one
// answer cannot serve both.
//
// `detectForge` gates the entire PR lookup and returns ABSENT before `gh` or
// `glab` is spawned, so a browsable-but-unrecognized mirror listed first (a
// self-hosted Gitea before a GitHub url) would silently decide the branch has no
// PR. Prefer a url a forge CLI recognizes; fall back to the identifying url so a
// repo with no recognized forge still keys its cache on something stable.
export function forgeRemoteUrl(remotes: readonly GitRemote[]): string | null {
  const remote = pickRepoRemote(remotes);
  if (!remote) return null;
  return (
    remote.urls.find((u) => detectForge(u) !== null) ?? identifyingUrl(remote)
  );
}

// The repository's name as its identifying url spells it. Reads the PARSED path
// so the name and the page agree by construction — a raw-string regex disagreed
// with the link for a slashless scp remote (`git@host:repo.git`) and for a
// trailing-slash url, both of which fell through to the directory basename while
// the link resolved fine.
//
// A local-path remote (`/srv/mirrors/backup.git`) has no parsed path but does
// have a last segment, so the raw string is the fallback — the directory
// basename stays reserved for its documented case, a repo with NO remote.
export function repoNameFromUrl(url: string): string | null {
  const parsed = parseRemoteRef(url);
  const segments = (parsed?.path ?? url).split("/");
  const name = (segments[segments.length - 1] ?? "").replace(/\.git$/, "");
  return name || null;
}

// [LAW:parse-dont-validate] Parse a git remote into the page a browser can open,
// or nothing. The returned string IS the proof: it has been through the URL
// parser, carries an http(s) scheme, has had any credentials stripped, and names
// a repo path — so the render boundary links it without re-checking anything.
//
// [LAW:no-silent-failure] The whole accept/reject table, so no shape leaks:
//   https://host/o/r.git           → https://host/o/r
//   https://tok@host/o/r           → https://host/o/r     (credential DROPPED)
//   http://gitea.lan:3000/o/r.git  → http://gitea.lan:3000/o/r  (web port kept)
//   git@host:o/r.git               → https://host/o/r     (scp shorthand)
//   ssh://git@host:2222/o/r.git    → https://host/o/r     (ssh port DROPPED —
//                                     an ssh port says nothing about the web one)
//   git://host/o/r.git             → https://host/o/r
//   /srv/git/r.git · ../r · ""     → null  (names no host)
//   file:///srv/git/r              → null  (nothing serves it)
//   git@host:                      → null  (a host with no repo path)
//   C:/r.git · C:\r.git            → null  (a drive path, not host:path)
//
// [LAW:one-type-per-behavior] The ssh→https transposition is host-agnostic BY
// DESIGN. GitHub, GitLab, Gitea/Forgejo, Bitbucket, Codeberg and sr.ht are not
// six types to enumerate — they are six INSTANCES of one convention: the web UI
// lives at the same host and path as the ssh remote. A hostname allow-list could
// only ever recognize the hosted ones, and would be blind to every self-hosted
// forge, which is the case that needs this most. The symmetric cost is a bare
// `git@fileserver:/srv/x.git` yielding a link to a page that does not exist.
//
// Distinct from `detectForge` above, and deliberately not folded into it: that
// answers the strictly narrower "which forge CLI can answer a PR query", which
// needs a recognized product AND an installed binary. This needs only a web
// server. Two questions, two maps.
export function remoteWebUrl(raw: string): string | null {
  const ref = parseRemoteRef(raw);
  if (!ref) return null;

  // [LAW:dataflow-not-control-flow] The scheme is the ONLY discriminator, and it
  // answers with VALUES — the web scheme and the web port — rather than gating
  // whether work happens. The port is where the two arms genuinely differ: an
  // http(s) port is part of the address a browser needs (a self-hosted forge on
  // :3000), while an ssh port says nothing about where the web UI listens, so
  // the ssh arm answers "" rather than carrying 2222 into an https URL.
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

// The repo's browsable page: one projection of `repoRemoteUrl`, so it names the
// same repository `repoName` does. A repo whose identifying remote is a bare
// path or a file:// mirror — or which has no remotes — has no web home, and
// null says exactly that rather than borrowing another remote's page.
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
        // Fixed 7-char truncation is the display contract. `git rev-parse
        // --short` auto-lengthens on collision, but re-spawning it here to
        // recover that would undo this segment's whole point — one porcelain=v2
        // read instead of a fan-out. The sha is display-only (never a lookup
        // key), so a 7-char ambiguity in a >1M-object repo is cosmetic.
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
    // [LAW:one-source-of-truth] repoName and repoUrl are two projections of ONE
    // remotes read, so they can never disagree about origin and asking for both
    // costs exactly one spawn. A failed read fails both alike, by construction.
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
