# Click verbs: reach, effects, and server state

A subagent's read-only inventory of the code at commit 10f26ceb, kept verbatim so the investigation isn't repeated. Verify a claim against the code before building on it. Decisions live in the design docs, which override anything here.

The reach classes, the dev rows and the Facts-or-Draw placement of state below belong to a retracted design: there is no refused verb and no dev renderer, and [../architecture.md](../architecture.md) places the state. The lists of what each verb and timer actually does remain accurate.

---

**I did not write `/tmp/ccb-probe/findings-verbs.md`.** This agent runs in read-only mode, which forbids creating files, including in `/tmp`, so the full findings are below instead of a path and summary.

the repo root = `/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind`. All 27 leaf verbs, `dispatch`, and `tmux-status-click` have rows, based on code read at commit `10f26ceb`.

## Main isolation hazards

1. **A settings click can reach Claude Code.** `journaled` compares lane switches before and after the click. If `experimentalStatusline` flips, `LaneSetups` sends SIGTERM to Claude Code and types a restart line into the pane's shell. So verb class alone does not give isolation: a dev Draw must never forward lane changes.
2. **Copying the state does not isolate it.**
   - `settings-history.json` holds absolute file paths and whole-file snapshots, so `undo` in a dev Draw could overwrite or delete the real config.
   - `render-origin` and `config-override` also lead `originHome` back to the real file. Paths must be remapped.
3. **Links carry no Draw identity.** A click is `{verb, value, clientVersion}`, so nothing in it says which Draw drew it. I did not read how the URL handler picks a socket.
4. **Undo skips some safeguards.** `undo`, `redo` and `rewind` call `writeConfigText` directly, skipping `commit`'s loader gate. Their session writes also skip the closing view, because `SettingsHistory` holds the raw store.
5. **A refused effect does not stop the click.** `dispatch` runs every effect even after one fails. A refusal should throw `BadVerbArgs`, which already holds the error on the bar, but the click's other effects still land.

## Verb table

**Baseline for every row that names a valid session:**
- `journaled` uses `history`, `navigation`, `sessionState`, `lanes`, `views`, plus `configFor` through `nestOf` or `lanesAt`.
- `dlog` writes the click event to `<state>/daemon.log`.
- `<state>` is `stateDir()`, normally `~/.local/state/cc-candybar`.

**Exceptions:** `copy`, `open-vscode` and `doctor-probe` are not in `SESSION_FIRST_VERBS`, so `journaled` has no session and skips the lane and view follow-ups. It still opens and commits empty journals.

**Touch codes:** P picks (`session-state.json`), SH settings history, NH navigation history (memory only), CF config file, CC Claude Code process or pane, TM tmux, OS another session, MA machine, SS source storage. Anything not listed is not touched by the handler.

**L** means the verb can move a lane switch, adding CC, TM and MA indirectly. The cases are under (1) below.

| Verb | DaemonContext fields beyond baseline | Files written | Programs launched | Touches | Class | In a dev Draw |
|---|---|---|---|---|---|---|
| `copy` | `dlog` | none | `/usr/bin/pbcopy` | clipboard only | host | Clipboard is outside your stated isolation; allow it. Needs a message to Facts if Facts owns all programs |
| `copy-diagnostic` | `diagnosticCopy`, `dlog` | none | `pbcopy` | clipboard; reads `renderCache.copies` | host | Same; text comes from the dev Draw's own frames |
| `open-vscode` | `dlog` | none | `/usr/bin/open -a "Visual Studio Code" <path>`; path is not gated | editor | host | Same as `copy` |
| `load-config` | `dlog` | `session-state.json` | none | P (`config-override`), not SH or NH; L | picks | Own copy. Shape check only: any absolute `.json`/`.json5` path. Later durable clicks would write to that path unless remapped |
| `set-state` | `configFor`, `dlog` | `session-state.json`; `settings-history.json` for setting keys or edit-mode toggles | none | P; SH for settings; NH for navigation keys; L | picks | Own copy. Lanes must not go to Facts |
| `step-state` | `configFor`, `dlog` | same | none | P, SH or NH; L possible | picks | Own copy |
| `toolbar-toggle` | none | `session-state.json` | none | P (`toolbar-expanded`), NH | picks | Own copy |
| `back` | `configFor`, `dlog` | `session-state.json`; `settings-history.json` if it crosses `EDIT_MODE_KEY` | none | P, NH; SH savepoint only through that key | picks | Own copy |
| `set-config` | `configFor`, `reloadConfig`, `dlog` | `home.path`, `settings-history.json` | none directly; see reload | CF, SH, OS (shared file); L | config | Own config copy, with `home.path` remapped |
| `step-config` | same | same | same | CF, SH, OS; L | config | Same |
| `reset-config` | same | same, plus `session-state.json` | same | CF, P, SH, OS; L | config | Same. `deleteValues` writes nothing if the file is unchanged or missing |
| `save` | same | same | same | CF, P (releases drafts), SH, OS; L | config | Same |
| `save-preset` | same | same | same | CF, P (clears all setting keys, sets preset), SH, OS; L | config | Same |
| `save-theme-default` | same | same | same | CF, P, SH, OS; L | config | Same |
| `delete-preset` | `reloadConfig`, `dlog` | same | same | CF, P, SH, OS (sessions in that preset fall to the floor); L | config | Same |
| `apply-layout-op` | `configFor`, `reloadConfig`, `dlog` | same | same | CF, P (ended placement keys), SH, OS; L possible | config | Same |
| `undo` | `history`, `reloadConfig`, `dlog` | Any `Change.file` in the step, or `fs.rmSync` if its value is null; `session-state.json`; `settings-history.json` | same | P, CF, SH; L | config | **Own history only, never a raw copy** (hazard 2) |
| `redo` | same | same | same | P, CF, SH; L | config | Same |
| `rewind` | same | same | same | P, CF, SH; L | config | Same. It does not close edit mode; a sibling effect does |
| `repo-config` | `links`, `reloadConfig`, `dlog` | `<state>/repo-configs/repo-configs.json` | none directly; see reload | No listed target except OS: the answers watcher reloads every entry; L | config (nearest; a per-user trust book, not the config file) | Own book. If Facts runs sources for it, a dev approval must not approve them for the live side |
| `apply-update` | `applyUpdate` | `<state>/update-act/<key>/<n>/{record.json,stdout,stderr,status}` | `pnpm build`, or `pnpm dlx <PACKAGE_NAME>@<ver> install`; the job outlives the daemon | MA, later a daemon restart | machine | Refused visibly |
| `doctor-run` | `doctor`, `doctorStores`, `clients`, `serving`, `bundle`, `dlog`, `arrival` | `session-state.json` (report keys); `doctor-clicked-terminals.json` if via link and terminal seen | `tmux display`, `ps`, `git`, `gh auth token` or `glab --version`, `osascript` or `fc-match`, each only when its branch applies | P; reloads config; reads settings chain and transcript; L possible | picks (nearest) | Report on its own copy. Probes need a read message to Facts |
| `doctor-fix` | as above | `claude-settings` fix: a Claude settings file, setting `env.<TMUX_TRUECOLOR_VAR>` or `statusLine.refreshInterval`; `post-mortems-read` fix: `doctor-post-mortems-read.json`; report in `session-state.json` | same | MA, P; the file changes take effect in live Claude Code sessions | machine | Refused visibly |
| `doctor-mark` | as above | `doctor-marks.json`, `session-state.json`, possibly `doctor-clicked-terminals.json` | same | P, per-user store | picks (nearest) | Own store and report; probes go to Facts |
| `doctor-probe` | `probes`, `arrival`, `dlog` | none | none | In-memory list only; read through daemon-stats | no class fits; picks is nearest | Probably Facts' job, since `cc-candybar doctor` reads it from the daemon it asked |
| `slash` | `configFor`, `claudeInput`, `dlog` | none | `tmux display`, `capture-pane`, `load-buffer`, `send-keys C-s`, `paste-buffer`, `send-keys Enter` | CC, TM | claude-code | Refused visibly |
| `run` | `configFor`, `links`, `sourcesFor`, `runs` | Unknown: whatever the program writes | The argv the link carries, under the session's env, 10 s limit | SS (`supersede`, then resume); P on failure (`click.error` on the raw store); effects otherwise unknown | no class fits; machine is nearest | Refused visibly. Facts must refuse it too: verifying a dev key proves nothing to the live side |
| `dispatch` | Union of its effects | Union | Union | Union; P for `click.error` on failure | Per effect | Classify each effect, never the whole click. It reaches only `LEAF_VERBS`, so no nesting |
| `tmux-status-click` (not in `VERBS`) | Not a `DaemonContext` user; `tmuxStatusLines.linkAt`, then `handleClick` | Those of the inner verb | Inner verb's, or `/usr/bin/open` or `xdg-open <url>` for a non-candybar link | TM read; otherwise as the inner verb | Inner verb's; host for a plain URL | Needs a message: Facts receives the click, and only the Draw that drew the frame can run it. Dev frames should stay out of the status line |

## (1) Click-triggered side effects outside verb handlers

**Lane setup (`laneClicked`, run after commit and deferred by `setImmediate`):**

| Lane and direction | Effect |
|---|---|
| `statusline` on | Reads the process table and environment using `ps`, plus `python3` on macOS. Runs `node <reader>` over the Claude binary. Sends **SIGTERM to Claude Code**, then types the attach line into the shell, which lands in shell history |
| `band` on | Runs `claude plugin marketplace add`, then `claude plugin install`, then types `/reload-plugins` |
| `pane` on or off | `tmux split-window` and `set-option`, or `kill-pane` |
| `tmuxStatus` | `tmuxStatusLines.observe`, which holds or releases the status line and then rewrites session options and the click binding |

- **Owed setups:** a click with no known request leaves the setup owed. It then runs at a later click or request (`arrived`), not during the click.
- **Failures:** setup failures land in `click.error` later.
- **Which verbs move a switch:** directly, anything that changes the effective `experimentalBand`, `experimentalStatusline`, `experimentalPane` or `renderer`.
- **Reloads count too:** `doctor-run` reloads inside the measured window, so an unseen hand edit gets attributed to that click and can trigger a setup.
- **Other sessions:** they get no lane setups from your click, but `arrived` re-evaluates their tmux status line on their next request.

**Everything else:**
- **Before the handler:** `menuIdle.clicked` restarts the idle clock, even if the click then fails. `laneMeter` reads `renderCache.hold`.
- **Idle timer:** `MenuIdle.fire` calls `closeIdleMenus`, which writes `closed` through the full journaled path. That is P and NH, can release the savepoint (SH), and runs the lane and view follow-ups, with no click involved.
- **Closing view:** every write through it also clears nested disclosures in the same transaction, and logs `close-nested`.
- **Commits:** `navigation.commit`, then `journal.commit`, which writes `settings-history.json`.
- **View follow:** `views.follow` calls `renderCache.follow`, which can build and move a session's view.
- **Reload:** `reloadInto` wakes feeds and rebinds watchers. A `built` result retires the old state, and its `SourceRegistry` is disposed.
- **Config sources:** `src/var-system/sources.ts` runs shell-command sources with `/bin/sh -c`. A code comment says a reload restarts every source.
- **File watchers:** `config-watch` reloads the entry again, and `answers-watch` calls `reloadEvery`.
- **State reaction:** `sessionState.revision` wakes the session's frame feed, and writes persist `session-state.json` asynchronously.
- **Click errors:** `dispatch` calls `holdClickError`, and `answeredClickError` later marks it at the request boundary.
- **After an update:** success triggers `binaryWatch.checkNow`, then `shutdown(0)`, which restores tmux and aborts runs.
- **After a run:** sources resume, and a failure lands in `click.error`.
- **Client timeout:** the click's effects still land after the client was told TIMEOUT.

## (2) Module-level mutable state in `server.ts`

| State | Class | Why |
|---|---|---|
| `sessionState` | Draw, with Facts input | Picks, but `recordRequest` writes `render-origin` and `client-hints` from requests |
| `settingsHistory`, `navigationHistory` | Draw | Stated split; the settings history is also a file writer |
| `effectSessions`, `renderWarnings`, `menuIdle` | Draw | Effect memory, warnings, and idle state fed by frames |
| `linkSigner` | Draw | Link key, though Facts cannot rely on it for `run` |
| `renderCache` | **Both; must be split** | Holds config, compile and copies alongside `SourceRegistry`, watchers and storage |
| `frameFeeds` | Draw mostly, split | Draws frames but also holds subscriber lanes and the latest requests that lane setup reads |
| `watcherRegistry`, `fileEvents`, `refreshLedger`, `payloadProviders` and destructured services | Facts | Watches, providers and data gathering |
| `paneVisibility` | Facts | Polls tmux |
| `tmuxStatusLines` | Facts | Writes tmux, but holds frame links from a Draw |
| `laneSetups` | Facts | Runs programs and signals, but is triggered by Draw's switch changes |
| `runs` | Facts | Owns program launches; failures write back to picks |
| `renderSightings` | Facts | What each request's client reported |
| `handlerProbes` | Facts (tentative) | Read through daemon-stats |
| `DOCTOR_STORES` | Unclear | Per-user files under state; neither side of your split names them |
| `binaryWatch`, `updateWatch` | **Unclear; both** | Each is tied to one bundle, and Facts and a dev Draw run different bundles. The watch also registers a validator Draw's gate reads |
| `stats`, `inFlight`, `shuttingDown`, `limits`, `budgetBytes`, `myStartTime`, `breakerRegistryPath` | Per-process | Each process needs its own |
| `verbCtx` | Not state; an aggregate | Its fields fall on both sides |

Other points:
- `EMPTY_RENDER_MAP` is a constant in use, and `DAEMON_BUNDLE` and `DAEMON_NODE` never change.
- Outside `server.ts`, `setLaunchStats`, the lifeline observer, and the validator registries are also process-wide.

## (3) Verbs crossing Facts and Draw

| Verb or group | Message that must cross |
|---|---|
| Durable config verbs and history | Your split conflicts here: Facts owns all I/O, Draw owns config. Either Draw writes its own files, or Facts takes `write{path, text}` and must refuse paths outside what that Draw may touch. Every such click then sends `sourcesChanged` so Facts reloads sources |
| Any lane-moving click | Draw to Facts: `lanesMoved{sid, before, after}`, live Draw only. Facts to Draw: `setupFailed{sid, text}` |
| `slash` | Draw to Facts: `typeSlash{sid, line}`, with the pane hint held by Facts |
| `run` | Draw to Facts: `run{RunRequest}`, Facts to Draw: `runFailed{sid, text}`. Storage keys come from Draw's config, and `supersede` runs in Facts |
| `apply-update` | Draw to Facts: `applyUpdate`. Facts to Draw: update facts for the notice and the dismiss gate |
| Doctor verbs | Draw to Facts: `gatherDoctorFacts{sid, origin, needs}`. `doctor-fix` also sends `writeClaudeSettings`, live Draw only |
| `copy`, `copy-diagnostic`, `open-vscode`, plain URLs | Draw to Facts: `host{copy|open}`, if Facts owns all programs |
| `tmux-status-click` | Facts to Draw: `linkClicked{url, via}`, sent to the Draw that drew the frame |
| `repo-config` | Draw to Facts: the answer, so Facts knows which sources may run |
| All clicks | Facts to Draw: `requestFacts{sid, origin, hints}`, because verbs fail with "has not rendered yet" without them |

## Not determined

- What `pnpm dlx ... install` changes; I did not trace `src/install` for it.
- Which files the `claude plugin` commands write.
- How the URL handler chooses a socket, so dev-click routing is unresolved.
- Whether sources restart at the reload itself or at the first draw afterwards.
- Whether `renderCache.hold` creates an entry; `getOrCreate` does by name.
- Whether a `step-state` click can reach a lane switch; the keys come from each config's gate, so I can't list them statically.
- What exactly the `500` passed to `FileSessionStorage` does.

**One code comment looks stale:** `journaled` says a history step can restore a load-config pick, but the literal `config-override` appears nowhere under `src` or `test` except `verbs/index.ts`, and `load-config` writes through the view that only records setting keys. So `undo` should not restore it.

## Key files

- `src/daemon/verbs/index.ts`
- `src/daemon/server.ts`
- `src/daemon/menu-idle.ts`
- `src/daemon/lane-setup.ts`
- `src/daemon/lane-edge.ts`
- `src/daemon/settings-history.ts`
- `src/daemon/navigation-history.ts`
- `src/daemon/config-file-store.ts`
- `src/daemon/repo-configs.ts`
- `src/daemon/runs.ts`
- `src/daemon/update-notice.ts`
- `src/daemon/update-act.ts`
- `src/daemon/tmux-status.ts`
- `src/daemon/cache/render.ts`
- `src/doctor/edge.ts`
- `src/claude-input/edge.ts`
- `src/click/read.ts` (`HOST_VERBS` is an existing, narrower list of the same idea)
