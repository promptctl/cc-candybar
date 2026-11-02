# Where the unit layer's time goes, November 2026

Answer to candybar-testing-ihvy.hf7 (plan ticket 6). Builds nothing. It feeds plan tickets 10 and 31.

Population: 307 test files, the in-process work of the `unit` and `worker` jest runs outside `test/daemon-boots/`, 1041.6 s of file time on CI. Sample: the slowest 31 (10%), 636.9 s, 61% of the population. Every time figure below is computed from the run artifacts by the scripts in the appendix; the named-case counts come from four readers' classification, which the Method describes and the sections below record.

## The answer

1. **Rendering is 40% of the sample's CI time, and compile is 24%.** Of the sample's 636.9 s, the split is rendering 255.6 s, product config parse and compile 149.8 s, waiting on timers, watchers and child processes 87.5 s, test bodies 43.7 s, other product code 34.8 s (mostly `src/themes` called directly by the exhaustive decor sweeps), loading modules 32.3 s, transpiling 7.9 s, GC and V8 internals 25.4 s. Transpile and module load together are 6% on a warm transform cache and 26% when every file starts cold and alone. CI sits between the two, because its jest cache starts cold and is then shared by every file; the independent bound is the CI record's time outside any case, which is 59.1 s (9%) for these files.
2. **Parse and compile of the product's config is the second-largest cost, and nine files pay at least 40% of their time in it.** `setting-drafts.test.ts` (82%), `threshold-colors.test.ts` (76%), `dsl-undo-redo.test.ts` (66%), `dsl-layout-edit.test.ts` (50%), `default-dsl-config.test.ts` (48%), `settings-config-menu.test.ts` (47%), `dsl-formatters-duration-time.test.ts` (46%), `dsl-loader.test.ts` (46%), `dsl-formatters-cost-token.test.ts` (45%) are those files. Eight of them build a rig from a parsed and validated config in each case (the readers' notes on each file are in the last sections); `dsl-loader.test.ts` tests the loader itself. The loader's reference scans (`src/config/loader/refs.ts` and `value-reads.ts`: `templateReads`, `scopedBlocks`, `dotRefs`, `templateBlocks`, `callGraphBlocks`, `actionTexts`) lead the compile bucket, 17.6 s of its 34.2 s on this machine, ahead of the json5 parse; no single function dominates. That is ticket 7's compiled-once-per-worker default.
3. **38% of the rendering is colour arithmetic inside `@promptctl/rich-js`.** `labOf` (oklch to Lab) alone is 19% of the render bucket's 59.4 local seconds, the largest single frame in it; `Oklch`, `Style`, `toRgba`, `fromRgba`, `ch`, `isByte` and `clamp` follow. The sweeps that draw a bar under every theme, depth and view (`palette-identity`, `colour-256`) are where it lands.
4. **343 cases in 11 of the 31 files render everything to assert one decision, and they hold 254.8 s of CI case time. Only 11.9 s of it has one pure function to move to today.** The rest, 242.9 s, asserts a decision that no function under `src/` makes alone: the seam is missing, so ticket 31 cannot shrink those sweeps until the decision is cut out. The seams are in the table below.
5. **6 of the 31 files spend 30% or more waiting, not computing**: demo.test.ts (100%), var-sources.test.ts (95%), integration/quarantine-gate.test.ts (99%), update-act.test.ts (96%), plugin-sources.test.ts (40%), frame-feed.test.ts (86%). Waiting is idle time on timers, watchers and sockets, or a thread blocked on a child it started (`spawnSync`). Neither rendering nor compile accounts for it, and a faster pure function would not shorten it. `proc/launch-group-end.test.ts` is the same kind of cost under another bucket: its 71% "test" share is a deliberate busy-spin (`while (Date.now() < until)` in "reads what a member wrote just before the group ended") that blocks the event loop to reproduce a race, and its 27% wait is child-process lifetimes. The profile counts the spin as the test's own frames, so the 6-file list and the 87.5 s wait total leave it out.
6. **2 files spend over half their time outside any case**: `dsl-loader.test.ts` (9.9 s on CI, 1.6 s in its cases, 0.724 s locally warm); `unit/doctor-checks.test.ts` (8.3 s on CI, 0.1 s in its cases, 0.339 s locally warm). Their cases are the whole of what they test. For `unit/doctor-checks.test.ts` the profile puts 89% of the file in transpile and module load, so what remains is loading its source graph on CI's cold cache, which the local warm run does not pay. `dsl-loader.test.ts` is split by the profile into 46% compile and 45% transpile and load; which part runs in its two `beforeAll` hooks is not established here.

### The seams a named case is waiting for

| Decision | Cases | Files | CI case time (s) |
|---|---|---|---|
| drawn colour of a cell | 179 | 4 | 176.7 |
| picker row budget against the painted width | 33 | 2 | 41.6 |
| default-config helper templates run without a bar | 92 | 3 | 19.5 |
| pure function exists | 26 | 6 | 11.9 |
| other single-site folds | 13 | 3 | 5.2 |

Case time is from the latest of the five runs (`41476365861`); file time elsewhere is the five-run mean, so a file's named time can exceed its mean.

### The plan's CPU-heavy claims

The plan's baseline named `palette-identity` 97 s, `default-dsl-config` 54 s, `plugins` 52 s and `decor` 46 s. On the last five green runs they are palette-identity 84.2 s (rank 1), default-dsl-config 45.1 s (rank 3), plugins 47.7 s (rank 2), decor 33.3 s (rank 5). The four are still among the five slowest. The plan's figures came from one earlier run and these are means of five, so the sizes differ without saying the files changed. `plugins` is seen in 1 of 5 runs: #578 moved it, so its mean is that run's.

### What it means for tickets 10 and 31 (the author's reading)

- **Ticket 31 starts with seams, not with shrinking sweeps.** 242.9 s of case time sits in sweeps whose decision no function owns. The largest is the drawn colour of a cell (176.7 s in 4 files): a function from a cell's roles, the palette and the depth to its drawn colours would carry all of it. The 11.9 s with a function already is the part that can move first.
- **An exhaustive test on a pure function is not free.** `unit/decor.test.ts` renders nothing and takes 33.3 s on CI, 50% of it in decision code. The budget in ticket 31 has to count the exhaustive tests it adds.
- **Ticket 10's rigs are most of the compile bucket.** 149.8 s of the sample parses and validates config, in 9 files at 40% or more, eight of which build a rig per case. A compiled default built once per worker takes it out of every case that does not test the loader; `dsl-loader.test.ts`, the ninth, tests the loader and does not gain from it.

## Method

**Population and ranking.** `rank.mjs` reads the `test-records` artifact of the last five green Release runs on main (`41476365861`, `41471161745`, `41468564307`, `41468294885`, `41461618355`). The population is every file in the latest run's `unit` and `worker` records whose layer is not `daemon-boots`; a daemon-boot file is the daemon's cost, which ticket w13 and the boot ratchet already carry. A file's time is its mean `durationMs` over the runs it appears in (a moved file appears in fewer), and the slowest ceil(n/10) are the sample.

**Profile.** `run-profiles.sh` runs each sampled file alone, twice, under `node --cpu-prof`, in its own jest cache directory: once on the empty directory, which is how CI starts (cold), and once on the directory that run filled (warm). One file at a time, so no profile is slowed by another. An empty test file, profiled the same way, is jest's own boot (0.5 s cold, 0.4 s warm) and is subtracted bucket by bucket from every profile; the empty file's own 71 ms is inside CI's file time and is subtracted with it, which is below the resolution of any row.

**Buckets.** `analyze.mjs` puts each profile sample in exactly one bucket, by the frames on its stack and not its leaf alone, because a helper called from the loader is the loader's cost and a colour library called from a test's own assertion is the test's. The rules are in the script. In order: V8 pseudo-frames and idle or blocked-on-a-child time (`wait`, `gc`, `program`); transpiling (`transform`: typescript, ts-jest, @jest/transform, source maps anywhere in the stack); module load (`load`: outside a test or hook, a module is being required or evaluated); config parse and compile (`compile`: inside `src/config/dsl-loader.ts` or `src/config/loader/`); rendering (`render`: inside `src/render`, `src/dsl`, `src/segments`, `src/template-engine` or `src/band`); other product code (`product`); everything left is the test (`test`: the test's own frames, helpers, assertions, and libraries it calls directly). "Parse and compile" in the ticket's terms is `transform` + `load` + `compile`, and the tables keep the parts apart.

**Attribution to CI.** The local profile gives proportions; each file's CI mean is split in them (`aggregate.mjs`). That treats a timer wait as stretching with the machine, which it does not, so a wait-bound file's CI split leans toward waiting by a few seconds. The local-to-CI time ratio is printed per file (jest's own "Time" line, cold and warm) so the reader sees how far the machine differs: the CI mean is 0.8 to 4.9 times the local cold time for the compute-bound files and 0.9 to 3.1 times for the wait-bound ones.

**Named cases.** Four readers each took a quarter of the files, read each test and the `src/` it reaches, and named a case only when its assertion is settled by one pure function under `src/` (kind `pure-function`) or when it renders to assert a decision no single function makes (kind `no-single-function`), giving the function or the place the decision is made and the line where the render is reduced to the asserted value. The author then checked, by `check-refs.mjs`, that every `src/` file they named exists and contains the symbol's name as text (40 references). That does not show the symbol is declared there, exported, or pure: a word in a comment passes. For the claims that drive a conclusion the author read the code instead: that `namedRoleText` is not exported, that `paginate`, `ringAround` and the decor functions are, that `reported` in `check.ts` is a closure, and the quiet-text sweep below. Purity and exports of the other named functions (`cliConfigTarget`, `placeInserts`, `relativeTimeFuncs` and the rest) rest on the readers' reading and were not re-derived, and neither were the other cases' claims. The readers' classification files are not kept in the repository; the named-case sections below are their record. A case is in the table only if its title was read against its assertion; a file with none says what its time is.

## Per-file split

Times in seconds on CI (mean of the runs the file appears in). "Outside cases" is the file's time less its cases', which is load, setup and describe bodies. "Local cold / warm" is jest's time on this machine. The split columns are the warm profile's proportions of the file's CI time; the last column is the cold profile's transpile plus module load, which is the upper bound for that part.

| File | CI s | Cases s | Outside cases s | Local cold / warm s | Render | Compile | Other product | Test | Wait | Transpile + load | GC etc. | Transpile + load, cold |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| palette-identity.test.ts | 84.2 | 83.5 | 0.6 | 21.186 / 19.736 | 88% | 2% | 1% | 6% | 0% | 2% | 2% | 9% |
| plugins.test.ts | 47.7 | 38.1 | 9.6 | 9.81 / 8.193 | 51% | 30% | 4% | 2% | 4% | 3% | 6% | 18% |
| default-dsl-config.test.ts | 45.1 | 36.5 | 8.6 | 10.944 / 8.778 | 40% | 48% | 1% | 1% | 0% | 4% | 6% | 22% |
| doc-snippets.test.ts | 39.5 | 38.9 | 0.6 | 10.527 / 9.269 | 65% | 24% | 3% | 1% | 1% | 3% | 5% | 17% |
| unit/decor.test.ts | 33.3 | 27.7 | 5.6 | 10.218 / 9.147 | 7% | 0% | 50% | 38% | 0% | 2% | 3% | 9% |
| colour-256.test.ts | 30.1 | 29.7 | 0.5 | 8.627 / 6.768 | 67% | 18% | 3% | 4% | 0% | 4% | 4% | 22% |
| settings-config-menu.test.ts | 27.6 | 26.9 | 0.7 | 8.159 / 6.635 | 35% | 47% | 6% | 1% | 0% | 5% | 7% | 26% |
| threshold-colors.test.ts | 26.4 | 25.8 | 0.6 | 9.627 / 6.613 | 9% | 76% | 0% | 2% | 0% | 10% | 4% | 29% |
| picker-pagination.test.ts | 25.0 | 24.6 | 0.5 | 11.537 / 5.806 | 80% | 2% | 1% | 10% | 0% | 5% | 2% | 57% |
| theme-carousel.test.ts | 24.4 | 23.9 | 0.5 | 17.073 / 7.219 | 50% | 20% | 2% | 19% | 0% | 4% | 5% | 59% |
| demo.test.ts | 21.3 | 21.2 | 0.1 | 9.921 / 9.604 | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% |
| var-sources.test.ts | 18.8 | 12.5 | 6.3 | 12.067 / 11.229 | 0% | 0% | 1% | 1% | 95% | 2% | 1% | 9% |
| daemon-render-cache.test.ts | 17.7 | 16.9 | 0.9 | 6.453 / 4.895 | 19% | 39% | 13% | 1% | 17% | 5% | 6% | 27% |
| proc/launch-group-end.test.ts | 16.0 | 15.9 | 0.1 | 21.089 / 21.015 | 0% | 0% | 1% | 71% | 27% | 0% | 1% | 0% |
| plugin-templates.test.ts | 14.9 | 14.4 | 0.5 | 6.012 / 4.185 | 62% | 23% | 4% | 1% | 0% | 5% | 5% | 29% |
| cli-check.test.ts | 13.7 | 13.3 | 0.4 | 6.345 / 4.22 | 49% | 22% | 4% | 1% | 13% | 6% | 4% | 27% |
| integration/quarantine-gate.test.ts | 13.0 | 12.9 | 0.1 | 4.169 / 3.631 | 0% | 0% | 0% | 1% | 99% | 0% | 0% | 1% |
| dsl-layout-edit.test.ts | 12.8 | 12.0 | 0.8 | 5.102 / 3.412 | 19% | 50% | 11% | 1% | 2% | 10% | 6% | 39% |
| render-cache-sharing.test.ts | 11.7 | 11.1 | 0.6 | 4.355 / 2.434 | 31% | 28% | 10% | 2% | 0% | 15% | 14% | 48% |
| update-act.test.ts | 11.2 | 10.7 | 0.5 | 11.942 / 10.399 | 0% | 0% | 0% | 0% | 96% | 3% | 1% | 14% |
| plugin-sources.test.ts | 10.6 | 10.1 | 0.5 | 6.122 / 4.298 | 25% | 17% | 5% | 2% | 40% | 6% | 4% | 32% |
| dsl-undo-redo.test.ts | 10.0 | 9.5 | 0.5 | 4.339 / 2.672 | 9% | 66% | 9% | 1% | 0% | 11% | 4% | 44% |
| dsl-loader.test.ts | 9.9 | 1.6 | 8.3 | 2.479 / 0.724 | 0% | 46% | 0% | 5% | 0% | 45% | 4% | 81% |
| dsl-formatters-duration-time.test.ts | 9.6 | 9.2 | 0.4 | 3.752 / 2.242 | 34% | 46% | 0% | 1% | 0% | 11% | 8% | 44% |
| frame-feed.test.ts | 9.6 | 8.9 | 0.7 | 10.994 / 9.164 | 0% | 0% | 9% | 1% | 86% | 3% | 1% | 18% |
| config-layers.test.ts | 9.5 | 9.1 | 0.3 | 4.498 / 2.738 | 47% | 31% | 4% | 3% | 0% | 11% | 5% | 43% |
| setting-drafts.test.ts | 9.0 | 8.5 | 0.4 | 3.378 / 2.214 | 0% | 82% | 3% | 1% | 0% | 10% | 4% | 45% |
| session-views.test.ts | 9.0 | 8.5 | 0.4 | 3.887 / 2.141 | 37% | 28% | 10% | 2% | 1% | 15% | 7% | 47% |
| placement-effect.test.ts | 8.6 | 7.9 | 0.7 | 3.927 / 2.096 | 53% | 22% | 1% | 4% | 0% | 15% | 5% | 52% |
| dsl-formatters-cost-token.test.ts | 8.6 | 8.1 | 0.5 | 3.372 / 1.882 | 33% | 45% | 1% | 1% | 0% | 13% | 8% | 48% |
| unit/doctor-checks.test.ts | 8.3 | 0.1 | 8.2 | 1.885 / 0.339 | 0% | 0% | 0% | 3% | 4% | 89% | 4% | 94% |
| **Sample** | 636.9 | 577.8 | 59.1 | | 40% | 24% | 5% | 7% | 14% | 6% | 4% | 26% |

## Cases that render everything to assert one decision

Case times are CI milliseconds from run `41476365861`.

### palette-identity.test.ts: 13 cases, 94.6 s of 95.7 s

- **no single function; decided at `src/themes/decor.ts:decorationFor (closed cells) and src/themes/decor.ts:bandFor / bandItemFor (menu state, plane, items)`** (drawn colour of a cell): 10 cases, 49.3 s. Sweep: inside each case: every bundled theme x 7 views (closed, 5 settings tabs, style picker in the gear), one full render per pair, at one shade dial position per case. The assertion (test/palette-identity.test.ts:107-111) reduces every drawn character's bg to a hex and checks it is in the theme's palette vars. That holds by construction in decorEntryColour/palette.get, but the colours reaching the frame come from two entry points (decorationFor for bar cells, bandFor for the menu state/plane/items, with PLANE_ROLE) plus the joiner's seam cells and authored bg, and no function enumerates the backgrounds of a view, so there is no single call to put the claim on; the seam missing is a function from (palette, decor, region) to the set of backgrounds a region can wear.
  - `every background the bar draws is a colour its palette names › at the muted dial position, under every bundled theme, closed and with the settings menu open` and 9 like it
- **no single function; decided at `rich-js ColorSpec.downgrade / the SGR writer (outside src/), with the shade choice in src/themes/decor.ts:windowAt and src/themes/decor.ts:decorEntryFor`** (drawn colour of a cell): 2 cases, 38.5 s. Sweep: inside each case (256 colours, ansi): 2 looks x every bundled theme x 7 views, rendered at truecolor and at the lower depth and compared cell by cell. The assertion (test/palette-identity.test.ts:197-200) is that the lower-depth bg equals the truecolor bg rounded once, or another shade of the same role rounded once. The rounding is rich-js's (not under src/) and which shade a depth deals is windowAt plus decorEntryFor's turn rule per position in the row, so the claim spans the writer and the placement of each cell and no one src function settles it.
  - `a lower depth draws each of those colours rounded once › at 256 colours, every background is the one truecolor draws there as the writer rounds it, or another shade of the same role as the writer rounds it, under every bundled theme and view`
  - `a lower depth draws each of those colours rounded once › at ansi, every background is the one truecolor draws there as the writer rounds it, or another shade of the same role as the writer rounds it, under every bundled theme and view`
- **no single function; decided at `src/render/segment-color.ts:namedRoleText (reached through the roleTextOn/keptOn template functions used by the door template in src/config/settings-menu.ts)`** (drawn colour of a cell): 1 case, 6.7 s. Sweep: inside the case: every bundled theme x every shade dial position, one render each, read the one X glyph's ink. The ink is keptOn(roleTextOn(DOOR_CLOSE_ROLE, bgOf)), and at truecolor keptOn returns its input, so the ink is namedRoleText(palette, 'error', ground), which by construction answers one of the role's named entries (text-error, error, error +-rungs), exactly the ERROR_REDS the test checks (test/palette-identity.test.ts:135-137). It is one pure function, but it is a non-exported local in segment-color.ts, so it cannot be called alone; the missing seam is exporting it, after which an exhaustive palette x ground test replaces the render sweep.
  - `the open door's ✖ is a red its palette names for its error role › under every bundled theme and every dial position, at truecolor`

### default-dsl-config.test.ts: 74 cases, 19.3 s of 54.6 s

- **no single function; decided at `src/config/default-dsl-config.ts:effortGauge (the `helpers.effortGauge` template string)`** (drawn colour of a cell): 23 cases, 6.1 s. Sweep: for each of the 23 resolvable palettes: draw the full default bar with effort level low, medium, high, xhigh, something-new and absent (6 frames) and read the rung glyph, colour and ground off the model cell's run. Asserts each level's rung glyph and that its drawn colour clears QUIET_MIN_CONTRAST/TEXT_MIN_CONTRAST on the cell, reduced from the model row's runs at test/default-dsl-config.test.ts:322-343 and 350-370. The colour is made inside the template by readableOn/mix/ramp (template functions supplied by rich-js, outside src/) against `bgOf`, which src/template-engine/colors.ts:resolveSegmentColors publishes from the cell's decoration tint; no function under src/ takes (palette, cell) and returns the rung colour, so the missing seam is a pure rung-colour function the template would call.
  - `DEFAULT_DSL_CONFIG › the model segment's effort gauge › under atom-one-dark, each level draws its rung, on the cell at its floor` and 22 like it
- **no single function; decided at `src/config/default-dsl-config.ts:effortGauge (the `helpers.effortGauge` template string)`** (drawn colour of a cell): 23 cases, 5.2 s. Sweep: for each of the 23 palettes: draw the bar at three clock instants (one per second of the 3 s cycle), plus xhigh and max, and read rung glyph, colour and bubble ground. Asserts max's three climb glyphs per frame, each frame's contrast on the bubble against TEXT_MIN_CONTRAST, one constant bubble ground EFFORT_BUBBLE_CONTRAST off the cell, and the bubble caps (test/default-dsl-config.test.ts:453-485). The frames come from the template's `frames`/`stepped` time functions and the colours from readableOn/mix over `bgOf`, spread across the template, the engine's clock and the segment colour resolver; no src function owns 'the climb colour for a palette'.
  - `DEFAULT_DSL_CONFIG › the model segment's effort gauge › under atom-one-dark, max climbs the ladder on a bubble, a frame a second` and 22 like it
- **no single function; decided at `src/config/quiet-text.ts:QUIET_TEXT (a template-expression string, used as GIT_QUIET_FG at src/config/default-dsl-config.ts:104)`** (drawn colour of a cell): 23 cases, 6.4 s. Sweep: for each of 23 palette names: render the expanded gitaculous segment and measure the contrast of the quiet text 'abc1234' against its cell. Asserts quiet structural text clears 2.99:1 on its own background (test/default-dsl-config.test.ts:1339-1344). The colour is the template expression readableOn(mix(foreground, bgOf, 60), bgOf, 3), evaluated by the template engine with rich-js's readableOn and resolveSegmentColors' bgOf; there is no src function for it. Note: renderSegment's `theme` argument is read only into an unused `basePalette` and never reaches drawPayload (test lines 1057-1074), so all 23 rows appear to render the same default palette and the sweep does not vary the theme.
  - `DEFAULT_DSL_CONFIG › git segment per-fact coloring › structural text recedes behind the operative facts › quiet structural text clears WCAG large-text contrast under theme atom-one-dark` and 22 like it
- **no single function; decided at `src/config/default-dsl-config.ts:DIR_TEMPLATE (home collapse via hasPrefix/trimPrefix in the template, then abbreviatePath)`** (default-config helper templates run without a bar): 3 cases, 0.8 s. Asserts which path the directory cell shows: the home-prefix boundary (/home/al vs /home/alice), home==main giving '~', and no '~' for a non-prefix (test/default-dsl-config.test.ts:947-976, reduced via textOf at 938). Only the abbreviation step is a function (src/utils/formatters.ts:abbreviatePath, pure); the home-collapse decision is template code in DIR_TEMPLATE (default-dsl-config.ts:84-91), so the missing seam is a pure display-path function the template calls.
  - `DEFAULT_DSL_CONFIG › DIR_TEMPLATE › hasPrefix boundary safety: /home/al is NOT a prefix of /home/alice`
  - `DEFAULT_DSL_CONFIG › DIR_TEMPLATE › home === main checkout renders as just ~`
  - `DEFAULT_DSL_CONFIG › DIR_TEMPLATE › home prefix boundary: /Users/al is NOT a prefix of /Users/alice`
- **no single function; decided at `src/config/loader/merge.ts:mergeWithDefault (with src/config/root.ts:rootOf/mergeRoot and src/config/loader/layout.ts:validateRootFragment)`** (other single-site folds): 1 case, 0.8 s. Asserts that a terse `root: { v: [ {h:[...]}, {h:[...]} ] }` merged over the bundled default draws the same rows as the default's own named-row root (test/default-dsl-config.test.ts:719). Whether the two roots agree is decided across validateRootFragment (lowering), rootOf (positional rows '#1','#2') and mergeWithDefault/mergeRoot (by-name merge against 'identity'/'status') and validateConfig; no single function's output settles it.
  - `DEFAULT_DSL_CONFIG › A-grammar { v:[{ h:[...] }] } spelling is render-equivalent to DEFAULT_DSL_CONFIG.root`
- **pure function `src/config/loader/layout.ts:validateRootFragment`** (pure function exists): 1 case, 0.1 s. Asserts the terse A-grammar spelling and the verbose kind+direction spelling of the same two-row tree draw identical rows (test/default-dsl-config.test.ts:778). Segments, globals and palette are identical in both sources, so rows can differ only if the root trees differ, and validateRootFragment(ctx, 'root', raw) (called at src/config/dsl-loader.ts:1163 in the parse every path goes through) lowers each spelling to its canonical tree; asserting its two outputs equal settles the claim without rendering. It takes a ValidateCtx error collector the test must construct, which is the only friction.
  - `DEFAULT_DSL_CONFIG › A-grammar terse form { v:[{ h:[...] }] } is render-equivalent to verbose kind+direction form`

### colour-256.test.ts: 3 cases, 35.3 s of 35.8 s

- **no single function; decided at `src/themes/decor.ts:legibleOn`** (drawn colour of a cell): 3 cases, 35.3 s. Sweep: for every bundled theme (listThemePalettes()): closed bar at truecolor+256 (case 1); 7 click-reached stages at truecolor+256 (case 2); closed bar plus 7 stages at truecolor+ansi (case 3). The asserted value is the contrast and ink of each drawn character after the 256/ansi downgrade (test/colour-256.test.ts:189 compare, :133 seamInks, :241 sameIndex, all reading drawnChars of the final frame). The text colour is chosen at several sites (src/themes/decor.ts:legibleOn/textOn, src/render/band-style.ts:closeOn, src/render/segment-color.ts QUIET_MIN_CONTRAST at :138, authored segment colours), the arrow inks and the downgrade rounding are rich-js's joiner and writer, and the floor is judged on the rounded pair; no function takes a cell's roles and returns its drawn text and seam colours, so the missing seam is a pure 'cell roles + depth -> drawn fg/bg' function that this sweep could then be reduced to.
  - `every bundled theme's text reads at 256 colours as it does in truecolor`
  - `every open settings band and picker reads at 256 colours as it does in truecolor`
  - `at ansi no divider is drawn, every arrow's ink is its cell's slot or rich-js's lift of it, and nothing — text or arrow — is drawn on its own ground's index`

### settings-config-menu.test.ts: 10 cases, 3.6 s of 32.8 s

- **pure function `src/daemon/setting-drafts.ts:settingCounts`** (pure function exists): 1 case, 0.3 s. Every assertion is whether the `💾 save N` cell exists and its N after picks are set straight on SessionState (test/settings-config-menu.test.ts:1353-1366, reduced by textOf). That text is printf "💾 save %d" over .unsaved (src/config/settings-menu.ts:551), which is settingCounts(config, fileHeld, pick).unsaved, computed by the daemon at src/daemon/session-source.ts:79 and by the rig at test line 205. settingCounts is pure over (config, fileHeld, pick) and its .unsaved alone gives 0/1/2 for these picks, as test/setting-drafts.test.ts already does for settingDrafts.
  - `a theme's default look, set from the bar › a pick equal to the theme's default is no draft, and picking a theme drafts only the theme`
- **pure function `src/daemon/setting-drafts.ts:settingCounts`** (pure function exists): 1 case, 0.3 s. Asserts the `⤓ default for <theme>` cell shows exactly while the look differs and names the theme in force (test/settings-config-menu.test.ts:1367-1379); settingCounts(...).themeDefault is {differs, theme} derived from themeDefaultSave (src/daemon/setting-drafts.ts:442), which the render publishes as themeDefault.differs/.theme (src/config/settings-menu.ts:956-962). Caveat: the assertions also match the `▀▀▀` swatch after the name, which is template output, so the pure function settles show/hide and the name but not that glyph.
  - `a theme's default look, set from the bar › the control shows exactly while the look differs from the theme's default`
- **no single function; decided at `src/config/settings-menu.ts:anyResettable / markedDisplay (the `•` on tab, gear and submenu triggers) and the ↺/⟲ cells' gates, fed by src/daemon/setting-drafts.ts:settingCounts`** (other single-site folds): 8 cases, 2.9 s. Assert which controls draw ↺ and which tabs, gear or ⟲ carry the drift mark, reduced from link text and the bar text (test/settings-config-menu.test.ts:861-880 and 802-807). Per-setting 'would a reset change anything' is pure (settingCounts(...).resettable over fileHeldSettings(raw)), but which trigger is marked is a template `or` over the controls under each place, each ANDed with its `shown` gate (settings-menu.ts:319-324, 478-486), so two layers decide it and no single function's output settles the tab/gear assertions. The missing seam is a pure 'marked places' function the templates read.
  - `the drift marker › nothing picked and nothing in the file: no ↺, no tab marked, no ⟲` and 7 like it

### threshold-colors.test.ts: 94 cases, 29.2 s of 30.5 s

- **no single function; decided at `src/config/default-dsl-config.ts:RAW_DEFAULT_DSL_CONFIG (the `bg:` template strings of block, weekly, burnrate, context at lines 809, 825, 844, 930), evaluated by rich-js `ramp` bound in src/render/segment-color.ts:segmentColorFuncs; text colour by src/themes/decor.ts:textOn`** (drawn colour of a cell): 94 cases, 29.2 s. Each row reduces the frame to the glyph run's bg/fg (cellColors, test/threshold-colors.test.ts:242-250) and asserts bg equals a palette role (:273) and fg clears TEXT_MIN_CONTRAST (:274-276). The bg is the output of a `ramp` call that lives in the external @promptctl/rich-js package and is written only as a template string in the default config, with the calm arm `(tint)` resolved from the decoration walk (segment-color.ts tint); the fg is a second function (textOn) fed that bg. No function under src/ takes (value, settings, palette) and returns the bg, so the seam missing is a src-level threshold function (value + thresholds -> role) that the template and a test would both call.
  - `threshold colours under textual-dark › block warnAt=20 at 19 wears bg=tint, text legible on it` and 93 like it

### picker-pagination.test.ts: 15 cases, 27.6 s of 30.5 s

- **no single function; decided at `src/render/picker.ts:rowBudget / ledRowBudget and src/render/picker.ts:paginate (via gridPages), against the painted width from src/render/strip.ts:stripChromeCols and the walk's padding`** (picker row budget against the painted width): 15 cases, 27.6 s. Sweep: inside each case: width from FLOOR (or FLOOR+2*padding) up to 80 or 60 x pages 0..N, one full render per pair, at one endcap style per case. The assertion is that the rendered line width is <= width and the arrows are present (test/picker-pagination.test.ts:160-164, 357, 394). paginate is pure and exported, but what it is fed is rowBudget (width - chromeCols - 2*padding, from the render binding) and the faces' widths, and whether the result fits depends on that reserve agreeing with what the joiner, padding and the body's lead X actually paint; no function maps (option widths, width, endcaps, padding) to the painted width of a page, so the claim needs the render.
  - `brandon-menu-abg — paged menu fits every page within term.cols › every page fits and keeps its nav arrows (powerline)` and 14 like it

### theme-carousel.test.ts: 20 cases, 14.5 s of 30.0 s

- **pure function `src/render/carousel.ts:ringAround`** (pure function exists): 2 cases, 0.5 s. Sweep: first: 3 centres (a, c, e) each rendered once; second: one render then one click. The first case reads the value each arrow writes (test/theme-carousel.test.ts:221-222) and the second the value the click leaves in session state (:297-298); renderCarousel (src/render/carousel.ts) computes both as options[ringAround(options, current)(+-1)], and ringAround is pure and carries the wrap and 'unknown current counts as the first option' rules, so ringAround(['a','b','c','d','e'], centre)(+-1) settles every expected value without rendering. The second case also runs the set-state verb, which writes the realized value unchanged (not read in full).
  - `the carousel rotates by applying › ◀ writes the option before the centre and ▶ the one after, wrapping at both ends`
  - `the carousel rotates by applying › a value outside the domain counts as the first option`
- **no single function; decided at `src/render/picker.ts:ledRowBudget`** (picker row budget against the painted width): 18 cases, 14.0 s. Sweep: for control in {theme, preset} x style in {powerline, capsule, plain} x padding in {0,1,2} (one case per row), inside each: width 40..160 step 3 (41 renders of the open list). Each width asserts the body rows are led by exactly one ✕ and no frame line is wider than the width (test/theme-carousel.test.ts:503-512). The row width is decided by ledRowBudget/rowBudget (src/render/picker.ts) from the live render binding (width, chromeCols per strip shape, padding, seamCols) and paginate, and the line break is then made by the strip's wrap in rich-js, so the claim is the contract between the picker's budget and the wrapper; the pure paginate cannot show it because the reserved chrome comes from the strip geometry. A seam would be a pure 'strip shape + padding + width -> row budget' function checked against the wrapper once per shape.
  - `the settings menu's look controls are pickers whose label opens a list › every row of the open theme list fits its terminal (powerline, padding 0)` and 17 like it

### cli-check.test.ts: 5 cases, 2.5 s of 16.0 s

- **pure function `src/config-hint.ts:cliConfigTarget`** (pure function exists): 1 case, 1.0 s. Sweep: two checkCommandPlan runs (argument, then env), then four empty-argument runs, each a full checkConfig. The claim is which file `check` takes as its target when an argument and $CC_CANDYBAR_CONFIG are both given, or the argument is empty; src/check.ts:961 passes `cliConfigTarget(parsed.target, process.env, cwd).path` to checkConfig, and cliConfigTarget (-> requestedConfigTarget, explicitConfigPath) is pure over (arg, env, cwd) and returns the argument/environment/search choice alone. The case proves it by the verdict text and exit code of two tiny configs (test/cli-check.test.ts:968-992); those loader messages are only evidence of which file was picked, so the same precedence claim holds asserted on cliConfigTarget's {source, path} with no render.
  - `checkCommandPlan — the argv edge › an explicit argument outranks $CC_CANDYBAR_CONFIG; without one the variable is the target`
- **no single function; decided at `src/check.ts:loadRegisterRender (the `reported` closure, src/check.ts:779-803)`** (other single-site folds): 4 cases, 1.5 s. Each asserts how a failure reached by several of the preset x customized render passes is counted and tagged: once, bare when the fresh preset's plain pass reaches it, else `(under preset "b"; preset "c", .preset.customized = true)` (test/cli-check.test.ts:547-549, 528, 696-697, 719-722). That fold is `reported`, an unexported closure over the local `outs` and `freshPreset`, so it cannot be called alone; the missing seam is a pure function (passes with preset, customized, failure lines -> reported lines) lifted out of loadRegisterRender, with the render passes only supplying its input.
  - `checkConfig — explicit target › does not double-report an unconditional segment error across both render passes` and 3 like it

### dsl-formatters-duration-time.test.ts: 54 cases, 10.7 s of 11.4 s

- **no single function; decided at `src/config/default-dsl-config.ts:DEFAULT_DSL_CONFIG.helpers.formatTimeSince (lines 1626-1631)`** (default-config helper templates run without a bar): 13 cases, 3.2 s. Each row renders a one-segment config (render(), test/dsl-formatters-duration-time.test.ts:60-84: parse, merge onto the default, validate, register, drawPayload) and reads the text with toContain (e.g. :104-106). The formatTimeSince output is decided by a go-template string in the default config's helpers evaluated by the template engine; there is no TS function to call, so the missing seam is a src-level formatter (seconds or minutes -> string) the helper delegates to.
  - `bdi.4 — formatTimeSince helper (byte-parity with retired JS) › formatTimeSince(0) === "0s"` and 12 like it
- **no single function; decided at `src/config/default-dsl-config.ts:DEFAULT_DSL_CONFIG.helpers.formatDuration (lines 1635-1639)`** (default-config helper templates run without a bar): 11 cases, 2.2 s. Each row renders a one-segment config (render(), test/dsl-formatters-duration-time.test.ts:60-84: parse, merge onto the default, validate, register, drawPayload) and reads the text with toContain (e.g. :104-106). The formatDuration output is decided by a go-template string in the default config's helpers evaluated by the template engine; there is no TS function to call, so the missing seam is a src-level formatter (seconds or minutes -> string) the helper delegates to.
  - `bdi.4 — formatDuration helper › formatDuration(0) === "0s"` and 10 like it
- **no single function; decided at `src/config/default-dsl-config.ts:DEFAULT_DSL_CONFIG.helpers.formatResponseTime (lines 1642-1644)`** (default-config helper templates run without a bar): 7 cases, 1.2 s. Each row renders a one-segment config (render(), test/dsl-formatters-duration-time.test.ts:60-84: parse, merge onto the default, validate, register, drawPayload) and reads the text with toContain (e.g. :104-106). The formatResponseTime output is decided by a go-template string in the default config's helpers evaluated by the template engine; there is no TS function to call, so the missing seam is a src-level formatter (seconds or minutes -> string) the helper delegates to.
  - `bdi.4 — formatResponseTime helper › formatResponseTime(0) === "0.0s"` and 6 like it
- **no single function; decided at `src/config/default-dsl-config.ts:DEFAULT_DSL_CONFIG.helpers.formatLongTimeRemaining (lines 1650-1656)`** (default-config helper templates run without a bar): 13 cases, 2.2 s. Each row renders a one-segment config (render(), test/dsl-formatters-duration-time.test.ts:60-84: parse, merge onto the default, validate, register, drawPayload) and reads the text with toContain (e.g. :104-106). The formatLongTimeRemaining output is decided by a go-template string in the default config's helpers evaluated by the template engine; there is no TS function to call, so the missing seam is a src-level formatter (seconds or minutes -> string) the helper delegates to.
  - `bdi.4 — formatLongTimeRemaining helper (input = whole minutes) › formatLongTimeRemaining(0) === "0m"` and 12 like it
- **no single function; decided at `src/config/default-dsl-config.ts:DEFAULT_DSL_CONFIG.helpers.formatResetCountdown (lines 1663-1664)`** (default-config helper templates run without a bar): 3 cases, 0.5 s. Asserts the countdown text for a reset 10 s, 90 min and 2940 min away (test/dsl-formatters-duration-time.test.ts:191-199). It is a template composing the formatLongTimeRemaining template, `add 1`, and the clock-reading minutesUntilReset func, so the decision spans a template string and a func and no single function can be called alone.
  - `bdi.4 — minutesUntilReset func against a frozen clock › formatResetCountdown(1780531210) renders "1m"`
  - `bdi.4 — minutesUntilReset func against a frozen clock › formatResetCountdown(1780536600) renders "1h 31m"`
  - `bdi.4 — minutesUntilReset func against a frozen clock › formatResetCountdown(1780707600) renders "2d 1h"`
- **pure function `src/template-engine/funcs.ts:relativeTimeFuncs`** (pure function exists): 7 cases, 1.4 s. Asserts the text of `{{ minutesUntilReset .e }}` against a frozen instant (test/dsl-formatters-duration-time.test.ts:176-186); the engine builds the func from relativeTimeFuncs(clock) (src/template-engine/engine.ts:215) and its result is Math.round(Math.max(0, epoch*1000 - clock.now().getTime())/60000) (src/template-engine/funcs.ts:240-253), so relativeTimeFuncs({now}).minutesUntilReset.fn(e) settles every row. Caveat: it is a clock factory, so the pure call needs a stub Clock supplying now(), and the func is reached as a property of the returned map, not a standalone export.
  - `bdi.4 — minutesUntilReset func against a frozen clock › minutesUntilReset(1780531200) === "0"` and 6 like it

### config-layers.test.ts: 13 cases, 8.2 s of 12.0 s

- **pure function `src/config/root.ts:insertCells`** (pure function exists): 3 cases, 1.5 s. Each case writes a user row and a project `insert` cell, runs checkConfig, and reads where the cell's marker text lands in the rendered frame (test/config-layers.test.ts:347-350, :360-363, :558). validateRenderable passes the layers' cells to placeInserts (src/config/dsl-loader.ts:717) which folds insertCells (src/config/root.ts) over the tree; insertCells(root, cells) is pure and decides the side (before/after), anchoring on an earlier cell, whole-tree versus rows addressing, and the id-versus-segment satisfaction rule, so its returned root alone settles the marker order and count (test/unit/root-insert.test.ts already exercises it directly). The text order in the frame follows the tree order here (single wide row, not verified at narrow widths).
  - `a project layer inserting into the user's row › a whole-tree user root is addressed by placement id the same way`
  - `a project layer inserting into the user's row › before places to the left, and a later cell may anchor on an earlier one`
  - `a project layer inserting into the user's row › a cell with its own id is drawn beside a placement of its segment under another id`
- **pure function `src/config/presets.ts:placeInserts`** (pure function exists): 10 cases, 6.7 s. These cases assert the placed tree of the root or of a named preset (presetTree, :212-227, or marker order) and/or the insert warning text and its `(in the root, preset ...)` list (warnedFor/presetWarnings/missedTrees, :204-211), all produced by placeInserts(config, cells, authored) (src/config/presets.ts), which is pure and returns both the config with the cells placed and the notices; the file name in a warning is the cell's own `by.file`, an input. The cells and `authored` arguments come from layerInserts (src/config/dsl-loader.ts:880), so the case needs the chain only to build those inputs, not to decide the outcome.
  - The 10, in the file's `a project layer inserting into the user's row` describe: `an approved repo's cell lands beside its anchor and the user's file is untouched`; `a cell the user already places is drawn once, with no warning`; `a cell whose id another segment holds is not drawn, and the warning names both`; `an anchor the bar does not have is a warning naming the file, the cell and the anchor`; `a cell without an id is satisfied by the user's placement of its segment under another id`; `a preset that already places the cell loads and draws it once`; `an anchor only a preset holds is placed in that preset, with no warning for it`; `a whole-tree preset draws the cell when it holds the anchor, and warns naming itself when it does not`; `a bundled-only preset that lacks the anchor does not warn; one the user authors does`; `an entry whose anchor no tree holds is one warning naming every tree it missed`. The file's other cases are not in the 10: approval gating (`an unapproved repo's cell is not drawn and its file is never named`) and the edit-mode UI (`edit mode offers no edit on an inserted cell ...`) are decided outside `placeInserts`.

### dsl-formatters-cost-token.test.ts: 42 cases, 9.4 s of 10.4 s

- **no single function; decided at `src/config/default-dsl-config.ts:DEFAULT_DSL_CONFIG.helpers (formatCost, formatTokenCount, formatTokens, formatTokenBreakdown, budgetStatus)`** (default-config helper templates run without a bar): 42 cases, 9.4 s. Each row asserts that the helper's text appears in the drawn frame (test/dsl-formatters-cost-token.test.ts:94, :112, :126, :148, :167, :176). The decision is a Go-template string stored as config data (src/config/default-dsl-config.ts, helpers block from line 1553; src/config/format-token-count.ts:formatTokenCount only builds the template text), evaluated by the template engine (src/template-engine/engine.ts:createCcCandybarEngine), so there is no TS function to call; the missing seam is executing a helper's template body directly in the engine over its dot value, without a bar, to get the string.
  - `bdi.3 — formatCost helper (byte-parity with retired JS) › formatCost(0) === "<$0.01"` and 41 like it

## Files with no named case: what their time is

These notes are the readers', from the latest run (`41476365861`) and their own reading of the code, so a file's seconds here can differ from the table's five-run means (for `dsl-loader.test.ts` 11.7 s file time and 9.8 s outside cases here, against 9.9 s and 8.3 s in the table). Where they disagree, the table is the figure.

- `plugins.test.ts` (47.7 s): 118 cases each writing plugin folders and config files under a tmp dir, then running checkConfig/prepareConfig (parse, validate, compile, one render) or the daemon load, some with fs watchers; no single sweep, the time is per-case config load plus file I/O (the 38s of case time is spread 100-1200ms per case). The 9.6s between file and case time is load/setup outside any case (unverified what).
- `doc-snippets.test.ts` (39.5 s): One test per doc fence (about 130 of the 145 cases are pass/fail/render snippets), each calling checkConfig (load, register, render under every preset twice, settle sources) on a temp file; the interaction-authoring.md line 2038 snippet alone is 4.7 s, the rest roughly 0.2-0.8 s each. The case sum is almost the whole file time, so there is little setup outside cases.
- `unit/decor.test.ts` (33.3 s): No case renders a frame: every case calls decor.ts and band-style.ts functions directly. The time is the sweeps over every bundled palette x 3 colour depths x dial positions x hues x rows of 2..16 cells: 'a dial window at a depth' (~1.1s), the 18 'where a row turns hue' cases at 0.9-2.4s each, the van der Corput neighbours case (6.3s), 'any node's colour is computable alone' / 'permuting an unrelated subtree' / 'adding a sibling' (1-1.7s each) and the text-contrast sweep (1.5s). About 6.6s of the file time is outside the cases (module load).
- `demo.test.ts` (21.3 s): Each case is one or two spawnSync calls of node_modules/.bin/tsx on src/demo/dsl.ts (process start, TypeScript transpile and module graph load, about 2.5-5 s each; the two-spawn case is 9.1 s); the render inside the child is trivial.
- `var-sources.test.ts` (18.8 s): No case draws a frame or calls drawPayload; the cost is real subprocess and timer waits (shell TTL cases wait MIN_SHELL_TTL_MS plus a 200 ms buffer, 0.7-1.1 s each), file-watcher setup and teardown, and parse-seam rescans, across 159 cases. The file time exceeds the case sum by about 7 s, which is module load and first-use cost outside cases (unverified which).
- `daemon-render-cache.test.ts` (17.7 s): No case draws a frame. The time is real filesystem work and file watchers in temp dirs (mkdtemp, writes, renames, symlinks, chmod) and awaiting reload signals / the cache's periodic judgement; the slowest cases (0.5-0.85s) are watcher and eviction cases.
- `proc/launch-group-end.test.ts` (16.0 s): 14 cases, each spawning python3 children that fork, sleep up to 3s, and are signalled; 'reads what a member wrote just before the group ended' is 8.4s and 'resolves when a group member ends just after the child' 1.9s, so the time is real process lifetimes and timeouts, plus a deliberate busy-spin that blocks the event loop in the 8.4 s case (the profile files that spin under "test", 71%). No rendering.
- `plugin-templates.test.ts` (14.9 s): 45 of 51 cases are one `checkText` per (placeholder, value): THEME x 23, ENDCAPS x 14, PRESET x 7, each a full parse+validate of the filled config plus a check render (about 240-690 ms); the other 6 are string comparisons taking about 1 ms.
- `integration/quarantine-gate.test.ts` (13.0 s): Each of the 9 slow cases spawns a real jest child process (node jest.js) over a fixture and parses its JSON result, ~1.2-2.4s each; the rest are string/version checks.
- `dsl-layout-edit.test.ts` (12.8 s): The 24 loader/validator cases are 1-60ms; the time is the 8 click cases (about 80-620ms: a real daemon verb writing a tmp config file) and the 12 RenderCache cases (300-1600ms: file writes, watcher-driven reloads, restarts, real clicks), plus two small banner/root-gate renders.
- `render-cache-sharing.test.ts` (11.7 s): Cases build RenderCache entries from real config files and draw a frame only to read a carousel's next value; the 6.9 s case builds seven entries and many views, calls gc() around heap measurements, and walks the whole bundled menu through real clicks and redraws for 7 sessions. Cache accounting and GC, not rendering, dominate.
- `update-act.test.ts` (11.2 s): No case renders a bar; the time is real child processes and polling timers in the update-watch describe (three cases of 2.1-4.4 s waiting on ticks and a slow read) plus file and process work in the claimAct cases (0.1-0.2 s each). About 0.6 s of the file time is outside cases.
- `plugin-sources.test.ts` (10.6 s): Temp-dir file I/O and watchers: each case builds a rig (RenderCache, watchers, payload providers), loads configs from disk, runs checkConfig or waits with `until` for a watched file write to show up; 0.2-0.8s per case. Draws are single small frames used only to read the result.
- `dsl-undo-redo.test.ts` (10.0 s): The click cases drive the real verbs against files in a tmp XDG_STATE_HOME with a render per setup; 'the history is bounded' is 7.8s of the 11.6s, being 51 sequential clicks each persisting history to disk (test/dsl-undo-redo.test.ts:468-475), not rendering.
- `dsl-loader.test.ts` (9.9 s): The 229 cases are fast (13 cases at 50-92 ms, the rest under 50 ms; total 1.9 s) and none draws a frame (no drawPayload/drawDsl/registerDslConfig in the file). The remaining ~9.8 s of the file's 11.7 s is outside any case: module import and setup (unverified which part; two beforeAll hooks at lines 2473 and 2536 are in the file).
- `frame-feed.test.ts` (9.6 s): Real sleeps and timers: the harness render is a stub that answers at once, and cases wait out several 20ms/400ms periods with sleep(); the slowest (1-1.5s) are the 'draws when its bar next changes' cases on the wall clock.
- `setting-drafts.test.ts` (9.0 s): No case draws a frame. The 16 pin-and-pick cases (about 400-850 ms each) each call parseAndValidate on the bundled default merged with a user file about 4 times, run writeValues to a temp file and re-parse the result; the 7 settingDrafts cases are one parse each (65-125 ms).
- `session-views.test.ts` (9.0 s): 19 cases, each building a RenderCache with watchers, writing a config to a temp dir, drawing sessions through drawPayload, running counted shell sources and awaiting registry.settled (the render() helper, test/session-views.test.ts:137-151); the 0.4-0.9 s cases are those with several renders and shell runs. About 0.6 s is outside cases.
- `placement-effect.test.ts` (8.6 s): The 9 'pulse on the %s placement' cases (0.6-1.0s each, ~7.5s of 9.3s) each build two bars and render both at 12 instants for one bar effect, comparing the two frames cell by cell; the other cases render the same row at 12 instants.
- `unit/doctor-checks.test.ts` (8.3 s): The 75 cases total 88 ms and draw nothing; the file's 9.7 s is outside any case, i.e. loading src/doctor/checks and its import graph (unverified which module dominates).

## A finding in a named file

`test/default-dsl-config.test.ts`, "quiet structural text clears WCAG large-text contrast under theme %s": its `renderSegment(segment, theme)` reads `theme` only into `basePalette`, which nothing uses, and `drawPayload` is not given it, so all 23 rows draw the default palette and the sweep does not check the registry its comment says it does. Checked by reading the helper (the `basePalette` constant and the `drawPayload` call that follows it). Cutting those 22 duplicate renders loses no coverage, and the contrast claim across themes is currently unproven. Filed as candybar-testing-ihvy.s33.

## Appendix: the scripts

Paths are where they were run (`/tmp/hf7`); the worktree root is the repository's. Order: `rank.mjs`, `run-profiles.sh`, then the baseline (an empty `test/__baseline.test.ts`, profiled by the same command and removed), then the four classification readers, then `aggregate.mjs`, which imports `analyze.mjs`.

### rank.mjs

`node rank.mjs 41476365861 41476365861 41471161745 41468564307 41468294885 41461618355 > sample.json` from `/tmp/hf7/runs`, each directory holding a run's downloaded `test-records` artifact (`gh run download <id> -n test-records`).

```js
// Rank the unit layer's files by mean CI duration over the given runs.
// usage: node rank.mjs <latest-run-dir> <run-dir>... > sample.json
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [latest, ...dirs] = process.argv.slice(2);
const runs = ["unit", "worker"];

function load(dir) {
  const out = new Map();
  for (const run of runs) {
    const text = readFileSync(join(dir, `${run}.jsonl`), "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      if (r.durationMs !== undefined) out.set(r.file, r);
    }
  }
  return out;
}

const latestRecords = load(latest);
const population = [...latestRecords.values()].filter((r) => r.layer !== "daemon-boots");
const perRun = dirs.map(load);

const rows = population.map((r) => {
  const seen = perRun.map((m) => m.get(r.file)).filter(Boolean);
  const mean = (f) => seen.reduce((s, x) => s + f(x), 0) / seen.length;
  return {
    file: r.file,
    layer: r.layer,
    runsSeen: seen.length,
    runsMissing: perRun.length - seen.length,
    meanMs: Math.round(mean((x) => x.durationMs)),
    meanCasesMs: Math.round(mean((x) => x.cases.reduce((a, c) => a + c.durationMs, 0))),
    meanCount: Math.round(mean((x) => x.count)),
  };
});
rows.sort((a, b) => b.meanMs - a.meanMs);
const n = Math.ceil(rows.length / 10);
const total = rows.reduce((s, r) => s + r.meanMs, 0);
const sample = rows.slice(0, n);
process.stdout.write(
  JSON.stringify(
    {
      populationFiles: rows.length,
      populationMeanMs: total,
      sampleSize: n,
      sampleMeanMs: sample.reduce((s, r) => s + r.meanMs, 0),
      runs: dirs.length,
      sample,
      all: rows,
    },
    null,
    1,
  ),
);
```

### run-profiles.sh

`sh run-profiles.sh sample-files.txt` from the repository root, the list being the sample's paths one per line.

```sh
#!/bin/sh
# Profile each file named in $1 (one path per line), alone, twice: once on an empty
# jest cache directory (CI's start), once on the cache that run filled (the floor).
# One file at a time, so no profile is slowed by another. Run from the worktree root.
list="$1"
out=/tmp/hf7/prof
while read -r f; do
  [ -z "$f" ] && continue
  name=$(echo "$f" | sed 's#^test/##; s#\.test\.ts$##; s#/#__#g')
  case "$f" in
    test/unit/*) cfg=jest.unit.config.js ;;
    *) cfg=jest.worker.config.js ;;
  esac
  cache=/tmp/hf7/jestcache/$name
  rm -rf "$cache" "$out/$name"
  mkdir -p "$out/$name/cold" "$out/$name/warm"
  for pass in cold warm; do
    start=$(date +%s)
    node --cpu-prof --cpu-prof-dir="$out/$name/$pass" node_modules/jest/bin/jest.js \
      --config "$cfg" --runInBand --cacheDirectory="$cache" --runTestsByPath "$f" \
      > "$out/$name/$pass.log" 2>&1
    rc=$?
    echo "$name $pass rc=$rc wall=$(( $(date +%s) - start ))s"
  done
done < "$list"
echo done
```

### analyze.mjs

```js
// Assign every sample of a V8 .cpuprofile to exactly one bucket, by which frames are in its stack.
// usage: node analyze.mjs <file.cpuprofile> [--debug]
//
// Priority, first match wins (a stack is checked as a whole, not by its leaf alone, because a
// helper in src/utils called from the loader is the loader's cost, and a colour library called
// from a test's own assertion is the test's):
//   gc / wait / program   V8's own pseudo-frames, and time the thread spent with nothing to run or
//                         blocked on a child it started (spawnSync); reported as their own lines.
//   transform             typescript, ts-jest, @jest/transform, source-map frames anywhere in the stack.
//   load                  not inside a test or hook, and a module is being required or evaluated
//                         (jest-runtime, node's module loader, a src or test file's top level).
//   compile               inside src/config/dsl-loader.ts or src/config/loader/, or a template parse.
//   render                inside the render pipeline: src/render, src/dsl, src/segments,
//                         src/template-engine, src/band.
//   product               any other frame under src/: decision code a test calls directly (src/themes),
//                         watchers, stores, installers, doctor. A decision function reached from inside
//                         the render pipeline stays in render, since the pipeline is on the stack.
//   test                  everything left: the test file's own frames, test/helpers, assertions,
//                         and libraries a test calls directly.
import { readFileSync } from "node:fs";

export const BUCKETS = ["transform", "load", "compile", "render", "product", "test", "gc", "wait", "program"];

const RE = {
  transform: /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(typescript|ts-jest|@jest\/transform|source-map|convert-source-map|babel-plugin-istanbul|@babel)\//,
  moduleMachinery: /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(jest-runtime|jest-resolve|jest-haste-map)\/|^node:internal\/(modules|vm)|^node:vm/,
  circus: /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?jest-circus\//,
  compile: /\/src\/config\/(dsl-loader\.ts|loader\/)|\/go-template-js\/.*\bparse/i,
  render: /\/src\/(render|dsl|segments|template-engine|band)\//,
  src: /\/src\//,
  testfile: /\/test\//,
};
const CIRCUS_CASE = /^(callAsyncCircusFn|_callCircusTest|_callCircusHook)$/;

function bucketOf(stack) {
  // stack: callFrames from leaf to root
  const leaf = stack[0];
  if (leaf.functionName === "(garbage collector)") return "gc";
  // The loop has nothing to run, or the thread is blocked on a child it started.
  if (leaf.functionName === "(idle)" || /^(spawnSync|execSync|execFileSync)$/.test(leaf.functionName)) return "wait";
  if (leaf.functionName === "(program)" || leaf.functionName === "(root)") return "program";
  const urls = stack.map((f) => f.url);
  if (urls.some((u) => RE.transform.test(u))) return "transform";
  const inCase = stack.some((f) => CIRCUS_CASE.test(f.functionName) && RE.circus.test(f.url));
  const hasModuleWork = stack.some((f) => RE.moduleMachinery.test(f.url) || /^(requireModule|_loadModule|requireModuleOrMock|_execModule)$/.test(f.functionName));
  if (!inCase && hasModuleWork) return "load";
  if (urls.some((u) => RE.compile.test(u))) return "compile";
  if (urls.some((u) => RE.render.test(u))) return "render";
  if (urls.some((u) => RE.src.test(u))) return "product";
  return "test";
}

export function analyze(path, debug = false) {
  const p = JSON.parse(readFileSync(path, "utf8"));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const cache = new Map();
  const ms = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const lead = Object.fromEntries(BUCKETS.map((b) => [b, new Map()]));
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? 0) / 1000;
    const id = p.samples[i];
    let b = cache.get(id);
    if (b === undefined) {
      const stack = [];
      for (let n = id; n !== undefined; n = parent.get(n)) stack.push(byId.get(n).callFrame);
      b = bucketOf(stack);
      cache.set(id, b);
    }
    ms[b] += dt;
    if (debug) {
      const f = byId.get(id).callFrame;
      const key = `${f.functionName || "(anon)"} ${f.url.replace(/^.*\/(worktrees\/hf7|node_modules)\//, "")}:${f.lineNumber}`;
      lead[b].set(key, (lead[b].get(key) ?? 0) + dt);
    }
  }
  return { ms, lead };
}

if (process.argv[1].endsWith("analyze.mjs")) {
  const debug = process.argv.includes("--debug");
  const { ms, lead } = analyze(process.argv[2], debug);
  const total = Object.values(ms).reduce((a, b) => a + b, 0);
  console.log("total", total.toFixed(0), Object.entries(ms).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(" "));
  if (debug) {
    for (const b of BUCKETS) {
      console.log(`\n== ${b}`);
      for (const [k, v] of [...lead[b]].sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(v.toFixed(0).padStart(7), k);
    }
  }
}
```

### aggregate.mjs

```js
// Join CI means, cold and warm profiles, and the classifications into one table of numbers.
// usage: node aggregate.mjs > numbers.json
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { analyze, BUCKETS } from "./analyze.mjs";

const PROF = "/tmp/hf7/prof";
const sample = JSON.parse(readFileSync("/tmp/hf7/sample.json", "utf8"));
const latestDir = "/tmp/hf7/runs/41476365861";

const nameOf = (f) => f.replace(/^test\//, "").replace(/\.test\.ts$/, "").replace(/\//g, "__");
const profileOf = (name, pass) => {
  const dir = join(PROF, name, pass);
  const f = readdirSync(dir).find((n) => n.endsWith(".cpuprofile"));
  return analyze(join(dir, f)).ms;
};
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const baseline = { cold: profileOf("baseline", "cold"), warm: profileOf("baseline", "warm") };

// Jest's own "Time:" line is the local file time: the empty file's is 0.1 s, so jest's boot is not in it.
const localSeconds = (name, pass) => {
  const m = readFileSync(join(PROF, name, `${pass}.log`), "utf8").match(/^Time:\s+([\d.]+) s/m);
  return m ? Number(m[1]) : null;
};

// What each profile is split into: the buckets, less an empty file's profile (node and jest boot).
function split(name, pass) {
  const raw = profileOf(name, pass);
  const net = {};
  for (const b of BUCKETS) net[b] = Math.max(0, raw[b] - baseline[pass][b]);
  return { raw, net, total: sum(net) };
}

const latest = new Map();
for (const run of ["unit", "worker"]) {
  for (const line of readFileSync(join(latestDir, `${run}.jsonl`), "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.durationMs !== undefined) latest.set(r.file, r);
  }
}
const classified = new Map();
for (const g of ["group1", "group2", "group3", "group4"]) {
  for (const f of JSON.parse(readFileSync(`/tmp/hf7/classify/${g}.json`, "utf8"))) classified.set(f.file, f);
}

const files = sample.sample.map((s) => {
  const name = nameOf(s.file);
  const cold = split(name, "cold");
  const warm = split(name, "warm");
  const ci = s.meanMs;
  // The local profile's proportions are applied to the file's CI milliseconds. A timer wait would not
  // stretch on CI as compute does, so a wait-bound file's CI split leans toward waiting by a few seconds.
  const attribute = (sp) => Object.fromEntries(BUCKETS.map((b) => [b, sp.total > 0 ? (ci * sp.net[b]) / sp.total : 0]));
  const rec = latest.get(s.file);
  const c = classified.get(s.file);
  const caseMs = (names) => names.reduce((a, n) => a + (rec.cases.find((x) => x.name === n)?.durationMs ?? NaN), 0);
  const named = (c?.named ?? []).map((n) => ({ ...n, caseMs: caseMs(n.caseNames) }));
  return {
    file: s.file,
    layer: s.layer,
    ciMeanMs: ci,
    ciCasesMs: s.meanCasesMs,
    ciGapMs: ci - s.meanCasesMs,
    runsSeen: s.runsSeen,
    localColdS: localSeconds(name, "cold"),
    localWarmS: localSeconds(name, "warm"),
    cold: { localMs: cold.total, ciMs: attribute(cold) },
    warm: { localMs: warm.total, ciMs: attribute(warm) },
    named,
    namedMs: named.reduce((a, n) => a + n.caseMs, 0),
    latestFileMs: rec.durationMs,
    whatTheFileIs: c?.whatTheFileIs,
    whereItsTimeGoes: c?.whereItsTimeGoes,
    considered: c?.considered ?? [],
  };
});

const totals = (pass) => {
  const t = Object.fromEntries(BUCKETS.map((b) => [b, files.reduce((a, f) => a + f[pass].ciMs[b], 0)]));
  return { ...t, all: sum(t) };
};
const out = {
  population: { files: sample.populationFiles, meanMs: sample.populationMeanMs },
  sample: { files: sample.sampleSize, meanMs: sample.sampleMeanMs },
  baseline: { coldMs: sum(baseline.cold), warmMs: sum(baseline.warm) },
  totals: { cold: totals("cold"), warm: totals("warm") },
  caseMsOfSample: files.reduce((a, f) => a + f.ciCasesMs, 0),
  gapMsOfSample: files.reduce((a, f) => a + f.ciGapMs, 0),
  namedMsByKind: {
    "pure-function": files.flatMap((f) => f.named).filter((n) => n.kind === "pure-function").reduce((a, n) => a + n.caseMs, 0),
    "no-single-function": files.flatMap((f) => f.named).filter((n) => n.kind === "no-single-function").reduce((a, n) => a + n.caseMs, 0),
  },
  files,
};
process.stdout.write(JSON.stringify(out, null, 1));
```

### leaders.mjs

`node leaders.mjs render` and `node leaders.mjs compile`: the leaf frames of one bucket summed over every warm profile, which the colour and loader figures above are read from.

```js
// Top leaf frames of one bucket, summed over every sampled file's warm profile (local ms).
// usage: node leaders.mjs <bucket> [pass]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "./analyze.mjs";

const [bucket, pass = "warm"] = process.argv.slice(2);
const root = "/tmp/hf7/prof";
const sum = new Map();
let total = 0;
for (const name of readdirSync(root).filter((n) => n !== "baseline")) {
  const dir = join(root, name, pass);
  const f = readdirSync(dir).find((n) => n.endsWith(".cpuprofile"));
  const { lead, ms } = analyze(join(dir, f), true);
  total += ms[bucket];
  for (const [k, v] of lead[bucket]) sum.set(k, (sum.get(k) ?? 0) + v);
}
import { writeFileSync } from "node:fs";
writeFileSync(`/tmp/hf7/leaders-${bucket}.json`, JSON.stringify({ totalMs: total, frames: [...sum].sort((a, b) => b[1] - a[1]) }));
console.log(`${bucket} total local ms ${total.toFixed(0)}`);
for (const [k, v] of [...sum].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(v.toFixed(0).padStart(7), k);
```

### check-refs.mjs

```js
// Every `src/path.ts:symbol` the classifiers named: the file exists and the symbol's last word is in it.
// usage: node check-refs.mjs <repo-root> <numbers.json>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [root, numbersPath] = process.argv.slice(2);
const n = JSON.parse(readFileSync(numbersPath, "utf8"));
let checked = 0;
const bad = [];
for (const f of n.files) {
  for (const e of f.named) {
    for (const field of [e.pureFunction, e.decisionMadeAt]) {
      if (!field) continue;
      for (const m of field.matchAll(/(src\/[\w./-]+\.ts)(?::([A-Za-z_][\w.]*))?/g)) {
        checked++;
        const [, path, sym] = m;
        if (!existsSync(join(root, path))) {
          bad.push(`${f.file}: ${path} does not exist`);
          continue;
        }
        const word = sym?.split(".").pop();
        if (word && !readFileSync(join(root, path), "utf8").includes(word)) bad.push(`${f.file}: ${word} not in ${path}`);
      }
    }
  }
}
console.log(`checked ${checked} references; ${bad.length} bad`);
for (const b of bad) console.log(b);
```

### The readers' instructions

Given to the four readers up to the last heading; each reader's own quarter of the 31 files and its output path followed it, and are not reproduced here. "The output path below" and "your files" in the text refer to those. A later reader of this document can apply the same test.

> You are doing read-only analysis for a test-suite investigation in the TypeScript repo at /Users/bmf/code/cc-candybar/.claude/worktrees/hf7 (a git worktree; read files there, do not cd elsewhere).
> 
> HARD RULES
> - Read only. Do NOT edit, create or delete anything under that repo. Do NOT run jest, pnpm test, tsc, a build, or anything CPU-heavy: another process is timing test runs on this machine and any load you add corrupts its numbers. `rg`, `Read`, `wc`, and node scripts that only parse the JSON files named below are fine.
> - The only file you write is your output JSON, at the path given at the bottom.
> 
> BACKGROUND
> The question being answered: for the slowest test files, which test cases RENDER EVERYTHING to assert a decision that ONE PURE FUNCTION makes? Those are the cases a later change will replace with an exhaustive test directly on the pure function, leaving a few representative rendered cases. The answer must be exact, because someone will shrink a sweep on the strength of it: a case wrongly named here gets its coverage cut while no pure function actually proves the claim.
> 
> A case (or one sweep/loop/test.each row set inside a case) QUALIFIES as kind "pure-function" only if ALL hold:
> 1. It drives rendering: it builds a bar/config/runtime and draws frames, rows, or bytes through the product's render pipeline (more machinery than the function under decision needs).
> 2. The thing it finally asserts is settled by the output of ONE named function under src/ that is pure (no I/O, no clock, no module state): feed that function the same inputs the render passes it and the same claim could be asserted without rendering anything. You must find that function by reading src/, and confirm the render path calls it for the asserted value. Give it as `src/path.ts:exportName`.
> A case that satisfies 1 but whose decision is spread across several functions, or is made inside the render code itself with no function you could call alone, is kind "no-single-function": give where the decision is made (`src/path.ts:symbol`) and say what seam would be missing. These are valuable findings; do not force them into "pure-function".
> Everything else is NOT named: cases that need the whole pipeline because the claim is about the assembled output (layout across segments, wiring, ordering, interaction state machines, I/O, watchers, processes, docs examples being valid, snapshot of final bytes the claim is about), cases whose time is not rendering, etc.
> 
> Examples of WRONG output (do not produce these):
> - Naming a case because its title says "colour" or "format" without reading the assertion and the src function.
> - Naming a pure function that the render calls but whose output does not by itself settle the assertion (e.g. the assertion is about a final byte stream that also depends on layout and the writer).
> - A pure-function path that does not exist, or an exported name you did not confirm with rg.
> - Marking every test.each row of a file as qualifying without reading what each asserts.
> Prefer a short, correct list over a long list. If no case in a file qualifies, say so and say what the file's time actually is.
> 
> WHERE THE DATA IS
> - Test files: relative to the repo root, listed below. Read the whole file and the helpers it imports from test/helpers/ as needed.
> - Case names exactly as the suite records them, with durations, in /tmp/hf7/runs/41476365861/unit.jsonl and /tmp/hf7/runs/41476365861/worker.jsonl: one JSON object per line, `file`, `durationMs`, `cases[] {name, outcome, durationMs}`. A file's `name` strings are the full title joined by " › ". Use these exact strings in your output. Some files moved since older runs; use this run (41476365861) only. If a file is absent from both, say so.
> - Each file's time on CI is `durationMs`; the sum of its cases' durationMs is less, and the difference is load/setup outside any case. Report both numbers from the record.
> 
> WHAT TO RETURN
> Write a JSON array, one object per file assigned to you, to the output path below. Each object:
> {
>   "file": "test/....test.ts",
>   "ciFileMs": <durationMs from the record>,
>   "ciCasesMs": <sum of cases' durationMs>,
>   "whatTheFileIs": "one sentence: what behaviour it proves",
>   "whereItsTimeGoes": "from reading the code, one or two sentences: e.g. N cases each rendering the default bar; one beforeAll compiling; a sweep of A x B x C inside one case. Say 'unverified' for any part you could not tell from the code.",
>   "named": [
>     {
>       "kind": "pure-function" | "no-single-function",
>       "caseNames": ["exact record name", ...],   // all cases sharing this reason; or the one case holding the sweep
>       "sweep": "if the render-everything loop is inside the case, describe it (e.g. 'for every theme x 6 views'); else null",
>       "pureFunction": "src/path.ts:exportName" | null,
>       "decisionMadeAt": "src/path.ts:symbol or null (required for no-single-function)",
>       "why": "<= 3 sentences: what is asserted, the file:line where the render result is reduced to the asserted value, and why the named function's output alone settles it (or what seam is missing)"
>     }
>   ],
>   "considered": [ { "caseNames": ["..."], "whyNot": "one sentence" } ]   // up to 4 closest cases you rejected
> }
> Be precise; file:line references must be ones you actually read.
> 
> YOUR FILES
>
