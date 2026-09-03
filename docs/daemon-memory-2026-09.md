# Daemon memory investigation, September 2026

The daemon's heap was full of duplicated helper ASTs, not transcripts. Every one of the ~287 templates a bundled-default config parses carried its own copy of the 12 bundled helpers' combined parse tree (~100 KB), so a single registered config cost 29.4 MB, and the render cache holding one config per open session multiplied that by ~20. Nothing in the transcript path was retained. The fix (go-template-js 0.8.0 plus cc-candybar PR #198) parses the helpers once per config and lets every template inherit them by link; the same daemon on the same machine went from 878 MB RSS to 186 MB.

## Symptom

With the maintainer's usual ~20 Claude Code sessions open, the daemon sat at ~630 MB heap / ~790 MB RSS within a minute of boot.

On 2026-09-03 it crash-looped. The spawners passed node a 400 MB V8 heap cap (`--max-old-space-size`) that sat below the daemon's own 512 MB RSS backstop, so V8 aborted first: a silent SIGABRT with no heap snapshot and no log line, before the backstop's 60 s poll ever ran. PR #197 hotfixed the ordering. The heap cap is now derived from the RSS budget (`HEAP_CAP_OVER_RSS = 2` in `src/daemon/limits.ts`, mirrored in `rust-client/src/launch.rs`), and the budget was raised to 2048 MB while the cause was still unknown.

## The wrong premise: transcript seeding

The standing belief was that transcript seeding, the daemon's one-time lazy read of the whole transcript tree in `src/daemon/cache/session-usage-store.ts`, was loading transcripts into memory. It is not. That path is a byte-cursor append fold that retains per-file scalars (cost, token and day sums plus a cursor) and never transcript text. It was audited and is not the retained set.

The decisive evidence is in the live stats below: on both pre-fix samples `usageCache.size` was 0. The daemon had seeded nothing at all and was already at 633 MB of heap. Whatever was filling the heap arrived before the first transcript was ever opened.

## Evidence

Three independent lines agree.

### 1. In-process measurement

Jest, with `v8.setFlagsFromString("--expose_gc")` and `vm.runInNewContext("gc")`: register N bundled-default configs after one warm-up registration, double-gc before and after, take delta / N.

| Configuration | Heap per registered config |
|---|---|
| Bundled default, with the 12 bundled helpers | 29.4 MB |
| Bundled default, helpers removed | 1.1 MB |

A stdlib config performs ~287 `engine.parse` calls (segment template/when/bg/fg, node when, action copy/open). The 12 bundled helpers total 2401 characters of source and parse to ~100 KB of AST.

### 2. Live `daemon-stats --json` on the pre-fix build

| Sample | Uptime | RSS | Heap used | usageCache.size | renderCache.size |
|---|---|---|---|---|---|
| First | 42 s | | 633 MB | 0 | 20 |
| pid 87039 | 69 min | 878 MB | 645 MB | 0 | 21 |

Prediction from the in-process figure: 20 configs × 29.4 MB = 587 MB. The 42 s sample measured 633 MB of heap with zero transcript seeding.

### 3. Live heap snapshot, daemon pid 52700

An 868 MB `.heapsnapshot` file, taken via SIGUSR1 and the inspector websocket, showed 590.8 MB of self size composed of:

| Kind | Self size | Count |
|---|---|---|
| Plain Objects | 274.5 MB | 5.8 million |
| Array element stores | 142.4 MB | |
| Arrays | 82.6 MB | |
| Small strings | 45 MB | 875 thousand under 1 KB |

Retainer chains end in `.pos`, `.args`, `.elements`, `.text` and `.raw`: the field names of go-template-js AST nodes. The RSS-breach snapshot the backstop wrote the previous day (2026-09-02) had the same composition.

## Mechanism

`compileHelperPreamble` in `src/dsl/render.ts` concatenated every helper into `{{ define "name" }}body{{ end }}` blocks and prepended that source string to every template the config parsed, because go-template-js scoped defines to a single parse unit. Every one of the ~287 templates therefore carried its own full copy of the helper AST.

The arithmetic:

- ~100 KB of helper AST × ~287 templates ≈ 29 MB per registered config
- one registered config per `(projectDir, cwd)` tuple in the daemon's RenderCache (LRU cap 256)
- ~20 open sessions ≈ 20 entries ≈ 590 MB of nothing but duplicated helper ASTs

## Fix

Two sides, one in each library.

**go-template-js 0.8.0** (promptctl/go-template-js PR #28): `engine.parse(src, inherit?: Defines)` and `Template.defines(): Defines`. A parse can inherit a define set by parent link, not by copying source. `Defines` is opaque; its public surface is `has` and `EMPTY`.

**cc-candybar** (PR #198, lit ticket brandon-daemon-memory-ir9): `compileHelpers` folds each helper from `Defines.EMPTY` into one shared `Defines`, each helper still parsed in isolation so a malformed helper gets a per-helper diagnostic, and the config's single parse closure becomes `engine.parse(src, helpers)`. Template calls resolve by name at evaluation against the executing template's full inherited set, so declaration order is irrelevant; `test/dsl-helpers.test.ts` pins this with a forward-reference test. `test/dsl-helpers-shared.test.ts` pins per-config heap under 4 MB (measured 1.22 to 1.24 MB across five runs).

The RSS budget returns to 512 MB (`DEFAULT_RSS_LIMIT_MB` in `src/daemon/limits.ts` and `rust-client/src/launch.rs`, and the README). The heap cap the spawner passes is 2× that, and the daemon logs both at boot:

```
daemon up: … heapCap=1120MB rssLimit=512MB
```

V8 reports its heap_size_limit including the young-generation reserve, hence 1120 rather than 1024.

## Before and after

In process, per stdlib config and for 20 configs:

| | Before | After |
|---|---|---|
| Per registered config | 29.4 MB | 1.2 MB |
| 20 configs | 587 MB | 24.7 MB |

Live production daemon, same machine, same ~20 sessions, `usageCache.size` = 0 in both samples:

| | pid | Uptime | RSS | Heap used | renderCache.size |
|---|---|---|---|---|---|
| Before | 87039 | 69 min | 878 MB | 645 MB | 21 |
| After | 21155 | 11 min | 186 MB | 52 MB | 20 |

## How to re-measure

In process: follow the recipe in `test/dsl-helpers-shared.test.ts`. Expose gc with `v8.setFlagsFromString`, invoke it with `vm.runInNewContext("gc")`, do one warm-up registration, double-gc, register N configs, double-gc again, divide the delta by N.

Live: `node dist/index.mjs daemon-stats --json` reports `rssBytes`, `heapUsedBytes`, `usageCache.size` and `renderCache.size`. `grep "daemon up" ~/.local/state/cc-candybar/daemon.log | tail -1` shows the budget and cap the running daemon booted with. For a heap snapshot, send the daemon SIGUSR1 and connect a script to the inspector websocket; the RSS backstop also writes one automatically on breach and keeps the newest 3 under `~/.local/state/cc-candybar/`.
