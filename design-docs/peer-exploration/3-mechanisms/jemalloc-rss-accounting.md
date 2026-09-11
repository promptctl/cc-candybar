# Measuring the heap-versus-RSS gap instead of guessing at it

## The mechanism

jemalloc's answer to "why is RSS larger than what I allocated" is that it refuses to report one
number. It reports five, each the sum of a named set of pages, and it exposes two time constants
that move pages between those sets. The gap stops being a mystery because every byte of it has a
set it belongs to.

A jemalloc arena's page allocator (the `pac_t` in `include/jemalloc/internal/pac.h`) holds four
caches of previously-allocated extents, one per extent state: `ecache_dirty`, `ecache_muzzy`,
`ecache_retained`, `ecache_pinned`. A page's state is what the allocator has done to it since the
application stopped using it:

- **active** — backing a live allocation.
- **dirty** — freed by the application, still written-to, still costing physical memory. The
  allocator is holding it to satisfy the next request without a syscall.
- **muzzy** — purged with `madvise(MADV_FREE)` or equivalent: the kernel may reclaim it at any
  time, or may not have yet. Physically indeterminate.
- **retained** — virtual address space the allocator kept but decommitted. `pac_stats_t`'s comment
  is explicit that retained bytes "are technically mapped (though always decommitted or purged)"
  and are deliberately excluded from the mapped total.
- **pinned** — unused extents backed by non-reclaimable memory, excluded from decay entirely.

The five published totals are folds over those sets, and the two interesting ones are interesting
precisely because of what they leave out. `pa_shard_stats_merge` (`src/pa_extra.c`) builds
`resident` as active + dirty + pinned pages — **muzzy and retained are not in it** — while
`retained` is exactly the retained cache's page count shifted to bytes. So `resident` is an upper
bound on what the allocator is costing you in physical memory, and `retained` is the number that
looks like a leak in `vmmap` and is not one. `stats.allocated` is what the application asked for;
`stats.active` is those bytes rounded up to whole pages; `stats.mapped` is active extents excluding
retained.

Two `decay_t` objects per PAC schedule the transitions: `decay_dirty` (dirty → muzzy) and
`decay_muzzy` (muzzy → retained), governed by `dirty_decay_ms` and `muzzy_decay_ms`. The decay is
not a timer that frees everything at time T. Each `decay_t` keeps a `backlog[SMOOTHSTEP_NSTEPS]`
of how many unused pages were generated in each of the last N epochs, where an epoch is
`decay_ms / SMOOTHSTEP_NSTEPS`. `decay_backlog_npages_limit` multiplies each backlog entry by a
fixed-point smoothstep weight and sums, producing `npages_limit`: a per-epoch ceiling on how many
pages may remain in that state. A burst of frees decays along a sigmoid that starts and ends at
zero purge rate, so purging never spikes and never stops abruptly. Epoch deadlines carry uniform
jitter so arenas do not purge in lockstep.

Two values of the knob are special and are not points on that curve: `0` purges every unused page
immediately on creation, `-1` disables purging altogether. The defaults are 10 000 ms for dirty and
**0 for muzzy** — meaning the muzzy state is off by default, and `pac_decay_stashed` reads that as
`try_muzzy` false, which sets `purge_to_retained` true and sends dirty pages straight to retained,
skipping the middle state.

Every top-level `stats.*` value is produced by one fold, `ctl_refresh` in `src/ctl.c`, which clears
a summary arena and merges every initialised arena into it. Those values are **cached**: they do
not change until something writes the `epoch` mallctl. `stats_print` writes it as its first act,
which is why a stats dump is always self-consistent and why a bare `mallctl("stats.resident", …)`
against a long-lived process returns whatever the last refresh saw.

Reading the numbers out of a process you did not write takes no code. `opt.stats_print` installs an
`atexit` hook that calls `malloc_stats_print`, whose `opts` string is one character per section
(`J` for JSON, `g` general, `m` merged arenas, `a` unmerged, `e` extents, `x` mutexes …). The
human-readable summary is a single line printed by `stats_emit_global`: `Allocated: …, active: …,
metadata: …, resident: …, mapped: …, retained: …, pinned: …`.

On macOS the interposition is different from Linux and this matters for the procedure below.
jemalloc's public symbols are prefixed `je_` by default on Darwin, so it does not replace `malloc`;
it registers a `malloc_zone_t` and promotes it to default (`zone_register` in `src/zone.c`). That
constructor **bails out silently** unless the current default zone is named `DefaultMallocZone`, so
a process that already installed a custom zone gets no jemalloc and no warning. The prefix also
renames the environment variable: `JEMALLOC_CPREFIX` is the upper-cased prefix, and `src/conf.c`
reads `JE_MALLOC_CONF`, not `MALLOC_CONF`. The preload variable is `DYLD_INSERT_LIBRARIES`, and
`opt.retain` defaults to **on** for 64-bit Darwin — which is why `retained` is large on macOS and
`munmap` is rare.

## Evidence

All paths are relative to a checkout of `https://github.com/jemalloc/jemalloc` at
`ff80bf2d0c8f162ea445533354cad8b7e5830f5c` (2026-09-10).

| Fact | Path | Lines | Excerpt |
|---|---|---|---|
| `resident` is active + dirty + pinned pages; muzzy and retained are excluded by construction | `src/pa_extra.c` | 150-156 | `size_t resident_pgs = 0;` / `resident_pgs += pa_shard_nactive(shard);` / `resident_pgs += pa_shard_ndirty_no_pac_sec(shard);` / `resident_pgs += pac_sec_dirty_npages;` / `resident_pgs += ecache_npages_get(&shard->pac.ecache_pinned);` / `resident_pgs += pac_sec_pinned_npages;` / `*resident += (resident_pgs << LG_PAGE);` |
| `retained` is the retained extent cache's page count in bytes | `src/pa_extra.c` | 142-143 | `pa_shard_stats_out->pac_stats.retained +=` / `    ecache_npages_get(&shard->pac.ecache_retained) << LG_PAGE;` |
| Retained bytes are mapped but decommitted, and are kept out of the mapped total on purpose | `include/jemalloc/internal/pac.h` | 73-78 | `/*` / ` * Number of unused virtual memory bytes currently retained.  Retained` / ` * bytes are technically mapped (though always decommitted or purged),` / ` * but they are excluded from pac_mapped.` / ` */` / `size_t retained; /* Derived. */` |
| Two decay objects drive a three-hop state machine | `include/jemalloc/internal/pac.h` | 145-146 | `decay_t decay_dirty; /* dirty --> muzzy */` / `decay_t decay_muzzy; /* muzzy --> retained */` |
| Defaults are 10 s dirty, 0 muzzy | `include/jemalloc/internal/arena.h` | 30-32 | `/* Default decay times in milliseconds. */` / `#define DIRTY_DECAY_MS_DEFAULT ZD(10 * 1000)` / `#define MUZZY_DECAY_MS_DEFAULT (0)` |
| The purge budget is a smoothstep-weighted sum over a backlog of epochs, not a timeout (in `decay_backlog_npages_limit`) | `src/decay.c` | 102-106 | `	uint64_t sum = 0;` / `	for (unsigned i = 0; i < SMOOTHSTEP_NSTEPS; i++) {` / `		sum += decay->backlog[i] * h_steps[i];` / `	}` / `	size_t npages_limit_backlog = (size_t)(sum >> SMOOTHSTEP_BFP);` |
| 0 purges immediately, -1 disables purging | `doc/jemalloc.xml.in` | 1168-1169 | `zero purge rate.  A decay time of 0 causes all unused dirty pages to be` / `purged immediately upon creation.  A decay time of -1 disables purging.` |
| `muzzy_decay_ms == 0` collapses the middle state: dirty purges straight to retained | `src/pac.c` | 610-614 | `bool try_muzzy = !fully_decay` / `    && pac_decay_ms_get(pac, extent_state_muzzy) != 0;` / `bool purge_to_retained = !try_muzzy` / `    || ecache->state == extent_state_muzzy;` |
| The top-level totals are one fold over every arena, in `ctl_refresh` | `src/ctl.c` | 1452-1454 | `		ctl_stats->mapped = ctl_sarena->astats->astats.mapped;` / `		ctl_stats->retained = ctl_sarena->astats->astats.pa_shard_stats` / `		                          .pac_stats.retained;` |
| Stats are cached until the `epoch` mallctl is written; `stats_print` writes it first | `src/stats.c` | 114-117 | `epoch = 1;` / `u64sz = sizeof(uint64_t);` / `err = je_mallctl(` / `    "epoch", (void *)&epoch, &u64sz, (void *)&epoch, sizeof(uint64_t));` |
| `opt.stats_print` installs an atexit hook — no application code needed to get a dump | `src/jemalloc_init.c` | 190-192 | `	if (opt_stats_print) {` / `		/* Print statistics at exit. */` / `		if (atexit(stats_print_atexit) != 0) {` |
| The `opts` string is one letter per section | `include/jemalloc/internal/stats.h` | 10-13 | `#define STATS_PRINT_OPTIONS                                                    \` / `	OPTION('J', json, false, true)                                         \` / `	OPTION('g', general, true, false)                                      \` / `	OPTION('m', merged, config_stats, false)                               \` |
| The one-line summary format the procedure greps for | `src/stats.c` | 2347-2349 | `	    "Allocated: %zu, active: %zu, "` / `	    "metadata: %zu (n_thp %zu, edata %zu, rtree %zu), resident: %zu, "` / `	    "mapped: %zu, retained: %zu, pinned: %zu\n",` |
| On macOS jemalloc is a malloc *zone* overlay, prefixed `je_`, not a symbol replacement | `INSTALL.md` | 92-94 | `By default, the prefix is "", except on OS X, where it is "je_".  On OS X,` / `jemalloc overlays the default malloc zone, but makes no attempt to actually` / `replace the "malloc", "calloc", etc. symbols.` |
| The zone constructor silently declines if another allocator already owns the default zone | `src/zone.c` | 446-454 | `/*` / ` * If something else replaced the system default zone allocator, don't` / ` * register jemalloc's.` / ` */` / `default_zone = zone_default_get();` / `if (!default_zone->zone_name` / `    || strcmp(default_zone->zone_name, "DefaultMallocZone") != 0) {` / `	return;` / `}` |
| The prefix upper-cases into the config environment variable, so macOS reads `JE_MALLOC_CONF` | `configure.ac` | 1259 | `JEMALLOC_CPREFIX=\`echo ${JEMALLOC_PREFIX} \| tr "a-z" "A-Z"\`` |
| ...which `src/conf.c` reads as the env var name | `src/conf.c` | 367-371 | `		const char *envname =` / `#	ifdef JEMALLOC_PREFIX` / `		    JEMALLOC_CPREFIX "MALLOC_CONF"` / `#	else` / `		    "MALLOC_CONF"` |
| Darwin's preload variable, and `retain` on by default for 64-bit Darwin | `configure.ac` | 794, 802-804 | `LD_PRELOAD_VAR="DYLD_INSERT_LIBRARIES"` … `if test "${LG_SIZEOF_PTR}" = "3"; then` / `  default_retain="1"` / `fi` |

## What cc-candybar does today

`src/daemon/limits.ts` owns the only hard limit. `RSS_LIMIT_ENV` / `DEFAULT_RSS_LIMIT_MB = 512` /
`HEAP_CAP_OVER_RSS = 2` are declared at lines 34-36; `realLimitsDeps` supplies
`rssBytes: () => process.memoryUsage().rss` at line 194; `checkRss` (106-134) compares that one
number against the budget, and on breach writes `v8.writeHeapSnapshot`, rotates to the newest three,
and calls `shutdown(0)`. `describeNextRestart` (136-142) returns
`rss ${rss} approaching limit ${rssLimit}` above 75 %.

Three things here are right and should not be touched.

The **ordering** documented at lines 12-33 — graceful RSS backstop below, hard V8 abort above, the
cap derived as `HEAP_CAP_OVER_RSS × backstop` — is correct, and the measurements below put a number
on the margin it was asserting. On the maintainer's live daemon (pid 82023, 25 min uptime, 63 427
requests) `daemon-stats` reported `rssBytes 230457344`, `heapTotalBytes 122044416`: RSS runs about
100 MB above the V8 heap. The daemon is spawned `--max-old-space-size=1024`, so RSS reaches the
512 MB backstop when the heap is near 410 MB — about 600 MB before the hard cap. The graceful path
fires first, with a wide margin, exactly as the comment claims.

**RSS is the right thing to backstop on.** The kernel bills a process for resident pages, not for
V8's idea of its heap, and the 2026-09-03 outage was caused by the two limits being unrelated
literals, not by RSS being the wrong measure.

The **seam** is complete. `LimitsDeps` (75-93) injects the snapshot directory, the log sink, the
writer's pid and the clock, with the comment at 77-81 stating why: without them, unit tests write
real snapshots into the real daemon dir. Any new fact the death path wants to record has to arrive
through that interface, not by reaching for `process` or `child_process` inline.

`src/daemon/stats.ts` `snapshot()` (197-215) calls `process.memoryUsage()` once and publishes
`rssBytes`, `heapUsedBytes`, `heapTotalBytes`, `externalBytes`, `arrayBuffersBytes`;
`src/daemon/server.ts` (855-868) serves it on the `stats` request without bumping the request
counters. That is an honest record of everything Node can see.

The one real gap is at `limits.ts:126`. `v8.writeHeapSnapshot` is the sole artifact the backstop
leaves behind, and it can only describe the V8 half — which, on the live daemon, was 122 MB of a
230 MB RSS. If the backstop fires because the *other* 100 MB grew, the post-mortem artifact is
silent about the cause by construction.

## The change

**Verdict: do not lift jemalloc.** Not the decay knobs, not the stats, not as a dependency and not
as a preload on the spawn path. The reason is not licence or portability — it is that the mechanism
was run against this daemon and the number it names turned out to be the small one. What is worth
keeping is the accounting discipline, and the procedure that produced that answer — five minutes,
and it follows.

The procedure is seven steps. Steps 1-3 need nothing installed and run against the daemon that is
already up; steps 4-7 build jemalloc into a scratch directory and run a real cc-candybar daemon
under it. Every command below was executed on macOS 26.3, arm64, Node v26.7.0 (Homebrew), and the
outputs quoted are the ones it produced.

**1. Read the numbers the daemon already publishes.**

```
cc-candybar daemon-stats --json | grep -E 'rssBytes|heapTotalBytes|externalBytes'
```

Gave `rssBytes 230457344`, `heapTotalBytes 122044416`, `externalBytes 5982684`. The gap to explain
is 230 − 122 − 6 ≈ 102 MB. Note the daemon's pid from the same output.

**2. Attribute the whole process with `footprint`.** This is the step that does most of the work,
and it is a single command:

```
footprint -p <pid>
```

It printed a category table whose top rows were:

```
node [82023]: 64-bit    Footprint: 172 MB (16384 bytes per page)
  Dirty      Clean  Reclaimable    Regions    Category
 118 MB        0 B          0 B        473    app-specific tag 16
  30 MB        0 B        24 MB         22    MALLOC_SMALL
  20 MB        0 B          0 B          1    page table
  ...
 172 MB      43 MB        24 MB       3207    TOTAL
```

Read it as: 118 MB is V8's own mappings (it matches `heapTotalBytes` to within 4 MB), 30 MB is the
C++ side going through `malloc` — of which macOS already admits 24 MB is **Reclaimable**, its name
for jemalloc's *dirty* state — 20 MB is kernel page tables, which this process pays because its
virtual address space is enormous and mostly untouched (`ps -o vsz` reported 436 294 032 KB) — and
43 MB is clean file-backed code, counted in `ps` RSS but not in the footprint. Every part of the
102 MB gap now has a name, and none of them is a cache.

**3. Confirm the largest category is V8, not an allocator.** `vmmap` calls the same mappings
*Memory Tag 255* that `footprint` called *app-specific tag 16* — the two tools name VM tags
differently, and their sizes and region counts line up. Do not take either tag number on faith:
V8 heap pages are 256 KB, and the region-size histogram says so.

```
vmmap <pid> | grep '^Memory Tag 255 ' | grep -v reserved \
  | sed 's/.*\[ *\([0-9.]*[KMG]\).*/\1/' | sort | uniq -c | sort -rn | head
```

Gave `431  256K`, then `15  64K`, then two regions of `255.8M` and one of `128.0M`. 431 × 256 KB is
107 MB of V8 heap pages — no allocator produces a distribution like that. The three huge regions
are reservations rather than memory: the full `vmmap` lines show two of them with a resident size
of `0K` and permissions `---/rwx`, which is what address space held in reserve looks like and what
the 20 MB of page table is paying for.

At this point the question is usually answered. Continue only if step 2 showed the `MALLOC_*`
categories large enough to matter.

**4. Build jemalloc with stats (they are on by default).**

```
mkdir -p /tmp/peer3 && cd /tmp/peer3
git clone --depth 1 https://github.com/jemalloc/jemalloc jemalloc && cd jemalloc
./autogen.sh && make -j8 lib/libjemalloc.2.dylib
```

`autogen.sh` prints its configuration summary; check `stats : 1` in it. The build produced
`lib/libjemalloc.2.dylib` (740 KB) in about a minute. Nothing is installed system-wide.

**5. Smoke-test the preload on plain `node` before spending a daemon on it.** Three things can
silently defeat it — code signing, the zone guard at `src/zone.c:451`, and the `JE_` prefix on the
config variable — and this catches all three at once:

```
DYLD_INSERT_LIBRARIES=$PWD/lib/libjemalloc.2.dylib JE_MALLOC_CONF=stats_print:true \
  node -e 'const a=[];for(let i=0;i<2e5;i++)a.push({i,s:"x".repeat(50)});
           const m=process.memoryUsage();console.error("rss="+m.rss+" heapTotal="+m.heapTotal);'
```

Success looks like `___ Begin jemalloc statistics ___` on stderr, with
`Environment variable MALLOC_CONF: "stats_print:true"` inside the dump — that line is the proof the
`JE_`-prefixed variable was found. If the banner never appears, check `codesign -dv --verbose=4
$(readlink -f $(which node))`: this Homebrew build reports `flags=0x2(adhoc)` with no hardened
runtime and no library validation, which is why insertion is permitted. A `0x10000` (runtime) or
`0x2000` (library-validation) flag would block it and the whole approach is dead for that binary.
The other silent failure is the zone guard; confirm the default zone is still the system one with a
six-line C program calling `malloc_get_all_zones` — on this machine `zones[0] = DefaultMallocZone`,
so the guard passes.

**6. Run a real cc-candybar daemon under the library.** Keep the export, the spawn, the drive, the
read and the kill in **one** shell invocation — shell state does not survive between calls — and
give it a short isolated socket path, because a `CC_CANDYBAR_SOCKET` longer than ~104 characters
fails to bind silently:

```
mkdir -p /tmp/ccbv && chmod 700 /tmp/ccbv
export CC_CANDYBAR_SOCKET=/tmp/ccbv/s
DYLD_INSERT_LIBRARIES=/tmp/peer3/jemalloc/lib/libjemalloc.2.dylib JE_MALLOC_CONF=stats_print:true \
  node /Users/bmf/code/cc-candybar/dist/index.mjs daemon > /tmp/ccbv/out.log 2> /tmp/ccbv/je.log &
PID=$!
# wait for the socket, then drive N renders through bin/cc-candybar with a real hook payload
# read daemon-stats and footprint -p $PID here, while it is alive
kill -TERM $PID          # SIGTERM runs the atexit hook; SIGKILL loses the dump
grep -E '^Allocated:|opt\.(retain|narenas|dirty_decay_ms|muzzy_decay_ms)' /tmp/ccbv/je.log
```

After 60 renders that printed:

```
opt.retain: true
opt.narenas: 48
opt.dirty_decay_ms: 10000 (arenas.dirty_decay_ms: 10000)
opt.muzzy_decay_ms: 0 (arenas.muzzy_decay_ms: 0)
Allocated: 5362304, active: 9961472, metadata: 4940720 (...), resident: 16875520,
  mapped: 35192832, retained: 39256064, pinned: 0
```

against a `daemon-stats` of `rssBytes 101302272`, `heapTotalBytes 33701888`. Read it as:
**the entire malloc side of the daemon is 16.9 MB resident**, of which only 5.4 MB is live
application data and 4.9 MB is allocator metadata (48 arenas, because jemalloc sizes that from CPU
count, not thread count). The 39.3 MB of `retained` is address space with no physical backing — the
number that looks alarming in `vmmap` and costs nothing. RSS 101 MB − heap 34 MB − malloc-resident
17 MB leaves ~50 MB, which is the clean mapped code step 2 already identified.

**7. Bound the prize before tuning anything.** Re-run step 5 with decay disabled entirely, which is
the most aggressive setting that exists, and with a 4× larger JS heap:

```
for N in 2e5 8e5; do for C in stats_print:true stats_print:true,dirty_decay_ms:0,muzzy_decay_ms:0; do
  DYLD_INSERT_LIBRARIES=$PWD/lib/libjemalloc.2.dylib JE_MALLOC_CONF=$C \
    node -e "const a=[];for(let i=0;i<$N;i++)a.push({i,s:'x'.repeat(50)});
             const m=process.memoryUsage();console.error('rss='+m.rss+' heapTotal='+m.heapTotal);" \
    2>&1 | grep -E '^rss=|^Allocated:'
done; done
```

| JS objects | decay | node RSS | heapTotal | jemalloc `resident` | jemalloc `retained` |
|---|---|---|---|---|---|
| 200 000 | default (10 s / 0) | 129.6 MB | 76.3 MB | 13.5 MB | 14.3 MB |
| 200 000 | `0,0` (purge on free) | 128.3 MB | 76.3 MB | 9.5 MB | 23.5 MB |
| 800 000 | default | 314.0 MB | 249.0 MB | 16.6 MB | 20.2 MB |
| 800 000 | `0,0` | 306.8 MB | 249.0 MB | 7.9 MB | 28.8 MB |

Two readings, and they are the conclusion. Quadrupling the JS heap (76 → 249 MB) moved the
allocator's resident total by 3 MB: **V8's heap is invisible to `malloc`, and no allocator setting
can touch it.** And turning decay off entirely — the maximum this mechanism can ever pay — took
4.0 MB and 8.7 MB off the allocator's resident total, which showed up as 1.3 MB and 7.2 MB off the
process RSS: 1 % and 2 %. The same bytes moved into `retained`, where they are easy to mistake for
growth. `retained` rising when you purge *harder* is the most counter-intuitive line in the table,
and it is exactly why the two numbers are reported separately.

Two cc-candybar files are implicated by the finding, and only one of them changes.

**`src/daemon/limits.ts`** — one change, on the death path only. `checkRss` (106-134) currently
writes a V8 heap snapshot and nothing else, and steps 1-3 of the procedure above recover precisely
the information that snapshot cannot contain. Add a `captureMemoryReport: () => string` to
`LimitsDeps`, wired in `realLimitsDeps` (181-210) to run `footprint -p <pid>` (falling back to
`vmmap --summary <pid>`, and on a non-Darwin host to reading `/proc/self/smaps_rollup`), and write
its output beside the `.heapsnapshot` under the same rotation. It must be a **total** function
returning a string — including a string that says which probe was unavailable and why — never a
throw and never an empty file, because `[LAW:no-silent-fallbacks]` wants the reason recorded where
the post-mortem will look for it. It goes through `LimitsDeps` rather than being called inline for
the reason already stated in the comment at 77-81: a test of `checkRss` must not shell out against
the real process.

This replaces nothing. It closes a blind spot the existing artifact has by construction, and it is
the only durable form the jemalloc idea should take here: when the limit fires, record which set
the pages were in.

Two smaller edits in the same file. `describeNextRestart` (136-142) returns a string naming only
RSS; changing the injected `rssBytes` dep to return `{ rss, heapTotal }` — one read through one
seam, replacing the current dep rather than sitting beside it — lets that one warning line say
whether the growth is V8-side (a cache to fix) or not (something else entirely). And the comment at
lines 8-10 asserts that "normal operation should never approach" the limit without saying what the
floor is; the measurement gives it one, and it is worth writing down: roughly 50 MB of the daemon's
RSS is clean file-backed code and kernel page tables that no cache eviction can reach, so the
512 MB budget is really about 460 MB of controllable memory.

**`src/daemon/stats.ts`** — nothing changes, and the reason is worth stating because the obvious
move is wrong. There is no Node API for the malloc-side resident number, so it cannot be added
honestly; and a derived `gapBytes = rss - heapTotal - external` field would be arithmetic over three
numbers `snapshot()` (197-215) already publishes, which under `[LAW:one-source-of-truth]` belongs in
whoever reads the record, not in the record.

## Cost and risk

The procedure costs about five minutes and installs nothing: steps 1-3 use `footprint` and `vmmap`,
both already on the machine, and steps 4-7 leave a dylib in a scratch directory. Its only real
hazard is step 6, where a daemon spawned with a custom socket must be killed by the pid captured at
spawn — `pgrep` on the socket path does not find it — and killed with `SIGTERM`, because `SIGKILL`
skips the `atexit` hook and loses the dump you spent the setup on.

The `limits.ts` change costs one new field on `LimitsDeps`, one implementation in `realLimitsDeps`,
and a subprocess that runs **only** on the path where the daemon is already shutting down, so it
adds nothing to the per-render budget. Its risk is portability: `footprint` and `vmmap` are macOS
tools and `vmmap` here lives inside `Xcode.app`, so the dep must degrade to a recorded reason rather
than a failure. Changing `rssBytes` to return a pair touches every test that constructs `LimitsDeps`
by hand — a mechanical edit, but not a zero-line one.

What this makes harder later: very little, because the change is diagnostic capture and not a new
invariant. The thing that *would* make everything harder is the option this document is rejecting.
Preloading jemalloc into the production daemon means the Rust client's launch path (`rust-client/`,
mirrored against `src/daemon/limits.ts` through `scripts/check-protocol.mjs`) learns a macOS-only
environment variable; the daemon's memory profile then differs by platform; the 512 MB backstop is
calibrated against one allocator on macOS and another on Linux; and the zone-overlay guard at
`src/zone.c:451` means any future macOS change to the default zone turns the whole thing off with no
diagnostic. That is a permanent platform fork in the daemon's memory behaviour, bought for the
4-9 MB the table in step 7 measured.

One finding from the run deserves a ticket of its own, and it is not this one. jemalloc reported
`opt.narenas: 48` — it sizes arena count from CPU count, not thread count — and 4.9 MB of allocator
metadata to go with them, in a daemon that runs a handful of threads. The system allocator almost
certainly carries an analogous overhead and gives no way to see or change it. That is an argument
for the Rust port (`design-docs/RUST-PORT.md`), where the allocator is a build-time choice and
`narenas` is a build-time constant, rather than an argument for preloading anything into Node today.

## Licence verdict

**SPDX: `BSD-2-Clause`.** The checkout carries exactly one licence file, `COPYING`, 27 lines, and it
contains no SPDX tag — `grep -rn SPDX` over the whole tree returns nothing, which is why the GitHub
API reported NOASSERTION. The identifier is read off the clause text, which is the two-clause BSD
licence verbatim: lines 9-13 read `Redistribution and use in source and binary forms, with or
without / modification, are permitted provided that the following conditions are met: / 1.
Redistributions of source code must retain the above copyright notice(s), / this list of conditions
and the following disclaimer. / 2. Redistributions in binary form must reproduce the above copyright
notice(s),` followed by the standard disclaimer. There is no third clause, no advertising clause and
no linking exception. The preamble ("Unless otherwise specified…") allows for per-file exceptions;
no other `COPYING`/`LICENSE` file exists in the tree and no source file under `src/` or `include/`
carries a GPL, LGPL, MPL or Apache header.

Code may therefore be copied into cc-candybar with the copyright notice and disclaimer retained,
which satisfies the maintainer's MIT / Apache-2.0 / BSD / Zlib policy. Nothing here needed copying:
the deliverable is a measurement procedure, and the only cc-candybar change it motivates is written
from scratch.
