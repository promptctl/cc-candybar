# Git state without spawning git

## The mechanism

Both projects answer the same question — how does a prompt get git state without paying for a
`git` process — and they answer it at different layers. gitstatusd is a resident process that
holds parsed state between requests. libgit2 is the library it holds that state *in*. Read
together they say something specific about which parts of the cost are avoidable and which are
not.

### gitstatusd: a resident process whose value is the state it keeps

The protocol is the least interesting part, and it is worth saying so plainly because it is the
part cc-candybar already has. A request is one line on stdin: an id, the directory, and two
flags, fields separated by ASCII 31 (`kFieldSep`), the record terminated by ASCII 30
(`kMsgSep`). `RequestReader::ReadRequest` (`src/request.cc`) buffers into a `std::deque<char>`
and `select()`s with a one-second timeout; the reply is the same id, a `1` for "have status",
then 27 positional fields written by `ResponseWriter` (`src/response.cc`), whose destructor
emits `id 0` if the request fell through — a response is guaranteed even on failure. The main
loop in `src/gitstatus.cc` is a bare `while (true)`: read a request, process it, repeat. One
request at a time. The idle timeout is not dead time — it is when the repo cache is swept
(`cache.Free(Clock::now() - opts.repo_ttl)`).

What makes it fast is three caches, at three grains, all keyed on cheap identity checks.

**The repository, keyed by git directory.** `RepoCache::Open` (`src/repo_cache.cc`) resolves the
request directory to a gitdir with `git_repository_discover_ex` — an in-process ascent, no fork
— and looks that gitdir up in an `unordered_map<std::string, unique_ptr<Entry>>` with an LRU
`multimap<Time, Cache::iterator>` beside it. A hit returns the live `Repo*`, which owns the
`git_repository`, its odb and refdb (both force-initialized at open to dodge libgit2's lazy-init
data races), and a `TagDb`. So a warm repo costs no opening, no ref-db construction, no
attribute-cache build.

**The parsed index, keyed by the index file's stat stamp.** `Repo::GetIndexStats`
(`src/repo.cc`) calls `git_index_read_ex(git_index_, 0, &new_index)` — the fork's version of
`git_index_read`, which reports through the out-param whether a reparse actually happened — and
drops both the cached HEAD oid and the derived `Index` only when it did. That flag is what the
design hangs on: the index of a large repo is megabytes of entries, and parsing it is a cost
`git status` pays on every invocation and gitstatusd pays once per actual index write.

**The derived directory tree, and a per-directory untracked cache.** `Index::InitDirs`
(`src/index.cc`) walks the in-memory index once and builds a vector of `IndexDir`, each holding
that directory's `git_index_entry*` files, its subdirectory names, and — the load-bearing field
— a `struct stat st` plus a `std::vector<const char*> unmatched` of the untracked paths last
seen there. `GetDirtyCandidates` then walks those dirs (sharded across a thread pool by weight,
`InitSplits`), and for each one `fstat`s the directory: if `StatEq(st, dir.st)` holds and the
untracked cache is trusted, it skips `readdir` entirely, `fstatat`s only the tracked files, and
replays the cached untracked list. Whether the untracked cache can be trusted is probed once per
repository, in the background, by `CheckDirMtime` — the parallel analogue of
`git update-index --test-untracked-cache`, stored as a `Tribool` so "not yet known" is a state
rather than a guess.

The file-level test that makes a clean repo cheap is `IsModified` (`src/index.cc`): a tracked
file is a dirty *candidate* only if its inode, stage, size, mtime or mode disagrees with the
index entry. Nothing is read, nothing is hashed. `StartDirtyScan` then hands only the candidate
paths to libgit2's diff, one at a time, via `opt.range_start`/`opt.range_end` plus a
single-string pathspec, so the diff never iterates the working tree — it confirms a shortlist.

That shortlist-then-confirm shape is the whole design: stat-only elimination in gitstatusd's own
code, and libgit2 used exclusively for the handful of paths that survived it.

### libgit2: the in-process index and status API, and what it does not have

`git_status_list_new` (`src/libgit2/status.c`) is three steps. It refreshes the index from disk
unless `GIT_STATUS_OPT_NO_REFRESH` is set, then builds two diffs — `git_diff_tree_to_index`
(HEAD vs index, the staged half) and `git_diff_index_to_workdir` (index vs working tree, the
unstaged and untracked half) — and pairs them with `git_diff__paired_foreach`. Every status
field a prompt wants falls out of those two diffs.

The refresh is the mechanism worth copying, conceptually. `git_index_read(index, 0)`
(`src/libgit2/index.c`) calls `git_futils_filestamp_check`, which compares mtime, size and inode
against the stamp recorded at the last parse and returns 0 when they match; on a match with
`force` unset, `git_index_read` returns immediately without touching the file. The index parse
is thus already elided across calls within one process — upstream behaviour, not a gitstatusd
invention. What upstream withholds is the *answer*: it returns 0 whether or not it reparsed, so a
caller holding state derived from the index cannot tell whether to throw that state away. That
one missing bit is `git_index_read_ex`'s entire reason for existing.

What upstream libgit2 does *not* have is an untracked cache. `read_extension`
(`src/libgit2/index.c`) recognises exactly three index extensions — `TREE`, `REUC`, `NAME` —
and falls through on anything else, so git's `UNTR` extension is never read and no fsmonitor
integration exists. Consequently `git_diff_index_to_workdir` walks the working tree every call,
and its per-file test `maybe_modified` (`src/libgit2/diff_generate.c`) compares stat data to the
index entry exactly as gitstatusd's `IsModified` does — with the honest comment beside the
assume-unchanged bit that it supports it "poorly, b/c we still stat everything."

That gap explains gitstatusd's shape and it is the fact that decides this proposal. gitstatusd
does not call `git_status_list_new` at all; it reimplements the walk, adds the untracked cache
libgit2 lacks, and calls libgit2 only for confirmation. It also does not build against upstream
libgit2: `build.info` pins a tarball from `romkatv/libgit2`, and of the symbols gitstatusd
calls, `git_index_read_ex`, `git_index_get_byindex_no_sort`, `git_repository_discover_ex`,
`GIT_DIFF_EXEMPLARS`, `GIT_DIFF_DELTA_DO_NOT_INSERT`, `GIT_DIFF_DELTA_SKIP_TYPE` and
`GIT_OPT_DISABLE_READNG_PACKED_TAGS` appear nowhere in libgit2 1.9.0's `include/` or `src/`.
The performance story is a fork's story, not the library's.

## Evidence

| Fact | Path | Lines | Excerpt |
|---|---|---|---|
| The wire framing is two ASCII control characters | `src/serialization.h` | 23-24 | `constexpr char kFieldSep = 31;  // ascii 31 is unit separator` / `constexpr char kMsgSep = 30;    // ascii 30 is record separator` |
| A request is an id, a directory and two flags | `src/request.h` | 27-32 | `struct Request {` / `  std::string id;` / `  std::string dir;` / `  bool from_dotgit = false;` / `  bool diff = true;` |
| A reply always exists; `1` means "with status" | `src/response.cc` | 42-45 | `ResponseWriter::ResponseWriter(std::string request_id) : request_id_(std::move(request_id)) {` / `  SafePrint(strm_, request_id_);` / `  Print(1);` |
| The daemon is one serial request loop | `src/gitstatus.cc` | 197-201 | `while (true) {` / `    try {` / `      Request req;` / `      if (reader.ReadRequest(req)) {` |
| The repo cache is swept on idle, not on a timer | `src/gitstatus.cc` | 208-209 | `} else if (opts.repo_ttl >= Duration()) {` / `        cache.Free(Clock::now() - opts.repo_ttl);` |
| Repositories are cached by gitdir with an LRU beside them | `src/repo_cache.h` | 43-44 | `using Cache = std::unordered_map<std::string, std::unique_ptr<Entry>>;` / `  using LRU = std::multimap<Time, Cache::iterator>;` |
| A cache hit returns the live repo and only touches LRU order | `src/repo_cache.cc` | 108-113 | `auto it = cache_.find(gitdir);` / `  if (it != cache_.end()) {` / `    lru_.erase(it->second->lru);` / `    it->second->lru = lru_.insert({Clock::now(), it});` / `    return it->second.get();` |
| Discovery is an in-process call, not a subprocess | `src/repo_cache.cc` | 39-40 | `int flags = from_dotgit ? GIT_REPOSITORY_OPEN_NO_SEARCH \| GIT_REPOSITORY_OPEN_NO_DOTGIT : 0;` / `  switch (git_repository_discover_ex(&gitdir_buf, &workdir_buf, NULL, NULL, dir, flags, nullptr)) {` |
| The index is reparsed only when the file actually changed | `src/repo.cc` | 147-153 | `if (git_index_) {` / `    int new_index;` / `    VERIFY(!git_index_read_ex(git_index_, 0, &new_index)) << GitError();` / `    if (new_index) {` / `      head_ = {};` / `      index_.reset();` |
| An unchanged HEAD skips the staged scan entirely | `src/repo.cc` | 181-184 | `} else if (head) {` / `    if (git_oid_equal(head, &head_)) {` / `      LOG(INFO) << "Index and HEAD unchanged; staged = " << Load(staged_)` |
| The derived directory tree is built once per index load | `src/repo.cc` | 216-218 | `if (!index_) index_ = std::make_unique<Index>(repo_, git_index_);` / `    dirty_candidates = index_->GetDirtyCandidates({.include_untracked = lim_.max_num_untracked > 0,` / `                                                   .untracked_cache = Load(untracked_cache_)});` |
| Untracked-cache eligibility is probed once per repo, in the background | `src/repo.cc` | 105-111 | `if (lim_.max_num_untracked) {` / `    GlobalThreadPool()->Schedule([this] {` / `      bool check = CheckDirMtime(git_repository_path(repo_));` |
| Each index directory carries its own stat and untracked list | `src/index.h` | 53-61 | `StringView path;` / `  StringView basename;` / `  size_t depth = 0;` / `  struct stat st = {};` … `std::vector<const char*> unmatched;` |
| A directory whose stat is unchanged skips readdir and replays cached untracked paths | `src/index.cc` | 237-240 | `if (opts.untracked_cache == Tribool::kTrue && StatEq(st, dir.st)) {` / `        StatFiles();` / `        for (const char* path : dir.unmatched) AddCandidate("new", path);` / `        continue;` |
| A tracked file is a candidate on a stat mismatch alone — nothing is read | `src/index.cc` | 96-98 | `COND(stage, GIT_INDEX_ENTRY_STAGE(entry) == 0) << "=> " << GIT_INDEX_ENTRY_STAGE(entry);` / `  COND(fsize, int64_t{entry->file_size} == st.st_size) << entry->file_size << " => " << st.st_size;` / `  COND(mtime, MTimeEq(entry->mtime, MTim(st))) << Print(entry->mtime) << " => " << Print(MTim(st));` |
| libgit2's diff is fed one candidate path at a time, never the whole tree | `src/repo.cc` | 298-302 | `for (auto p = paths.begin(); p != paths.end();) {` / `    opt.range_start = *p;` / `    opt.range_end = *p;` / `    opt.pathspec.strings = const_cast<char**>(&*p);` / `    opt.pathspec.count = 1;` |
| gitstatusd builds against a libgit2 fork, not upstream | `build.info` | 21-22 | `libgit2_version="tag-2ecf33948a4df9ef45a66c68b8ef24a5e60eaac6"` / `libgit2_sha256="4ce11d71ee576dbbc410b9fa33a9642809cc1fa687b315f7c23eeb825b251e93"` |
| gitstatusd is GPL-3, "or (at your option) any later version" | `LICENSE` + `src/repo_cache.h` | 1-2, 5-7 | `                    GNU GENERAL PUBLIC LICENSE` / `                       Version 3, 29 June 2007` — and `// GitStatus is free software: you can redistribute it and/or modify` / `// it under the terms of the GNU General Public License as published by` / `// the Free Software Foundation, either version 3 of the License, or` |
| libgit2 status = refresh index, then two diffs | `src/libgit2/status.c` | 296-298, 343-344, 353-354 | `/* refresh index from disk unless prevented */` / `	if ((flags & GIT_STATUS_OPT_NO_REFRESH) == 0 &&` / `		git_index_read_safely(index) < 0` … `if ((error = git_diff_tree_to_index(` / `				&status->head2idx, repo, head, index, &diffopt)) < 0)` … `if ((error = git_diff_index_to_workdir(` / `				&status->idx2wd, repo, index, &diffopt)) < 0) {` |
| An unchanged index file is not reparsed | `src/libgit2/index.c` | 713, 722-723 | `if ((updated = git_futils_filestamp_check(&stamp, index->index_file_path) < 0) \|\|` … `if (!updated && !force)` / `		return 0;` |
| The stamp that decides it is mtime + size + inode | `src/util/futils.c` | 1160-1166 | `if (stamp->mtime.tv_sec == st.st_mtime &&` … `stamp->size  == (uint64_t)st.st_size   &&` / `		stamp->ino   == (unsigned int)st.st_ino)` / `		return 0;` |
| libgit2 parses only three index extensions — no `UNTR`, so no untracked cache | `src/libgit2/index.c` | 45-47 | `static const char INDEX_EXT_TREECACHE_SIG[] = {'T', 'R', 'E', 'E'};` / `static const char INDEX_EXT_UNMERGED_SIG[] = {'R', 'E', 'U', 'C'};` / `static const char INDEX_EXT_CONFLICT_NAME_SIG[] = {'N', 'A', 'M', 'E'};` |
| libgit2 stats every file, by its own admission | `src/libgit2/diff_generate.c` | 843-845 | `/* support "assume unchanged" (poorly, b/c we still stat everything) */` / `	} else if ((oitem->flags & GIT_INDEX_ENTRY_VALID) != 0) {` / `		status = GIT_DELTA_UNMODIFIED;` |
| libgit2's per-file test is the same stat comparison gitstatusd's is | `src/libgit2/diff_generate.c` | 891-895 | `/* if the stat data looks different, then mark modified - this just` / `		 * means that the OID will be recalculated below to confirm change` / `		 */` / `		else if (omode != nmode \|\| oitem->file_size != nitem->file_size) {` / `			status = GIT_DELTA_MODIFIED;` |
| Repo discovery is an in-process parent ascent with explicit fs and ceiling bounds | `include/git2/repository.h` | 104-108 | `GIT_EXTERN(int) git_repository_discover(` / `		git_buf *out,` / `		const char *start_path,` / `		int across_fs,` / `		const char *ceiling_dirs);` |
| A stash count is the entry count of the `refs/stash` reflog | `src/libgit2/stash.c` | 1199-1202 | `if ((error = git_reflog_read(&reflog, repo, GIT_STASH_REF)) < 0)` / `		goto cleanup;` / `` / `	max = git_reflog_entrycount(reflog);` |
| libgit2 is GPL-2 only, with a linking exception | `COPYING` | 4-6, 10-14 | `Note that the only valid version of the GPL as far as this project` / ` is concerned is _this_ particular version of the license (ie v2, not` / ` v2.2 or v3.x or whatever), unless explicitly otherwise stated.` — and `			LINKING EXCEPTION` / `` / ` In addition to the permissions in the GNU General Public License,` / ` the authors give you unlimited permission to link the compiled` / ` version of this library into combinations with other programs,` |

Rows down to and including the GPL-3 row are relative to the gitstatus checkout at
`/tmp/peer3/git-state-without-subprocesses`, v1.5.5 per `build.info`. The rest — everything under
`src/libgit2/`, `src/util/`, `include/`, plus `COPYING` — are relative to the libgit2 checkout at
`/tmp/peer3/libgit2`, commit `0551dfd4ad989b6a3d5683c0d4cf326c6efef929`, version 1.9.0 per
`package.json`. Three excerpts carry `\|` where the source has a bare `|`, because an unescaped
pipe would split the table cell; nothing else is altered.

## What cc-candybar does today

The daemon already is gitstatusd's architecture. One resident process per user, a socket, a
length-prefixed frame, a cache keyed by repo identity, and an LRU with a sweep — that layer needs
nothing from either project. `GitDataProvider` (`src/daemon/cache/git.ts`) keys on the
*effective* git directory rather than the cwd (`getGitInfo`, line 250, resolving through
`resolveEffectiveGitDir` before it touches the cache), coalesces concurrent misses on one key
(`fetchInFlight`, line 165), serialises watcher-driven refreshes with a trailing-edge flag
(`refreshing`/`refreshAgain`, lines 183-184), and backs its `fs.watch` watchers with a five-minute
mtime walk (`runSanityCheck`, line 601) for filesystems where `fs.watch` silently no-ops. The
forge PR lookup already lives in its own cache with its own outcome-dependent TTL
(`getPullRequestCached`, line 360) precisely because a network fact deserves a different
lifecycle from a stat-watched local one. `WatcherRegistry` (`src/daemon/cache/watchers.ts`)
refcounts one watcher set per key and debounces at 50 ms.

Two places already do exactly what this mechanism is about — answer a git question without git.
`GitService.getOngoingOperation` (`src/segments/git.ts`, line 835) decides MERGE / CHERRY-PICK /
REVERT / BISECT / REBASE from five `fs.existsSync` probes inside the gitdir. `resolveGitDir`
(line 819) reads the `gitdir:` line out of a worktree's `.git` file rather than asking git where
it points. Both are the right instinct, and the proposal below is that instinct applied three
more times.

The core read is also already consolidated. `getCoreAsync` (line 1069) runs one
`git status --porcelain=v2 --branch` and `parseStatusV2` (line 522) folds branch, short SHA,
upstream, ahead/behind and all four worktree counts out of its stdout — replacing a fan-out of up
to six invocations, with the comment at line 1064 recording that. That is the same consolidation
gitstatusd performs, done with a subprocess instead of a library.

What remains is a spawn count per cache miss that nobody consolidated, because each piece looks
cheap on its own. `gitOptionsFromClosure` (`src/daemon/render-payload.ts`, line 815) turns the
layout's closure into `GitInfoOptions`; the bundled default's `gitaculous` segment reads
`git.sha`, the four worktree counts, `git.stash`, `git.upstream`, `git.repoName`,
`git.operation` and `git.timeSinceCommit`, so the live option set is seven flags. Walking
`computeGitInfo` (`src/segments/git.ts`, line 729) with those flags gives **four `git` processes
per cache miss**, and the remaining line numbers in this section are that file's:

1. `git status --porcelain=v2 --branch` — the core (line 1073).
2. `git log -1 --format=%ct` — `getTimeSinceLastCommitAsync` (line 881), run serially.
3. `git stash list` — `getStashCountAsync` (line 906).
4. `git config --local --get-regexp ^remote\..*\.url$` — `getRemotesAsync` (line 948).

`showOperation` costs nothing, and `showSha`/`showUpstream`/`showWorkingTree` ride the core call
for free. At the stated rate of roughly 200 git subprocesses a minute, that is about 50 cache
misses a minute — which for a 30 s TTL plus watcher invalidation on an actively edited repo is
unremarkable. The subprocess count is not being driven by an unreasonable miss rate. It is the
multiplier on each miss.

There is a fifth spawn on a path the cache cannot help at all. `findGitRoot` (line 695) runs
`git rev-parse --show-toplevel`, and its `absent` — "not in a git repository" — is returned by
the cache's `getGitInfo` (`src/daemon/cache/git.ts`, line 264) before any cache entry is written;
`doFetch`'s comment at line 314 of that file states the policy, that only `ok` is cached. So a session whose cwd is not inside a repo spawns `git`
once per render, forever, and never records anything. Every non-repo session contributes its full
render rate to the subprocess count.

One latent multiplier is worth naming even though it is not currently firing. Back in
`src/daemon/cache/git.ts`, the cache key is `${repoRoot}|${optionsKey(options)}` (line 276), and
`subscribe` fetches with its own `SUBSCRIBE_OPTIONS = { showSha, showStashCount }` (line 64)
rather than the render path's set. A
config that uses `kind: "git"` variables would therefore hold two entries per repo, and one
watcher fire would invalidate both and run two independent fetches. The bundled default declares
its git fields as `kind: "input"` (see the comment at `src/config/default-dsl-config.ts`, line
457), so today this costs nothing — but it is a second identity for one repo living in the key of
a cache whose header claims one entry per repo.

## The change

**Do not lift either implementation. Lift the principle, which the two checkouts state more
sharply than any benchmark would: the expensive part of status is the working-tree walk, and
everything else is a file read.** The concrete change is four edits to the Node daemon, needing
no Rust port, no native dependency and no licence decision. It cuts the per-miss spawn count from
four to one and removes the one unbounded per-render spawn.

**1. `src/segments/git.ts` — `findGitRoot` becomes a parent-directory ascent.** Replace the
`git rev-parse --show-toplevel` launch with a loop that walks from `workingDir` to the filesystem
root, `lstat`ing `.git` at each level, returning `ok(dir)` at the first hit (file or directory —
a worktree and a submodule both spell it as a file), `ABSENT` when the ascent exhausts, and
`failed` only on an errno that is not ENOENT or ENOTDIR. This *replaces* the subprocess and the
`classify(..., "absent")` call around it; the `Outcome<string>` contract is unchanged, so
`resolveEffectiveGitDir` (line 682), `computeGitInfo` (line 746) and both test overrides keep
working untouched. It is the same act libgit2 exposes as `git_repository_discover`, whose
`across_fs` and `ceiling_dirs` parameters are the honest statement of what an ascent has to
decide. Cite `[LAW:effects-at-boundaries]`: this is the pure-fs shape `getOngoingOperation` and
`resolveGitDir` already have, not a new kind of thing. The one fidelity loss is `GIT_DIR` /
`GIT_WORK_TREE` / `GIT_CEILING_DIRECTORIES` — and `execGitAsync` (line 659) passes
`{ ...process.env }`, the *daemon's* environment, so those variables already describe whichever
shell happened to spawn the daemon rather than the session being rendered. The ascent loses
nothing that is observable today. Observable difference: a non-repo session goes from one `git`
process per render to zero.

**2. `src/segments/git.ts` — the stash count is a reflog line count.** Replace
`getStashCountAsync`'s `git stash list` with a read of `<gitDir>/logs/refs/stash`: one line per
stash, ENOENT meaning zero. This is not an approximation — libgit2's own `git_stash_foreach` is
`git_reflog_read(GIT_STASH_REF)` followed by `git_reflog_entrycount`, and the existing code
already counts lines (`stashList.split("\n").length`, line 914), so the counting function
survives and only its input changes. Reflog messages cannot contain newlines, so the line count
and the entry count agree. Keep the three-state outcome: a read error that is not ENOENT is
`failed`, exactly as today, because `[LAW:no-silent-failure]` is what makes the current `classify`
call correct and a swallowed read error here would be the regression.

**3. `src/daemon/cache/git.ts` — the commit timestamp is cached by commit, not by clock.** The
answer to `git log -1 --format=%ct` for a given commit never changes, so it wants a
content-addressed cache and no TTL at all. Add a `Map<string, number>` keyed on the full HEAD oid
beside `prCache`, populated on miss from the existing `getTimeSinceLastCommitAsync` spawn. This
requires `parseStatusV2` (`src/segments/git.ts`, line 522) to keep the full `branch.oid` on
`CoreStatus` alongside the 7-char display form it currently truncates to — the comment at line
539 explains why display is truncated, and nothing there argues against carrying the full value.
The spawn then fires once per commit instead of once per 30 s window, and the derived
`timeSinceCommit` seconds are recomputed from the cached timestamp on every render, which is what
makes the seconds keep ticking without the spawn. This is the `prCache` pattern
(`[LAW:decomposition]`, cited at line 47) applied to a second fact with its own lifecycle,
except that this one's lifecycle is exact rather than a TTL guess.

**4. `src/daemon/cache/git.ts` — the remotes read is cached by `.git/config` mtime.** Memoise
`getRemotesAsync`'s result per gitDir against a `statSync` of `<gitDir>/config`, invalidating on
mtime change. Remotes change roughly never; today they are re-read on every miss. Deliberately
*not* proposed: parsing `.git/config` directly. `git config` honours `include` and `includeIf`,
so a hand-rolled INI parser is an enumeration gap with a wrong answer at the end of it, and the
mtime memo gets the same saving with none of that exposure — though note it will not see a remote
added through an included file whose own mtime changed, which is the honest edge and an argument
for keeping the spawn behind the memo rather than replacing it.

Together: four spawns per miss becomes one, plus one `git log` per new commit and one
`git config` per config edit. Against the stated 200/minute that is roughly 50/minute, and the
survivor is the one call whose work is irreducible.

**Why not the library route.** Linking an in-process git — libgit2 through a native addon, or a
Rust crate after a port — looks like it should take the count to zero, and it would. It would
also be slower per call in the repos that matter. `git status` can use git's `UNTR` untracked
cache and a filesystem monitor when the repo is configured for them; upstream libgit2 can use
neither at all — `read_extension` recognises `TREE`, `REUC`, `NAME` and nothing else — so
`git_diff_index_to_workdir` walks the tree every call and stats every file. gitstatusd is fast
*despite* that, by reimplementing the walk with its own untracked cache and using libgit2 only to
confirm a shortlist — and it does that against a pinned `romkatv/libgit2` fork, because seven of
the symbols it calls do not exist upstream. Reproducing its numbers therefore means writing an
untracked cache in cc-candybar, to recover a capability the one surviving `git status` spawn
already has available to it. If the Rust port lands and the
in-process route is revisited, the requirement to evaluate against is not "does it bind git" but
"does it have an untracked cache or a filesystem monitor"; a permissively licensed candidate
would have to come from the Rust ecosystem rather than from either of these two repos, and this
lane verified no such candidate.

**Also worth fixing, separately from the spawn count.** The option set in the cache key
(`src/daemon/cache/git.ts`, line 276) is a second identity for one repo. Keying on `repoRoot` alone, storing the field set the
entry was fetched with, and re-fetching only to widen it would collapse the render path and the
`subscribe` path onto one entry — `[LAW:one-source-of-truth]`, which the file's own header claims
at line 23. It buys nothing today because the bundled default uses `kind: "input"` git fields,
so it belongs in its own change, argued on correctness rather than on cost.

## Cost and risk

Changes 1–4 are small and independently landable. The ascent is maybe forty lines with an
accept/reject table worth writing down first — `.git` as a directory, `.git` as a file, a bare
repo (no work tree, so it must stay `absent` the way `--show-toplevel` does), a symlinked path, a
permission error mid-ascent, a filesystem boundary. Each of the other three is a cache or a file
read, and all four keep `Outcome`'s three states, so no caller or consumer changes shape. Test
cost is honest: the existing `findGitRoot` overrides in `test/daemon-git-cache.test.ts` and
`test/daemon-watchers.test.ts` stay valid, and each new behaviour wants a fixture repo rather
than a mock.

What breaks. The ascent is the only one with real behavioural risk, and it is git-fidelity risk:
any repo layout where git's answer and "nearest ancestor containing `.git`" differ now renders
differently, and the cases are `GIT_DIR`/`GIT_WORK_TREE` overrides and `core.worktree`. The first
two already do not reach the render path honestly; `core.worktree` does, and a repo using it will
resolve to the gitdir's parent rather than the configured work tree. That is a real regression for
a rare configuration, and it is the one part of this proposal a reviewer should push back on. The
mtime-memoised remotes read can go stale behind an `includeIf`. The commit-time cache cannot go
stale — a sha names one commit — but it does grow one entry per commit observed, so it needs the
same LRU bound `prCache` has (`evictPrIfNeeded`, line 402).

What it makes harder later. Two more facts move from "ask git" to "read a file" — the repo root
and the stash count — and a third, the remotes read, gains a dependency on `.git/config`'s mtime.
That is three new places encoding a `.git` layout assumption, on top of the four the code already
has: `getOngoingOperation`, `resolveGitDir`, and `watcherTargets` (`src/daemon/cache/git.ts`,
line 139), which already hardcodes `HEAD`, `index` and `refs/heads`. The kind of assumption is
not new; the specific paths — `.git` itself, `logs/refs/stash`, `config` — are. If the Rust port
later brings a real in-process git, all four changes become redundant and should be deleted
rather than kept beside it; writing them as thin, separately named readers rather than folding
them into `computeGitInfo`'s body is what makes that deletion clean.

## Licence verdict

Neither checkout's licence file contains an SPDX identifier; a grep of both trees for `SPDX`
finds none anywhere. Both identifiers below are therefore read off the licence text itself.

**gitstatusd: GPL-3.0-or-later.** `LICENSE` is the verbatim `GNU GENERAL PUBLIC LICENSE` /
`Version 3, 29 June 2007`, and every source header adds "either version 3 of the License, or (at
your option) any later version", which is what makes it `-or-later` rather than `-only`. The
maintainer refuses copyleft, so no line of gitstatusd source may be copied into cc-candybar; the
mechanism described above is reusable as an idea, and the only lawful route is a reimplementation
written from a description — which is what the Change section proposes, and why none of it is a
patch shaped like the excerpts above.

**libgit2: GPL-2.0-only WITH a linking exception.** `COPYING` says "the only valid version of the
GPL as far as this project is concerned is _this_ particular version of the license (ie v2, not
v2.2 or v3.x or whatever)" — hence `-only` — followed by a `LINKING EXCEPTION` granting
"unlimited permission to link the compiled version of this library into combinations with other
programs, and to distribute those combinations without any restriction coming from the use of
this file", with the GPL still covering modification and non-linked distribution. That exception
is narrower than it first looks for this project's purposes: linking libgit2 would be permitted,
but gitstatusd's performance depends on a *modified* libgit2, and modifications must be
published under GPL-2. Copying libgit2 source into cc-candybar is out either way; linking it is a
licence question the maintainer could answer yes to, and a technical question — the missing
untracked cache — that answers itself no.
