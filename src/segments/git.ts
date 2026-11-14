import type { LaunchResult } from "../proc/launcher";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome";
import type { Current } from "../utils/reading";

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

// [LAW:types-are-the-program] How the branch stands to its upstream, in git's
// own words: no upstream configured, an upstream whose ref is `gone` (deleted
// on the remote and pruned — porcelain v2 still names it in `branch.upstream`
// but prints no `branch.ab`), or one it tracks, where ahead/behind are known.
export type Tracking = "none" | "gone" | "tracked";

export function trackingOf(
  upstream: Outcome<string>,
  aheadBehind: Outcome<AheadBehind>,
): Outcome<Tracking> {
  if (upstream.kind === "absent") return ok("none");
  if (upstream.kind === "failed") return upstream;
  if (aheadBehind.kind === "failed") return aheadBehind;
  return ok(aheadBehind.kind === "ok" ? "tracked" : "gone");
}

// [LAW:types-are-the-program] Where a PR/MR stands, in one vocabulary for
// every forge. Each forge spells it its own way; its parser below is the one
// place that spelling becomes this.
export type PrState = "open" | "merged" | "closed";

// The branch's PR/MR in any state, as the forge CLI picks it for the branch —
// gh takes an open one if there is one, else the newest; glab's rule is
// unverified (see parseGitlabMr) — so a branch whose PR merged reads `merged`
// rather than as a branch that never had one. `number` and `url` are the
// click target; `head` is the commit the PR's branch pointed at.
export interface PullRequest {
  number: number;
  state: PrState;
  url: string;
  head: string;
}

// [LAW:types-are-the-program] The forge picks a PR by branch NAME, so a name
// reused after its PR merged or closed (a reopened ticket's branch) gets the
// old PR back. An open PR is the branch's whatever its head; a concluded one
// only while it still describes HEAD — once the branch moves off it, the work
// on it is new and has no PR yet. That PR is kept as `earlier` rather than
// dropped, so "the forge answered with an older use of this name" stays
// distinct from "the forge has no PR"; an unborn HEAD has no commit any PR
// could describe, and a HEAD that could not be read leaves the PR's owner
// unknown, which is the lookup failing.
export type BranchPr =
  | Outcome<PullRequest>
  | { readonly kind: "earlier"; readonly value: PullRequest };

export function prOfHead(
  pr: Outcome<PullRequest>,
  head: Outcome<string>,
): BranchPr {
  if (pr.kind !== "ok" || pr.value.state === "open") return pr;
  if (head.kind === "failed")
    return failed(`HEAD: ${head.reason}`, head.failedAt);
  return head.kind === "ok" && head.value === pr.value.head
    ? pr
    : { kind: "earlier", value: pr.value };
}

// [LAW:parse-dont-validate] Each forge's exact state words, and only those: a
// word not listed is a forge this reader does not understand, refused loudly
// rather than guessed. GitLab's `locked` is an MR mid-merge — not merged yet.
const GITHUB_PR_STATES: Readonly<Record<string, PrState>> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};
const GITLAB_MR_STATES: Readonly<Record<string, PrState>> = {
  opened: "open",
  locked: "open",
  merged: "merged",
  closed: "closed",
};

function prStateOf(
  cli: string,
  states: Readonly<Record<string, PrState>>,
  word: string,
): Outcome<PrState> {
  return Object.hasOwn(states, word)
    ? ok(states[word]!)
    : failed(`${cli}: unknown state ${JSON.stringify(word)}`, "parse");
}

// [LAW:types-are-the-program] One read of a repository. Every field past the
// core is an Outcome, so "this value is unknown because the fetch failed" is
// representable distinct from a real 0/""/basename — the states the old
// catch-and-substitute blocks erased. `absent` means the domain genuinely has
// none (no upstream, no stash); `failed` carries the reason to the consuming
// boundary, which owns the log effect. branch/status stay plain: a fetch that
// cannot determine them is a failed fetch, not a read. Every field is read on
// every pass, so none is ever "not asked".
export interface GitRead {
  branch: string;
  status: "clean" | "dirty" | "conflicts";
  aheadBehind: Outcome<AheadBehind>;
  // HEAD's full object id, absent on an unborn HEAD — what a PR's `head` is
  // compared against (`prOfHead`).
  head: Outcome<string>;
  workingTree: WorkingTree;
  sha: Outcome<string>;
  operation: Outcome<string>;
  // The last commit's committer date, epoch seconds — a fact of the repo;
  // its age is a fact of the draw that subtracts it.
  committedAt: Outcome<number>;
  stashCount: Outcome<number>;
  upstream: Outcome<string>;
  repoName: Outcome<string>;
  // The repo's browsable web page, derived from the same remotes read repoName
  // is. `absent` = the repo has no remote a browser can open (local-only, a
  // bare-path remote); `failed` = the remotes read itself failed.
  repoUrl: Outcome<string>;
}

// A read with its branch's PR composed onto it: the PR is its own source, on
// its own period, so a git pass never awaits the forge.
export interface GitInfo extends GitRead {
  // [LAW:no-silent-failure] The forge lookup's three outcomes are all kept
  // distinct here: `ok` is the branch's PR, `absent` is "this branch has none / no
  // forge / no forge CLI", `failed` is "the forge was asked but couldn't
  // answer" (auth, network, API error). The render boundary surfaces `failed`
  // as a VISIBLE marker — collapsing it to `absent` would make a transient
  // outage look like the PR vanished. `pending` = the branch's key is not
  // answered yet (a branch just checked out): never another key's answer, and
  // never drawn as one.
  pullRequest: Current<PullRequest>;
}

// The fields of one git read that carry an outcome. The PR is its own source,
// whose lookup logs its own failures.
type ReadField = {
  [K in keyof GitRead]: GitRead[K] extends Outcome<unknown> ? K : never;
}[keyof GitRead];

// [LAW:types-are-the-program] Every outcome field of a read, named as the
// payload names it: a field added to GitInfo is a compile error here until it
// is named, so no failure of it can go unlogged.
const READ_FIELD_NAMES: Record<ReadField, string> = {
  aheadBehind: "aheadBehind",
  head: "head",
  sha: "sha",
  operation: "operation",
  committedAt: "committedAt",
  stashCount: "stash",
  upstream: "upstream",
  repoName: "repoName",
  repoUrl: "repoUrl",
};

// [LAW:no-silent-failure] Every field of one read that git could not answer.
// The refresh that read them logs these once (src/daemon/cache/git.ts); a draw
// of the stored value never logs them again.
export function gitInfoFailures(info: GitRead): string[] {
  return (Object.keys(READ_FIELD_NAMES) as ReadField[]).flatMap((field) => {
    const outcome = info[field];
    return outcome.kind === "failed"
      ? [`git.${READ_FIELD_NAMES[field]}: ${outcome.reason}`]
      : [];
  });
}

// [LAW:dataflow-not-control-flow] One classifier for every git invocation.
// Whether a non-zero exit is the domain answering "there is none" (a commit
// that is not there to read, a config with no matching key) or a real failure is
// per-command knowledge — it enters here as data, not as a catch block at
// every callsite. Transport failures (timeout, spawn error, signal) are
// always `failed`: git did not answer.
export function classify(
  label: string,
  result: LaunchResult,
  // How this command spells "there is none":
  //   "absent" — ANY non-zero exit is the domain answer. `git log -1` of an oid
  //     the repo no longer holds exits 128 for that genuine absence, so a
  //     narrower rule would misread it as a failure.
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
  return failed(launchFailure(label, result), "read");
}

// [LAW:one-source-of-truth] The one spelling of a launch that did not answer —
// the bar's `git.prError` and the doctor's forge probe (src/doctor/edge.ts)
// report one launch in the same words.
export function launchFailure(
  label: string,
  result: Extract<LaunchResult, { ok: false }>,
): string {
  const detail = [
    result.reason,
    result.exitCode != null ? `exit ${result.exitCode}` : null,
    result.error ?? firstLine(result.stderr),
  ]
    .filter(Boolean)
    .join(", ");
  return `${label}: ${detail}`;
}

export function firstLine(s: string): string {
  return s.trim().split("\n", 1)[0] ?? "";
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

// [LAW:one-source-of-truth] The CLI each forge is asked through — the PR lookup
// here and the doctor's login probe (src/doctor/edge.ts) name it from this one
// table.
export const FORGE_CLI: Readonly<Record<ForgeName, "gh" | "glab">> = {
  github: "gh",
  gitlab: "glab",
};

// [LAW:single-enforcer] "The command is not installed": a spawn the OS refused
// with ENOENT. Every other spawn failure (EACCES, resource limits) is a CLI
// that is there but could not launch. The PR lookup reads this as "no forge
// integration" and the doctor as "not installed" — one rule for both.
export function isMissingCommand(result: LaunchResult): boolean {
  return (
    !result.ok &&
    result.reason === "spawn-error" &&
    /ENOENT/i.test(result.error ?? "")
  );
}

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
export function remoteHost(remoteUrl: string): string | null {
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

// [LAW:one-source-of-truth] The one read of a repo's remotes, as git arguments
// and the fold of their result — the PR cache's async read and the doctor's
// sync one (src/doctor/edge.ts) run the same command and read it the same way.
// Exit 1 is "no remotes" (an empty list); every other failure stays failed.
export const REMOTES_ARGS: readonly string[] = [
  "config",
  "--local",
  "--get-regexp",
  "^remote\\..*\\.url$",
];

// Never absent: no remotes is the empty list.
export function remotesOf(
  result: LaunchResult,
): Extract<Outcome<GitRemote[]>, { kind: "ok" | "failed" }> {
  const r = classify("git config --get-regexp remote url", result, 1);
  if (r.kind === "failed") return r;
  return { kind: "ok", value: r.kind === "ok" ? parseRemotes(r.value) : [] };
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

// [LAW:one-source-of-truth] THE url that says which repository a remote IS —
// the source of its display name and its web page, and nothing else. The first
// url a browser can open wins, else the first configured: a remote that fetches
// from a local mirror and pushes to a forge keeps its forge identity, which is
// the case that broke when only the first url survived.
//
// Forge dispatch is NOT this question and does not read this — see
// `forgeRemoteUrl`. Identity asks "which repository is this?", dispatch asks
// "where do I ask about pull requests?", and a remote naming two hosts has two
// different correct answers.
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
  // The raw branch must strip trailing separators the way `parseRemoteRef`
  // already does for the parsed one — otherwise `/srv/mirrors/backup.git/`
  // splits to a final empty segment and falls through to the directory
  // basename, which is reserved for a repo with NO remote.
  const segments = (parsed?.path ?? url.replace(/[\\/]+$/, "")).split("/");
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
  if (isMissingCommand(result)) return ABSENT;
  if (result.reason === "non-zero" && noPrPattern.test(result.stderr))
    return ABSENT;
  const detail = [
    result.reason,
    result.exitCode != null ? `exit ${result.exitCode}` : null,
    result.error ?? firstLine(result.stderr),
  ]
    .filter(Boolean)
    .join(", ");
  return failed(`${label}: ${detail}`, "read");
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
export interface CoreStatus {
  branch: string;
  status: "clean" | "dirty" | "conflicts";
  workingTree: WorkingTree;
  // Each an Outcome so "no upstream / unborn HEAD" (absent) stays distinct from
  // a value — the same three-state contract every on-demand field carries.
  aheadBehind: Outcome<AheadBehind>;
  // The FULL object id, absent on an unborn HEAD. Both a display sha and the
  // commit-timestamp cache key derive from this one value, so they cannot come to
  // disagree about which commit is HEAD [LAW:one-source-of-truth].
  oid: Outcome<string>;
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
  let oid: Outcome<string> = ABSENT;
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
        oid = v === "(initial)" ? ABSENT : ok(v);
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
    oid,
    upstream,
    workingTree: { staged, unstaged, untracked, conflicts },
  };
}

// `gh pr view --json number,state,url,headRefOid` → one JSON object.
export function parseGithubPr(stdout: string): Outcome<PullRequest> {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (e) {
    return failed(
      `gh pr view: unparseable JSON (${e instanceof Error ? e.message : String(e)})`,
      "parse",
    );
  }
  if (!isRecord(json))
    return failed("gh pr view: JSON is not an object", "parse");
  const { number, state, url, headRefOid: head } = json;
  if (
    typeof number !== "number" ||
    typeof state !== "string" ||
    typeof url !== "string" ||
    typeof head !== "string"
  ) {
    return failed("gh pr view: missing number/state/url/headRefOid", "parse");
  }
  const prState = prStateOf("gh pr view", GITHUB_PR_STATES, state);
  return prState.kind === "ok"
    ? ok({ number, state: prState.value, url, head })
    : prState;
}

// `glab mr view --output json` → one JSON object (iid / state / web_url / sha).
// NOTE: verified against glab's documented JSON shape, not runtime-exercised
// here (glab not installed on the dev machine) — the github path is the
// runtime-verified one.
export function parseGitlabMr(stdout: string): Outcome<PullRequest> {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (e) {
    return failed(
      `glab mr view: unparseable JSON (${e instanceof Error ? e.message : String(e)})`,
      "parse",
    );
  }
  if (!isRecord(json))
    return failed("glab mr view: JSON is not an object", "parse");
  const iid = json.iid;
  const state = json.state;
  const url = json.web_url;
  const head = json.sha;
  if (
    typeof iid !== "number" ||
    typeof state !== "string" ||
    typeof url !== "string" ||
    typeof head !== "string"
  ) {
    return failed("glab mr view: missing iid/state/web_url/sha", "parse");
  }
  const mrState = prStateOf("glab mr view", GITLAB_MR_STATES, state);
  return mrState.kind === "ok"
    ? ok({ number: iid, state: mrState.value, url, head })
    : mrState;
}
