# Surviving a restart: snapshot the tree, ask what changed

## The mechanism

`@parcel/watcher` exposes two functions beside `subscribe`: `writeSnapshot(dir, snapshotFile)` and
`getEventsSince(dir, snapshotFile)`. You call the first just before your process exits and the
second when it next starts, and you get back the same `{path, type}` events a live subscription
would have delivered while you were gone. Both are declared as pure virtuals on `Backend`, so every
backend must answer the question — and the three that matter answer it three completely different
ways.

The **brute-force backend** is the one that literally snapshots a tree. Its state type is
`DirTree`, an `unordered_map<string, DirEntry>` where a `DirEntry` is a path, a nanosecond `mtime`,
and an `isDir` flag — no children pointers, no nesting; the tree is flat and the paths are absolute.
`DirTree::write` serialises it as a decimal entry count on its own line followed by one line per
entry, each `<pathLength><path><mtime> <isDir>` with no delimiter between the length and the path
(the length is what tells the reader where the path ends). `writeSnapshot` walks the directory once
via `fts_open`/`fts_read`, `add`s every node, and dumps that map to the file. `getEventsSince`
reconstructs a `DirTree` from the file with the `DirTree(root, FILE*)` constructor — `fscanf` the
count, then loop that many `DirEntry(FILE*)` reads — walks the directory again to get a live tree,
and calls `DirTree::getChanges`, which is two passes over two hash maps: a path in the live tree but
not the snapshot is a `create`, a path in both whose `mtime` differs (and which is a file on both
sides) is an `update`, and a path in the snapshot but not the live tree is a `remove`. That is the
whole diff. It costs one full directory walk plus one full deserialise, every time.

The **macOS backend does not snapshot a tree at all**. `FSEventsBackend::writeSnapshot` writes two
integers: `FSEventsGetCurrentEventId()` — the kernel's global monotonic FSEvents sequence number —
and `CLOCK_REALTIME` in nanoseconds. `getEventsSince` reads them back, stashes the timestamp as
`State::since`, and starts a real FSEvents stream at the saved event id instead of
`kFSEventStreamEventIdSinceNow`. macOS then replays its own on-disk event log into the ordinary
`FSEventsCallback`, and the replay terminates when a batch carries
`kFSEventStreamEventFlagHistoryDone`, at which point the callback calls `watcher->notify()` and
`getEventsSince` (parked in `watcher->wait()`) stops the stream and returns the accumulated
`EventList`. The saved wall-clock timestamp exists for one job: FSEvents coalesces flags, so a
replayed path with `ItemModified` set is ambiguous between create and update, and the backend
resolves it by comparing the file's `st_birthtimespec` against `since` — born before the snapshot
means update, born after means create. Note the asymmetry the `since` variable also selects: during
a replay the callback does **not** call `notify()` per batch (`if (!since) watcher->notify();`), so
one `since` value doubles as the "am I replaying history" flag.

The **watchman backend** is the same shape with an even smaller token: `writeSnapshot` asks the
watchman daemon for a `clock` string and writes just that; `getEventsSince` reads it back and issues
a `["since", dir, clock]` query, letting watchman's own index answer. Here the persisted state is
one opaque server-side cursor.

So "snapshot the tree" is only the fallback implementation. The real idea is a **resume token**: the
smallest durable thing that lets an external change-log answer "what happened since". When an
external log exists (FSEvents, watchman) the token is a sequence number and the snapshot file is a
few bytes; only when there is no log does it degrade to storing the whole tree and re-walking to
diff.

Two properties of the file are worth naming because a reader would otherwise assume they exist. The
snapshot carries **no format tag and no record of which directory it describes** — the root comes
from the caller's `watcher->mDir`, and a file written by one backend read by another silently
misparses (a brute-force entry count read as an FSEvents event id). And a **missing snapshot file is
not an error in two of three backends**: FSEvents and watchman both `if (ifs.fail()) return;`,
yielding zero events, which is indistinguishable from "nothing changed"; only brute force throws
`Unable to open snapshot file`.

## Evidence

| Fact | Path | Lines | Excerpt |
|---|---|---|---|
| Both functions are pure virtuals on `Backend`, so every backend must implement them | `src/Backend.hh` | 16-17 | `virtual void writeSnapshot(WatcherRef watcher, std::string *snapshotPath) = 0;` / `virtual void getEventsSince(WatcherRef watcher, std::string *snapshotPath) = 0;` |
| Each call is an async N-API promise runner around one backend call | `src/binding.cc` | 89-91 | `void execute() override {` / `backend->writeSnapshot(watcher, &snapshotPath);` / `}` |
| A snapshot entry is a path, a nanosecond mtime, and an isDir flag — a flat map, not a nested tree | `src/DirTree.hh` | 15-19 | `struct DirEntry {` / `  std::string path;` / `  uint64_t mtime;` / `  bool isDir;` / `  mutable void *state;` |
| The brute-force snapshot file is a count line followed by one line per entry | `src/DirTree.cc` | 113-120 | `fprintf(f, "%zu\n", entries.size());` / `  for (auto it = entries.begin(); it != entries.end(); it++) {` / `    it->second.write(f);` |
| The per-entry line is length-prefixed path + mtime + isDir, with no separator after the length | `src/DirTree.cc` | 162-164 | `fprintf(f, "%zu%s%" PRIu64 " %d\n", path.size(), path.c_str(), mtime, isDir);` |
| Reload is "read the count, then read that many entries", and marks the tree complete | `src/DirTree.cc` | 49-57 | `DirTree::DirTree(std::string root, FILE *f) : root(root), isComplete(true) {` / `  size_t size;` / `  if (fscanf(f, "%zu", &size)) {` / `    for (size_t i = 0; i < size; i++) {` |
| The diff is two hash-map passes producing create / update / delete | `src/DirTree.cc` | 126-140 | `if (found == snapshot->entries.end()) {` / `      events.create(it->second.path);` / `    } else if (found->second.mtime != it->second.mtime && !found->second.isDir && !it->second.isDir) {` / `      events.update(it->second.path);` |
| `getEventsSince` re-walks the live tree and diffs it against the deserialised snapshot | `src/shared/BruteForceBackend.cc` | 37-39 | `DirTree snapshot{watcher->mDir, f};` / `  auto now = getTree(watcher);` / `  now->getChanges(&snapshot, watcher->mEvents);` |
| The live tree comes from one `fts` walk that adds every node with its mtime | `src/unix/fts.cc` | 21, 45 | `FTS *fts = fts_open(paths, FTS_NOCHDIR \| FTS_PHYSICAL, NULL);` … `tree->add(node->fts_path, CONVERT_TIME(node->fts_statp->st_mtim), (node->fts_info & FTS_D) == FTS_D);` |
| The macOS snapshot is not a tree: an FSEvents sequence id plus a wall-clock nanosecond stamp | `src/macos/FSEventsBackend.cc` | 289-297 | `FSEventStreamEventId id = FSEventsGetCurrentEventId();` / `  std::ofstream ofs(*snapshotPath);` / `  ofs << id;` … `clock_gettime(CLOCK_REALTIME, &now);` / `  ofs << CONVERT_TIME(now);` |
| Replay = read the id back and start a real stream at it, then block until it finishes | `src/macos/FSEventsBackend.cc` | 306-317 | `FSEventStreamEventId id;` / `  uint64_t since;` / `  ifs >> id;` / `  ifs >> since;` … `startStream(watcher, id);` / `  watcher->wait();` |
| The replay ends on `HistoryDone`, which is what wakes the blocked call | `src/macos/FSEventsBackend.cc` | 90-92 | `if (isDone) {` / `      watcher->notify();` / `      break;` |
| The saved timestamp disambiguates create from update by comparing birth time against it | `src/macos/FSEventsBackend.cc` | 166-179 | `uint64_t ctime = CONVERT_TIME(file.st_birthtimespec);` … `if (isModified && (entry \|\| (ctime <= since && ctime != 0))) {` / `        state->tree->update(paths[i], mtime);` |
| The same `since` value doubles as the "replaying history" flag that suppresses per-batch notify | `src/macos/FSEventsBackend.cc` | 184-186 | `if (!since) {` / `    watcher->notify();` / `  }` |
| The watchman snapshot is one opaque server clock string | `src/watchman/WatchmanBackend.cc` | 248-249 | `std::ofstream ofs(*snapshotPath);` / `  ofs << clock(watcher);` |
| Watchman's replay hands the token straight back as a `since` query | `src/watchman/WatchmanBackend.cc` | 261-270 | `std::string clock;` / `  ifs >> clock;` … `cmd.push_back("since");` / `  cmd.push_back(normalizePath(watcher->mDir));` / `  cmd.push_back(clock);` |
| A missing snapshot file yields zero events, silently, on macOS and watchman | `src/macos/FSEventsBackend.cc` | 302-305 | `std::ifstream ifs(*snapshotPath);` / `  if (ifs.fail()) {` / `    return;` / `  }` |
| The brute-force backend throws for the same condition — the three backends disagree | `src/shared/BruteForceBackend.cc` | 32-35 | `FILE *f = fopen(snapshotPath->c_str(), "r");` / `  if (!f) {` / `    throw std::runtime_error(std::string("Unable to open snapshot file: ") + strerror(errno));` |
| The root is supplied by the caller, not read from the file — the file names no directory and no format | `src/shared/BruteForceBackend.cc` | 37 | `DirTree snapshot{watcher->mDir, f};` |

## What cc-candybar does today

The daemon watches a **fixed, named handful of paths**, not a tree. `watcherTargets`
(`src/daemon/cache/git.ts:139-153`) returns exactly `[gitDir/HEAD, gitDir/index]` as files plus
`refs/heads` as a directory when it exists; `RenderCache` watches the config-file candidate
locations. `WatcherRegistry.openWatchers` (`src/daemon/cache/watchers.ts:170-202`) puts one
`fs.watch` on each, coalesces every callback through a 50 ms debounce (`DEBOUNCE_MS`, line 25), and
— for directory targets — decides whether to fire by `Set.has(filename)` rather than a branch. There
is no question of the form "which paths under this root changed", so there is nothing for
`getEventsSince` to answer.

Where the daemon does maintain durable position, it already maintains exactly the resume token the
FSEvents backend persists — it just keeps it in memory. `TranscriptCursor`
(`src/utils/claude.ts:481-485`) is `{offset, mtimeMs, ino}`: a byte offset into an append-only file,
the mtime observed at that read, and the inode. `readAppended`
(`src/utils/transcript-fs.ts:181-183`) computes `reset` from that cursor — inode changed, or size
below the offset — which is precisely the "my prefix is no longer valid, re-read from zero"
judgement `DirTree::getChanges` makes structurally by re-walking. A `FileFold`
(`src/daemon/cache/session-usage-store.ts:171-177`) pairs that cursor with the running cost, token
breakdown and per-day buckets folded from the bytes before it, and `refold` (line 604) reads only
`[cursor, EOF)`. This is a strictly better shape than the brute-force backend's: one stat to decide
whether to read at all, then a read whose size is the appended bytes, against parcel's two whole-tree
walks per query.

The expensive cold path is the whole-tree seed. `SessionUsageStore.seed`
(`src/daemon/cache/session-usage-store.ts:636-681`) lists every project directory, stats every
`.jsonl`, drops anything older than yesterday midnight (`seedCutoffMs`, line 155), and ingests the
survivors eight at a time. On this machine that is **175 files and 201 MB**; a stripped benchmark
(read + `JSON.parse` per line, concurrency 8) completes in **1.7 s**, which is a lower bound — the
real seed additionally runs `makeEntry`, pricing lookups, day bucketing and sidechain discovery per
session. It runs at most once per day per daemon (`ensureSeeded`, line 621).

Three things about that cost are already right, and they are the reason the proposal below is a no.

First, **the seed is demand-gated and usually never runs**. `buildNeededPrefixes`
(`src/daemon/render-payload.ts:698`) computes the layout-reachable closure of input paths, and the
`today` lane is `lane("today", wants("today"), …)` (line 940). The bundled default declares
`today.cost`/`today.tokens` as variables but places neither `today` nor `session` in `root`
(`src/config/default-dsl-config.ts:1162-1192`), so the closure excludes them. The live daemon
confirms it: `daemon-stats --json` reports `usageCache: {size: 0, hits: 0, misses: 0, seeds: 0}`
after 62,976 requests. The 1.7 s cold cost is paid only by a config that puts a `today.*` segment on
the bar.

Second, **cold git is cheap and restarts are not the dominant cost**. `getCoreAsync`
(`src/segments/git.ts:1069-1083`) collapsed six spawns into one
`git status --porcelain=v2 --branch`. The live daemon measures that spawn at
`p50DurationMs.git: 27`, `p99: 95`, holds 27 cache entries, and shows 61,217 hits against 1,435
misses. Most of those misses are not cold start — `invalidations: 915` in 25 minutes of uptime, each
of which re-pays exactly the spawn a cold start pays. A restart costs roughly 27 spawns, under a
second of subprocess time, which normal branch and index churn spends again every couple of minutes.

Third, **shutdown is already the wrong place to add work**. `shutdown`
(`src/daemon/server.ts:591-616`) arms `setTimeout(() => process.kill(process.pid, "SIGKILL"), 500)`
*first*, before any cleanup, deliberately — the 452-daemon incident is documented in the comment
above it. Anything persisted at exit has under 500 ms and shares that window with
`gitService.close()`, `usageStore.close()`, `watcherRegistry.closeAll()` and `sessionState.flush()`
(lines 630-649). The RSS-breach path spends its own budget writing a heap snapshot before calling the
same funnel (`src/daemon/limits.ts:113-132`), and a `kill -9` or a V8 `SIGABRT` skips the funnel
entirely — so an exit-time write is missing in exactly the crash cases the proposal exists to serve.

## The change

**No cc-candybar files change. This mechanism should not be lifted, in either form.**

The tree-diff form answers a question the daemon never asks. `getEventsSince` produces a list of
changed paths under a root; the daemon's git watch set is the two or three named paths
`watcherTargets` returns, and its reaction to any of them is the same single call —
`this.invalidateRepo(repoRoot)` (`src/daemon/cache/git.ts:340`). Knowing *which* of HEAD or index
moved would not change one line of what happens next, so the entire event vocabulary
(`create`/`update`/`delete`) is information with no consumer. Adopting it would mean adding a native
dependency with per-platform binaries, a second watcher substrate beside `WatcherRegistry` — which
exists under `[LAW:single-enforcer]` precisely so that no module opens its own watchers — and a
snapshot file per watched root, to replace a `Set.has()` and a 50 ms debounce.

The resume-token form is the interesting one and cc-candybar has already built it, better. A
`TranscriptCursor` is the FSEvents snapshot's two integers specialised to one append-only file, and
`readAppended`'s `reset` is the validity check the snapshot format has no room for. The only thing
missing is durability: the cursor lives in a `Map` that dies with the process. So the honest version
of "lift this" is one narrow change — *persist the folds*, not the tree — and it is still a no today,
on cost and on correctness:

- The 1.7 s it would recover is paid by a minority of configs, at most once per day, off the first
  render of a `today.*` segment. The live daemon has paid it zero times.
- A `FileFold`'s sums include costs priced by `PricingService` against a hand-maintained rate table
  (`foldFile`, `src/daemon/cache/session-usage-store.ts:184-188`). A persisted fold pins the prices
  in force when it was written, and re-pricing it requires the raw entries the fold deliberately
  discards. The failure mode is a wrong number on the bar rather than a slow one, which is the worse
  trade under `[LAW:no-silent-fallbacks]`.
- Both of parcel's own failure behaviours would have to be rejected rather than copied: a missing
  snapshot silently yielding "nothing changed", and a file that records neither its format nor what
  it describes. cc-candybar's equivalent would need a typed `Outcome` and an identity stamp, so the
  code is not liftable even where the idea is.

If the seed ever does become the observed problem — a config with `today.*` on the bar and a daemon
restarting often enough that a daily 1.7 s matters — the shape to build is named here so nobody
re-derives it from parcel. It would touch three files, and would **not** write at shutdown:

- `src/daemon/cache/session-usage-store.ts` — serialise each `SessionRecord`'s `files` map
  (`FileFold` is already plain data: a cursor, counts, and a day map) after a successful `ingest`,
  and seed `this.entries` from that file in the constructor. A loaded fold is not trusted: its
  cursor goes straight into the existing `readAppendedEntries` call, whose `reset` arm re-folds from
  zero whenever the inode changed or the file shrank. This *replaces* nothing in the fold logic —
  it removes only the seed's need to start every record at offset 0.
- `src/daemon/session-state-file.ts` — reuse `FileSessionStorage`'s debounce-plus-atomic-write
  pattern (lines 32-43) for the new file. The write belongs on a debounce during normal operation,
  where a missed window costs one cold fold, not in `shutdown`, where the 500 ms SIGKILL and the
  crash paths make it unreliable exactly when it is needed.
- `src/daemon/paths.ts` — one more path under `$XDG_STATE_HOME/cc-candybar/`, alongside
  `sessionStatePath()` (line 155).

The observable difference would be: a daemon restarted mid-day, on a config that shows `today`,
renders that segment's real number on its first tick instead of after a 1.7 s whole-tree scan. That
is the entire prize, and it is not worth the price of a persisted cost total that can be wrong.

## Cost and risk

Lifting the package costs an `optionalDependencies` fan-out of prebuilt native binaries per platform
on top of the two cc-candybar already ships, a second watcher substrate that
`[LAW:single-enforcer]` forbids, and a snapshot file per watched root. It buys nothing: the four
paths the daemon watches need no tree diff. The risk is not that it breaks something — it is that it
becomes a second answer to "how does the daemon learn a file changed", and the next person to touch
invalidation has to reconcile two.

The narrow adaptation is cheaper to build — roughly a serialiser, a loader, and one more state file
— and its cost lands later. A persisted fold is a new cross-restart compatibility surface: change
`FileFold`'s shape, or the pricing table, and every fold on disk is either wrong or must be
discarded, which means every future change to the fold needs a version check that the in-memory map
never needed. That is the thing it makes harder to change, and the fold is code that has already
been rewritten once for performance (the byte-cursor rework).

The cheapest way to make cold start faster is not on this page at all: the seed's 201 MB is 175
files because the cutoff is "modified since yesterday midnight", and its purpose is a *today* total.
A tighter bound on what it reads is a change to `seedCutoffMs` and the reader, with no new file, no
new dependency, and no durable state to keep valid.

## Licence verdict

The checkout's `LICENSE` opens `MIT License` / `Copyright (c) 2017-present Devon Govett` and carries
the standard MIT permission grant verbatim (`Permission is hereby granted, free of charge, to any
person obtaining a copy of this software … to deal in the Software without restriction`). There is
no `SPDX-License-Identifier` line in the file; `package.json` records `"license": "MIT"`, and the
text is textually MIT, so the SPDX identifier is **MIT**. That permits copying code as well as
reusing the idea, subject to retaining the copyright and permission notice — but the recommendation
above means neither is being taken, so no attribution obligation arises.
