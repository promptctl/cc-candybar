# Sources, payload, and what a Draw reads

A subagent's read-only inventory of the code at commit 10f26ceb, kept verbatim so the investigation isn't repeated. Verify a claim against the code before building on it. Decisions live in the design docs, which override anything here.

---

I did not write `/tmp/ccb-probe/findings-sources.md`. This agent runs read-only, is forbidden from creating files (including under `/tmp`), and has no write tool. The full findings are below, so the parent needs to save them if a file is required.

**Summary:**
- A key is a pure function of payload, picks and config, so Draw can evaluate it. Facts should run read and parse, and Draw should fold defaults.
- Moving keys across the wire breaks the in-turn chained-wait guarantee, unless the wait lives in Draw.
- The repo gate is no same-UID boundary. `today` holds a first bar in two places, and closure gating can be deleted except for a doctor-only walk. PR must leave `waitsOf` before it goes always-on.

the repo root = `/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind`. I assume statusline requests still arrive at Facts, since no split design exists in the repo. Everything is from code read at HEAD `10f26ceb`; nothing was executed.

---

## 1. Cache policies

| Policy | Validated | Evaluated (`src/var-system/sources.ts`, `registerCachePolicy`) | Reads | Fires |
|---|---|---|---|---|
| `ttl` | `src/config/loader/cache.ts`; lowered by `toCachePolicy` in `src/dsl/render.ts` | First read at declaration, then `TtlBucketManager` (one `setInterval` per duration). `clampShellCache` floors shell at 500 ms; `file` has no floor | Nothing | Period re-read |
| `watch_file` | Same; path must be absolute | First read at declaration, then `PathWatches` over `WatcherRegistry` (`watchTargetsOf`) | Disk link chain; `catchUps` re-reads after a file-event gap | Change re-read, plus a standing watch fault |
| `key` | Same; non-empty; `checkPolicyInstant` in `src/config/loader/cross-ref.ts` refuses the instant | `engine.parse(policy.template)` once, then `onReads` (a MobX `reaction`, `fireImmediately`) evaluates over `buildScope(this.store)` | Any variable in the store, its parent, and drawn depth via `readableOn` | First answer, then a differing answer (`readUnder`) |
| `depends_on` | Same; cross-ref refuses unknown names and projections | `onReads` over `store.changeKey(name)` joined with `,` | Named stores. Scalars use `String(value)`, a throw becomes ` failed:<msg>`, documents use `documentKey` | As `key`; any pending dependency holds it |
| `never` | Same | One read at declaration | Nothing | Once per registry |

**Details that matter:**
- A `ttl` timer is not gated by holds. It runs from declaration until the registry is disposed. The memory rule "periods run only while held" covers owners, not user sources.
- A key is not a cache key. No answer is stored per key value, so A→B→A runs again. It is an edge detector.
- `shellReader` passes no `timeoutMs`, so a user shell has no timeout. Only `TrailingEdge` serialises it, per variable.
- A key or `depends_on` has no run-rate floor; `docs/render-path-subprocess-accounting.md` says so.

**What crosses the wire if Draw evaluates and Facts runs:**
- Draw→Facts, once: source spec (reader, cwd, policy, parse).
- Draw→Facts, on change: `(sourceId, keyValueHash)`. For `ttl`, `watch_file` and `never`, nothing after declaration. Timers, watches and floors stay in Facts.
- Facts→Draw: reading, `at`, policy fault, and whether a new-key run is out.

**Can a key be pure in Draw? Yes.**
- It is parsed by the registry's own engine and reads only the store.
- `createCcCandybarEngine` wires sprig defaults, strings, lists, math, conversions, flow, dicts, non-clock dates, rich-text functions and formatters.
- Clock functions are registered but refused at load: `checkPolicyInstant` calls `instantReadOf` in `src/config/loader/projections.ts`, and that also covers projections (`today`, `feeds`, `drawing`, `diagnostics`).
- A grep of `src/template-engine` found no `fs`, spawn or `process.env`.

Caveats:
- `formatInteger` uses host locale (`toLocaleString`, `src/template-engine/funcs.ts`), so two Draws with different locales get different key values. That only costs sharing.
- Keys are parsed with no helper set, while `value-reads.ts` folds helpers. I did not determine how a key calling `{{ template }}` behaves.
- I did not audit rich-js function bodies; purity there rests on its comment in `engine.ts`.
- Keys may legitimately read Draw-only values such as `.theme.effective`. Facts therefore cannot evaluate them, and the value must arrive opaque.

**Cycles:**
- `validateNoCycles` (`src/config/loader/cycles.ts`) refuses any closed graph over template, `cache.key` and `cache.depends_on`, so a shell key reading a shell that keys back is a load error.
- `checkRuleSlotReads` refuses a globals rule reaching a slot's `.effective` through a source's key.
- An acyclic chain (B keyed on A) survives, but it breaks one invariant. `inFlight` relies on a reaction marking B *before* A's run ends, so "A run one of them triggers … is marked before the run that triggered it ends". Across a wire, A's landing empties Facts' wait before Draw's new key arrives.
- New exposure: if identity unifies sources across Draws, two configs can form a loop neither loader sees. Draw 1 keys X on Y, Draw 2 keys Y on X. It needs outputs that keep changing, and there is no floor.

**Identity:**
`digest(kind, command | (path, readMode), cwd, parse{kind, regex source}, policy normalised after clamp, keyValueHash or "")`
- Exclude `default` (see Q2).
- Exclude the key template, because the value decides.
- Hash the key value, because it may carry payload text.

**Scope mapping (`src/dsl/variable-scope.ts`):**
- Directory means one run per render-cache entry `(projectDir, cwd, configFile)`.
- View means the policy reaches a view value, `null` reads included, by fixpoint.
- Under identity, scope stops deciding runs. A directory source's key is constant so the id is shared; a view source's id varies only with what it reads. Sessions with equal key values now share a run, which they do not today.
- Sharing also crosses `configFile` entries. `cwd` still separates directories.

**Parity traps:**
- A Draw entering a key must trigger one re-read, not take a held answer. Key-policy answers have no period, so another holder's may be arbitrarily old.
- During a key move, today's value stays until the new run lands, so a new id must not read as empty.
- `never` re-runs today on any rebuilt registry. Facts must define this by holds.

**Recommendation:** Draw evaluates key and `depends_on`, and Facts owns ttl, watch, never, floors and the run table. Keep the per-Draw name→reading binding in Facts so a moved key keeps its last reading with `newKeyOut: true`. Put the request's wait in Draw (Q7), which restores the chained-wait guarantee. Add a Facts per-id run floor for cross-Draw loops.

## 2. Parse, and how each state reaches the bar

Today the path is read → parse → publish, in `declareSource`.

| State | Today | Reaches |
|---|---|---|
| Scalar first read outstanding | Box already holds default, or `default_empty_value`, or `""`. **No pending state** | Bar shows the fallback; `newKeys` makes requests wait |
| Scalar failed (read or regex no-match) | `orElse(outcome, fallback)`; reason only in `lastErrors` | Bar shows fallback, indistinguishable. `getLastError` has one reader, `src/daemon/debug.ts` (`cc-candybar vars`) |
| Json, no default, unanswered | `PENDING` | Loading cell |
| Json with default | `ok(default)` before the first scan | Default |
| Json read failed, or blank (blank→`ABSENT`) | Default stands in if declared | Otherwise failed/absent, surfaced by the scope proxy |
| Json parse failed | Default does **not** stand in | ⚠ naming the variable; a torn read holds the old document for `TORN_WRITE_SETTLE_MS` |
| Policy fault (key throw, watch fault) | `policyFaults`, observable | `drawDsl` emits a `refresh` warning, counted by the indicator; `getLastError` joins it; value stays |
| Template failure | Throws unless `default`; recorded either way | ⚠ cell or default |
| Input missing | Default chain, recorded | Fallback, `vars` |

**Source state beyond the value:**
- outcome class and reason, with `where` embedded in the reason text
- whether a failure came at read or at parse (json default turns on it)
- `lastErrors {timestamp, message}`
- `policyFaults {timestamp, message}`
- `lastChangedAt` / `lastUpdatedMs` (the `ageMs` in `vars`)
- `newKeys`, `runs`, `askedBy`
- the `TrailingEdge` queued trigger
- `readUnder`
- `settling` timer and `showingRead`
- ledger record (`var.<name>`, scope, trigger, outcome, ms)
- `PendingValueError`'s named variable
- the structural-compare rule that a value moves only when it differs (`documentKey`), which feeds rest on via `published()`

**Recommendation:** run read and parse in Facts, because dedupe, torn-write settling and the failure text all need the parsed outcome and a timer. Send a `Reading` plus `failedAt: "read" | "parse"`, `at`, and `fault`. Fold `default` and `default_empty_value` in Draw as a pure function, so two Draws differing only in default share a run. `torn` depends on `showingRead`, not on the default, so it can stay in Facts. Draw must map pending→fallback for scalars and for json-with-default, or scalar sources gain loading cells that do not exist today. Draw records `last_error` from the reading, so `vars` keeps working. Key the ledger by source id, because `var.<name>` is not unique across Draws. Separately: a failed scalar is silent on the bar today; carrying the reason would let you fix that, and it is a behaviour choice.

## 3. Repo gate

**Where:** `gateRepos` (pure, `src/config/loader/repo-gate.ts`) is called from `resolveDslConfig` in `src/config/loader/discovery.ts`. Answers come from `repoConfigs().read()` (`src/daemon/repo-configs.ts`) in `loadFromDisk`; `durableConfig` uses the same resolve.

**What it gates:**
- cwd and project config layers, filtered by `repos.approved` *before merge*
- the project's `.cc-candybar/plugins/`, through the stamped `ApprovedRepo` given to `installedPlugins`

**What it does not gate:** the user's XDG file, explicit paths (`configFile !== undefined` makes `repo: null`), and user or package plugin roots.

**Trust story:**
- The socket is `/tmp/cc-candybar-<uid>/socket`, parent verified owner-only 0700, not a symlink (`ensureOwnedPrivateDir`, `src/daemon/paths.ts`).
- A grep of `src/daemon/*.ts` found no peer-credential check, and requests carry no authentication. The boundary is filesystem permission.
- A same-UID process can already run any shell today: `--config` or `configEnv` names a file, and explicit paths never ask. It can also edit the XDG config or `repo-configs.json`, and read 0600 `link.key` to forge links.
- So attach adds no capability. The gate defends against a *cloned repository's contents*, not a same-UID process. Claiming otherwise would be false.
- Not examined: whether a repository's own Claude Code settings can set `CC_CANDYBAR_CONFIG` and so reach the explicit path.

**Checks that assume the daemon loaded the config:**
- `ApprovedRepo` is a compile-time stamp and does not survive a wire.
- `ValidatedConfig` has `validateRenderable` as sole producer; wire data is not one. The regex capture, absolute path, instant and cycle checks all live in the loader.
- `clampShellCache` sits in the registry.
- `runOf` reads `ctx.configFor(origin).actions` to rebuild the signed declaration, and `ctx.sourcesFor(origin)` for storage keys (`src/daemon/verbs/index.ts`).
- `stateGate` and `configGate` read `sessionConfig`.
- `navigation` depth uses the session config's gate.
- `ManagedStorage` assumes builds in the daemon. `UNOWNED_STORAGE` is what a build outside uses, and it creates and watches nothing.

**A shell declaration from a Draw:** provenance is lost at merge, because a variable carries no source file. The honest flow:
1. Facts sends the answer book to Draw.
2. Draw's load calls the same `resolveDslConfig`, so unapproved layers never exist.
3. The declaration message carries the chain's layers (`path`, `scope`) and each source's identity.
4. Facts re-runs `gateRepos` over those layers and refuses repo-scope layers not approved, returning a failed reading that names the repository.
5. Facts re-runs a declaration validator: absolute path, regex capture, shell floor. Sharing the loader's specs avoids a second definition.

**Recommendation:** gate in the one resolve, recheck at Facts, and document the recheck as a consistency guard, not security. A dev Draw's explicit config passes unasked, matching `--config` today. Do not add socket auth for this split, since it would not change the same-UID picture.

## 4. `env` from the client

**Today:** `declareEnv` reads `process.env` once at declaration, scope `directory`. It therefore reports the spawning shell of a detached daemon, which is the exact thing `CLAUDE.md` calls wrong for session facts. `src/config/default-dsl-config.ts` already avoids it for `host.ssh`, and `docs/segment-authoring.md` says shells run with the daemon's environment.

| Option | Mechanism | Cost |
|---|---|---|
| A. Facts reads it | Draw declares a name, Facts returns a reading | Tiny wire addition. Exact parity, the same wrong-for-session semantics, and prod and dev Draws agree |
| B. Draw's own `process.env` | No wire | Dev Draw sees the dev shell; prod and dev disagree silently. Breaks "Facts owns I/O" if `process.env` counts as I/O |
| C. Full env hint | Client sends the environ each request | Persisted to disk: `recordRequest` writes hints into session state, so secrets land in `session-state.json`. Also per-render cost inside a 150 ms budget (`TOTAL_BUDGET_MS`), both runtimes, `check-protocol` rows |
| D. Learned name list | Response carries `envNames`; client reads only those next time | The native client is one-shot (`fn main` → `render`), so it must persist names per session; `write_last_render` shows a per-session file already exists. First request has no value (needs pending). Both runtimes change. An additive field fits the absent-means-old-client rule. `env` moves to `view` in `KIND_SCOPE`. Union across Draws. Names travel in responses |
| E. Fixed vocabulary | A named hint per fact, like `terminalEnv` | Cheap and honest, but removes `env` as a user API. Requires a release per name |
| F. Handshake in one connection | Daemon asks, client answers, then the render | Extra round trip inside the budget; native client request loop rewritten; every render pays |

**Recommendation:** take A for the split. It changes nothing and keeps the wire small. If session-accurate `env` is wanted, D is the only option meeting all constraints, as a separate change with its pending state designed. Avoid C for the persistence alone. Owner's stated expansion points are `file` and `shell`, so `env` does not justify client work now.

## 5. Everything else a load or draw reads

| Input | Read in | Class |
|---|---|---|
| Repo answer book, plus changes (`answersWatch`) | `loadFromDisk`, `RenderCache` | Facts, **wire** |
| `projectDir`, `cwd`, hook data, hints | Request | Facts, **wire** |
| `configFile` (pick > `--config` > `configEnv`) | `sessionRenderOrigin` | **Wire**, or a Draw override |
| Config files, candidates, collisions | `discovery.ts`, `dsl-loader.ts` | Draw |
| `XDG_CONFIG_HOME`, `XDG_DATA_DIRS`, `XDG_DATA_HOME`, `HOMEBREW_PREFIX`, homedir | `discovery.ts`, `plugin-folders.ts` (process env) | Draw, so a dev Draw may differ from prod |
| Plugin roots, definitions, `{checkout}` paths (`checkoutOf`, `worktreeLink`: fs, no spawn seen) | `plugins.ts`, `git-root.ts` | Draw |
| `DEFAULT_DSL_CONFIG`, themes, presets, `BUNDLED_PRESETS` | Code; no fs found in `src/themes` | Draw (per build) |
| `storage.keyFor` (mkdir, generation), `storage.watch` | `declaredSources`, `buildRenderState` | Facts, **wire** (`StorageKey`) |
| `loadKey`, `compileKey`, compile, `CompileInput` | `render.ts` | Draw |
| `authoredRoots`, `fileHeldSettings`, `configPath`, `unused`, `dropped`, `buildWarnings`, `plugins` | State build | Draw |
| `default_empty_value`, `resolveEffectiveGlobals`, `settingCounts` | Pure | Draw |
| `ledger`, `catchUps`, source watches | `StateDeps` | Facts |
| Config-file watch (`watchTargetsFor`) | `RenderCache` | Recommend Facts holds it for Draw, see below |
| `sessionState` picks, `state` variables, revision | Daemon store, disk | Facts, **wire** |
| History depth | `SettingsHistory` | Facts, **wire** |
| Navigation depth | Steps plus the config's gate | Steps **wire**, computed in Draw |
| Signer | `linkSignerFromKeyFile` | Draw reads the key, already a multi-process pattern (daemon, `check`, demo) |
| `home`, `resumeCommand`, `term.cols` | `projectPayload` | Facts (`home`); pure for the rest, from payload |
| Lanes | Owners | Facts, **wire** |
| Instant, `DrawSelection`, `SessionEffects`, `menuIdle`, `renderWarnings`, cell sink, `copies` | `server.ts` | Draw |
| Template functions | Compile | Draw; the only secret-bearing one is `actionRuntime.signer` |

Unresolved: who owns `menuIdle`'s close and `click-error`'s `answered` write. Both act on session state from the draw path; I did not trace all writers. A grep of `src/dsl` and `src/render` found no `sessionState.set`.

**Recommendation:** Draw owns config reading, since its config is its identity rather than session data. Have Facts hold config watches through `watch(paths) → changed`, because `fileEvents` is one owner per process and a separate Draw process would have its own unjudged stream. Send the session state as a picks map in the payload.

## 6. Projections and diagnostics

All are composed in `drawRender` (`src/daemon/server.ts`).

| Producer | Source | Owner |
|---|---|---|
| `errors`: refused args, `hintsError` | Request checkpoint | Facts |
| `errors`: `entry.lastError`, `state.dropped` | Load | Draw |
| `errors`: `updateWatch.error()` | Act files | Facts |
| `errors`: `clickShown` | `clickErrorAt` | Facts-stored, shown per Draw |
| `updates` | `updateNotice(update, act, ctx)`: pure fold over facts, `dismissed`, `enabled` | Facts publish `update` and `act`; Draw folds |
| `questions` | `repoQuestions(entry.repos, …)` signed | Draw, since awaiting depends on its chain |
| Standing `file-events`, `lifeline` | `fileEventsWarnings`, `lifelineWarnings` in `src/proc/launch.ts` | Facts |
| Standing `config-watch`, `load` | Entry | Draw (watch fault arrives from Facts if Facts holds it) |
| Render warnings `rule`, `when` | Draw walk, `RenderWarningRecords` (`src/daemon/render-warnings.ts`) | Draw |
| Render warning `refresh` | `cachePolicyFaults` | Mixed: key faults are Draw's, watch faults arrive on the reading |
| `feeds` | `frameFeeds.feedsOf(sessionId, at)` | Whoever delivers frames |
| `drawing` | Caller | Draw |
| `today` | `todayOf`: lane sums plus `at` | Facts send day sums; Draw picks the day at `at` |

`collectDiagnostics` and `diagnosticsProjection` (`src/render/diagnostics.ts`) are pure and stay in Draw. Note the feed path: `feedsOf` counts sends, and I found no design for how a dev Draw's frames are delivered, so ownership of `feeds` is undecided.

**Recommendation:** add `facts.diagnostics: [{about, level, text, copy}]` to the payload, covering file events, lifeline, update-act and request refusals. Add per-source reading and fault. Draw merges them into its one list, so a dev Draw's indicator shows Facts faults through the existing fold. Being payload, they also wake feeds through the `changed` reaction. Keys cannot read `diagnostics`, because it is a refused projection, so this adds no policy path. A failed source reaches the indicator only if it is a policy fault or ⚠ cell; the indicator does not count failed scalars today.

## 7. Blocking

**Budget:** `waitBudgetMs` is `min(clientEnd, accepted + 200) − 40`. With the native 150 ms client that is roughly 110 ms from the client's clock. `waitWithin` bounds everything, so nothing can hold past it. "Holds a first bar" means spending the whole budget.

**First request waits on (`drawAnswer`), all together:**
- `refreshPayload`: session, today, context, metrics, activity, cache, speed, autocompact
- `waitsOf`, re-checked through `answered`: git, tmux, hostName, hostUser, today, every plugin source, and the PR when pending `unread`
- `registry.inFlight`: view and directory runs answering a new key

Also, a config's first request compiles in its arrival turn, which the memory says can spend the whole deadline. That is unaffected by lanes.

**`today` holds in two places:**
1. `lanes.today.current()` in `waitsOf`.
2. `session.today` in `src/daemon/cache/session-usage-store.ts` awaits `laneOutcome(today)` first.

**Change needed:**
- Remove `today` from `waitsOf`.
- Make the `today` refresh not await the scan. The scan-first order exists so a seed and a request do not cold-parse one session twice. With `session` always on, that lane starts the same `once()` concurrently anyway, and `ingest`'s re-fold handles collisions. So the `today` lane has no remaining purpose and can leave `refreshPayload`.
- `today` then draws pending and lands through its reaction on the next frame or poll. `RefreshLane` and `RefreshFaults` lose one member.

**PR lookup (`src/daemon/cache/git.ts`, `src/segments/git.ts`):**
- Spawn: `gh pr view --json number,state,url,headRefOid` or `glab mr view --output json`, category `forge`, 5 s timeout, one in flight per key. A non-forge remote spawns nothing. A missing CLI reads as absent.
- Frequency: on a new key (branch or remote) not in the 16-key `seen`, then per `PR_PERIOD`: 5 min after ok or absent (12 per hour), 45 s after failure (80 per hour), per held repo root, measured from last landing.
- Limits: holds (a view dies 2.5–5 minutes idle), `seen`, `inFlight`.
- No limit: no `RATE_LIMITS` entry and no concurrency cap on `forge`; the code comment calls that a future option.
- Each git pass while shown also reads remotes, memoised in `remotesByConfig`; I did not read the invalidation.
- GitHub quota impact is not in the repo: unknown.

**Verdict:** the spawn rate is safe in the ok case. Three things must change first:
- PR is in `waitsOf`, so always-on would make every first bar in a repo, and every branch move (`renew(pr, "unread")`), spend the whole budget on a network call.
- An unauthenticated `gh` becomes 80 failed spawns per hour per held repo for users whose bar shows no PR, each recorded as a failure.
- Failures must not become a new bar error for those users.

**Recommendation:** remove PR and `today` from `waitsOf`. Add a `forge` concurrency cap. Back off repeated identical failures past 45 s. Then keep PR always on. Payload lanes that are local reads stay waited.

## 8. Removing closure gating

**Dependents beyond lanes:**
- `wantsOf` gates `refreshPayload`, `declareLanes`, `readLanes`, and `projectPayload`'s `want.burn`, `want.block`, `want.autocompact`. `weekly` has no gate; `block` does.
- `gitOptionsFromClosure` sets the option set, which keys `holdKey` and `optionsKey`, the spawn set, and the PR hold via `showPullRequest`.
- `server.ts` passes it to `prFactOf` for the event's `pr=` field.
- `settlePayload` wait composition follows from which lanes were declared.
- `sourcesRead` chooses which plugin sources are held. The payload reader `sourceReading` treats a missing name as a failure, so holds must cover every declared source.
- `openView`'s preset reaction, and `ViewDeclared.preset`, exist to redeclare on a preset move.
- `src/doctor/data-needs.ts` uses `segmentInputPaths`, `anyPathStartsWith`, `gitOptionsFromClosure`.
- `src/demo/dsl.ts`, `session-source.ts`, `setUpDraw` pass it through.
- Tests: `test/render-payload-gating.test.ts`, `test/frame-payload.test.ts`, `test/one-fold.test.ts`, `test/slash-gate.test.ts`, `test/helpers/payload-owners.ts`.

**Delete:**
- `buildNeededPrefixes`, `neededPrefixesByPreset`, `wanted`, `wantedOf`, `wantsOf`, `sourcesRead`
- `PayloadInputs.neededInputPaths`, `DslRenderState.neededInputPaths`
- the `closure` parameter of `Declare`, `declareLanes` and `gitAt`
- the `needed` parameters of the lane helpers, all `want.*` branches
- `prFactOf`'s `readsPr`
- `openView`'s preset reaction, `presetNow` and `ViewDeclared.preset`, unless some reader I did not find exists
- `showTag` is already dead: nothing sets it

**Replace:** `gitOptionsFromClosure` with one constant option set. `optionsKey`, the per-option `values` map and the `resume` reason then shrink to one value; do that as a follow-up.

**Keep:** `valueReads`, `payloadPathOf` (scopes, projections, cycles, rule checks). Move `inputClosure`, `segmentInputPaths`, `anyPathStartsWith` and `PR_FIELDS` to Draw or doctor config analysis, with `READS.pullRequests` rewritten over PR paths. Update its "cannot disagree" comment, since it stops being true of the render.

**Costs that arrive with deletion:**
- every view gets a tmux name spawn when it has a pane
- `committedAt` and remotes spawns
- three cold transcript folds on every first request
- plugin session reads for unplaced sources
- `today`'s 60 s rescan held by every view (comment measures ~75 ms over 6k transcripts)

**Recommendation:** delete as listed, landing Q7's wait changes first or in the same change, since otherwise every lane joins the first-bar wait. Hold plugin sources for every source the Draw's config declares.
