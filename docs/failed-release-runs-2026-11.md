# Failed Release runs, 30 October to 2 November 2026

Of the last 100 Release runs whose final attempt failed, 60 were flakes and 40 were real. Another 22 runs in the same four days failed their first attempt and passed on rerun; GitHub's failed-run list leaves them out, so they get their own table below. Timing explains 43 of the 60 flakes, state left behind by another test file 15, and a real external 2. The 100 runs span 494 Release runs, so about 20% of them ended red.

A flake here is a failure whose trigger lies outside the commit: scheduling, ordering, garbage collection, a wall-clock bound, or state a different test file left running. A real failure is one the commit or the product causes, which a rerun would not remove. The two kinds overlap in one place that matters: a failure can be nondeterministic and still be a product defect. Two groups below are exactly that.

The 40 real failures: 19 from the branch's own change; 9 from the frame feed's early-timer defect; 7 from a deterministic gate the commit fails (lint, typecheck, format, schema, ratchet); 3 from the close defect; 2 from the rich-js bump.

## Two product defects that read as flakes

**The frame feed drew one turn twice** (9 failed runs, 4 more that passed on rerun). `frame-feed`'s one-draw-per-turn case failed once on a pull request that touched no feed code, so a ticket suspected a wall-clock flake in the test. The cause was in the feed: a timer that fires slightly before its moment drew the same turn again and skipped the next. #566 fixed `src/daemon/frame-feed.ts` and added cases for the early timer; the failing case itself is unchanged.

**Timers keep arming after `daemon.close()` returns** (3 failed runs, 1 that passed on rerun). The `daemon-value` close case records every timer armed after close and expects none; on CI it reads 533 to 556. Every one has the same origin: the pull-request landing in `src/daemon/cache/git.ts`, which calls `Period.landed` and arms the next timer. That many arms in one test is a loop, so a repo state that close did not drop is still polling. The code's guards say that should be impossible, and I did not find why it is not; the first suspect is a render finishing after close and building a fresh state on a closed cache. #530 and #532 fixed the case's fixed sleep and the launches close waits for. It had no ticket, so this recount filed `brandon-unfiled-3248.q4r5`.

## What this gives plan tickets 7 and 22

**Plan ticket 22, Drawing (`candybar-testing-ihvy.ncz`).** The plan counted `daemon-render-event-e2e` in 8 of 23 failed runs at 8da9964e. This recount finds it in 18 of the 100. Almost all are one case, "a failed click's error is the render event's clickError: held, owed, then over" (17 runs, 4 more on rerun). The logic that case protects is the click error's held, owed and over states. `clickErrorAt` and `answeredClickError` in `src/daemon/click-error.ts` already own it and `test/unit/click-error.test.ts` already proves it. The race behind the failures, whether an answer written to a half-closed socket counts as delivered, is proven in `test/daemon-connection.test.ts` with a gated handler. That leaves one thing only the e2e shows: that the render event carries the click error's state at all, which is what the Drawing piece's tests would hold.

**Plan ticket 7, quarantine (`candybar-testing-ihvy.hcl`).** Two failing tests have a diagnosed cause and a ticket still open, so they are the quarantine list's candidates: `draw-reserve` (14 failed runs and 2 that passed on rerun, `brandon-unfiled-3248.tl8u`) and render-cache-sharing's gc case (6 and 2, `brandon-unfiled-3248.na7i`). `draw-reserve` fails because its p99 is the second-largest of 100 wall-clock samples, so two draws descheduled on the 4-vCPU runner break a 40 ms bound while the draw itself takes about 3 ms. The gc case asserts a `WeakRef` is gone after two `gc()` calls, which depends on when V8 collects.

Groups whose fix has landed and which have not failed since (a last failure counts runs that passed on rerun too):

- build-currency SIGKILL cases: last failure 2026-10-30 16:20 UTC, fix landed 2026-10-30 16:32 UTC (brandon-unfiled-3248.vfhf).
- blank-stack throws: last failure 2026-10-31 22:48 UTC, fix landed 2026-11-01 00:39 UTC (candybar-testing-0x6u.6el).
- the clickError case: last failure 2026-10-31 18:24 UTC, fix landed 2026-11-02 12:52 UTC (brandon-unfiled-3248.cbyb).
- frame-feed: last failure 2026-11-02 11:08 UTC, fix landed 2026-11-02 12:35 UTC (brandon-unfiled-3248.l1mh).

The clickError case moved onto the in-process harness on 31 October 20:30 UTC (#524), after its last failure and before its fix, so its quiet shows the move worked and says nothing about the fix. Each date is when a fix merged; a pull-request run on an older base can still fail afterwards.

## The groups

Every failing case falls in one group. A run is a flake only if all of its failing cases are; one real case makes the run real. A run with cases in two groups counts in both, so the columns add to more than the runs.

| Group | Runs | On rerun | Verdict | Cause | Evidence | Mechanism | Ticket |
|---|---|---|---|---|---|---|---|
| render-event clickError owed/over | 17 | 4 | flake | timing | ticketed | the test's gone client half-closes at once and assumes the daemon sees the FIN before it writes the answer; nothing orders the two | brandon-unfiled-3248.cbyb |
| blank-stack throw from another file | 17 | 3 | flake | shared state | ticketed | a wait left in flight by a finished test file expires later and jest charges its throw to whichever file is running | candybar-testing-0x6u.6el |
| draw-reserve p99 | 14 | 2 | flake | timing | ticketed | p99 of 100 wall-clock samples is the second-largest, so two draws descheduled on the shared 4-vCPU runner fail a 40 ms bound; the draw itself is ~3 ms | brandon-unfiled-3248.tl8u |
| build-currency SIGKILLed mid-act | 11 | 5 | flake | timing | ticketed | the test SIGKILLs the daemon before its throttled session-state write lands, so the successor restores the viewer open or takes over 5 s to render | brandon-unfiled-3248.vfhf |
| frame-feed one draw per turn | 9 | 4 | real | product defect, timing-triggered | ticketed | a feed timer that fires before its moment drew the same turn twice and skipped the next; fixed in the feed, not the test (#566) | brandon-unfiled-3248.l1mh |
| render-cache-sharing gc retention | 6 | 2 | flake | timing | ticketed | the case asserts a WeakRef is gone after two gc() calls, which depends on when V8 collects | brandon-unfiled-3248.na7i |
| lint, typecheck, format, schema or ratchet | 7 | 0 | real | the commit | read | a deterministic gate the commit fails every time | — |
| the branch's own change | 7 | 0 | real | the branch's own change | read | a case the branch's commit made wrong or a check it breaks; deterministic from that commit | — |
| daemon-git-cache while its branch was being written | 6 | 0 | real | the branch's own change | read | the same case fails on six consecutive commits of the branch that moves the git watch into the registry, until the branch's own commits settle it | brandon-unfiled-3248.pijr |
| daemon-value close, timers armed after it | 3 | 1 | real | product defect | read | after close returns, 533 to 556 timers are armed, all from the pull-request landing in the git cache's period; why close's guards do not stop it is unverified | brandon-unfiled-3248.q4r5 |
| the branch's own change (inferred) | 4 | 0 | real | the branch's own change | inferred | fails on a branch under construction and passes on its next commit after an edit to the test or the code it covers | — |
| in-worker-daemon stated deadline | 3 | 0 | real | the branch's own change | inferred | three consecutive commits of one branch fail the same assertion; the fourth passes after an edit to the test alone | — |
| render that outlives its timeout writes timedOut=Y | 2 | 0 | flake | timing | ticketed | the case bets a heavy compile finishes inside the wire helper's reply budget; CI's two cores lose the bet | brandon-frame-feed-znsy.dh1 |
| Release push rejected | 2 | 0 | flake | real external | read | semantic-release's `git push` to main was rejected (fetch first) because main moved during the run; no test failed | — |
| dependency bump | 2 | 0 | real | dependency bump | read | rich-js 0.25 made a module load order cyclic: `Cannot access 'pattern_js_1' before initialization` fails 200 test files | — |
| prompt count: render ended on its deadline | 1 | 0 | flake | timing | inferred | the event reads ended=deadline with pending=metrics.messageCount where the case waits for ended=answered; main's next run passes | — |
| daemon-value close read after a fixed sleep | 0 | 1 | flake | timing | ticketed | the case waits a fixed sleep for close's leftovers to settle and reads two live timers on a loaded runner | candybar-testing-0x6u.945 |
| client-deadline stated budget | 0 | 1 | flake | timing | ticketed | the stated-budget case fails CONNECT_TIMEOUT when the worker's own loop serves the stub late | brandon-unfiled-3248.5lkd |

## Method

The population is `gh run list --workflow release.yml --status failure --limit 100`: runs whose last attempt failed. For each, `gh run view --log-failed` gave the failing step, the failing jest files and cases, and each case's message and stack. A second population is every run in the same window with more than one attempt whose first attempt failed and whose last passed (`gh api .../runs/<id>/attempts/1`); a rerun that goes green is direct proof the commit was fine, so those get a cause and no verdict.

Each case was placed in a group by its message and stack, then by the lit tickets that diagnose it. Evidence is `ticketed` when a ticket names the mechanism (66 runs), `read` when the log's message or stack names it and I followed it into the code (27; for the close defect that is where the timers come from, and why close does not stop them stays open), and `inferred` when only the branch's next commit shows it, a pass after an edit to a test or the code it covers (7). The inferred runs are the least certain.

None of the 100 has a green rerun, since the list holds only final failures, so their verdicts rest on mechanism, not on a rerun.

## The 100 runs

Newest first. `on` is `main` for a push to main and `PR` for a pull request on the branch shown. Run links go to the Actions run. `Group` lists every group the run's failing cases fall in; the counts in the groups table are counted from this column, and `Failing` names files, which can differ from the case that failed.

| Run | When (UTC) | On | Failing | Group | Verdict | Cause | Evidence |
|---|---|---|---|---|---|---|---|
| [41464641125](https://github.com/promptctl/cc-candybar/actions/runs/41464641125) | 11-02 14:43 | PR candybar-launch-q7o7.6wi | render-cache-sharing, daemon-value | render-cache-sharing gc retention, daemon-value close, timers armed after it | real | product defect | read |
| [41463875343](https://github.com/promptctl/cc-candybar/actions/runs/41463875343) | 11-02 14:38 | main | render-cache-sharing | render-cache-sharing gc retention | flake | timing | ticketed |
| [41452103114](https://github.com/promptctl/cc-candybar/actions/runs/41452103114) | 11-02 13:20 | PR 0oo | daemon-value | daemon-value close, timers armed after it | real | product defect | read |
| [41433083227](https://github.com/promptctl/cc-candybar/actions/runs/41433083227) | 11-02 10:58 | PR qjw | in-worker-daemon | in-worker-daemon stated deadline | real | the branch's own change | inferred |
| [41432893795](https://github.com/promptctl/cc-candybar/actions/runs/41432893795) | 11-02 10:57 | PR qjw | in-worker-daemon, launch-group-end | in-worker-daemon stated deadline, the branch's own change (inferred) | real | the branch's own change | inferred |
| [41432632675](https://github.com/promptctl/cc-candybar/actions/runs/41432632675) | 11-02 10:55 | PR qjw | in-worker-daemon | in-worker-daemon stated deadline | real | the branch's own change | inferred |
| [41366785790](https://github.com/promptctl/cc-candybar/actions/runs/41366785790) | 11-02 00:22 | PR 43x | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41353935100](https://github.com/promptctl/cc-candybar/actions/runs/41353935100) | 11-01 21:49 | PR 43x | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41353342314](https://github.com/promptctl/cc-candybar/actions/runs/41353342314) | 11-01 21:41 | PR 43x | daemon-request-limits.process | render that outlives its timeout writes timedOut=Y | flake | timing | ticketed |
| [41351881808](https://github.com/promptctl/cc-candybar/actions/runs/41351881808) | 11-01 21:24 | PR 43x | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41351059288](https://github.com/promptctl/cc-candybar/actions/runs/41351059288) | 11-01 21:15 | PR 43x | daemon-value | daemon-value close, timers armed after it | real | product defect | read |
| [41336423169](https://github.com/promptctl/cc-candybar/actions/runs/41336423169) | 11-01 18:24 | main | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41306454221](https://github.com/promptctl/cc-candybar/actions/runs/41306454221) | 11-01 12:25 | main | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41305051149](https://github.com/promptctl/cc-candybar/actions/runs/41305051149) | 11-01 12:08 | PR jqq | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41301458328](https://github.com/promptctl/cc-candybar/actions/runs/41301458328) | 11-01 11:20 | PR jqq | process-tier daemon-start ceiling | lint, typecheck, format, schema or ratchet | real | the commit | read |
| [41296594729](https://github.com/promptctl/cc-candybar/actions/runs/41296594729) | 11-01 10:14 | PR brandon-menus-sjhy.5y2 | dsl-spine | the branch's own change | real | the branch's own change | read |
| [41295757517](https://github.com/promptctl/cc-candybar/actions/runs/41295757517) | 11-01 10:03 | PR brandon-menus-sjhy.5y2 | dsl-spine | the branch's own change | real | the branch's own change | read |
| [41293446779](https://github.com/promptctl/cc-candybar/actions/runs/41293446779) | 11-01 09:30 | main | daemon-prompt-count-e2e | prompt count: render ended on its deadline | flake | timing | inferred |
| [41288147258](https://github.com/promptctl/cc-candybar/actions/runs/41288147258) | 11-01 09:16 | PR feat/git-worktree-path | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41287830426](https://github.com/promptctl/cc-candybar/actions/runs/41287830426) | 11-01 09:11 | main | frame-feed | frame-feed one draw per turn | real | product defect, timing-triggered | ticketed |
| [41291848164](https://github.com/promptctl/cc-candybar/actions/runs/41291848164) | 11-01 09:09 | PR gp7 | launch | the branch's own change (inferred) | real | the branch's own change | inferred |
| [41284518435](https://github.com/promptctl/cc-candybar/actions/runs/41284518435) | 11-01 07:22 | PR rs0 | frame-feed | frame-feed one draw per turn | real | product defect, timing-triggered | ticketed |
| [41278244898](https://github.com/promptctl/cc-candybar/actions/runs/41278244898) | 11-01 05:46 | PR 71b | site | the branch's own change | real | the branch's own change | read |
| [41277874014](https://github.com/promptctl/cc-candybar/actions/runs/41277874014) | 11-01 05:41 | PR 71b | site | the branch's own change | real | the branch's own change | read |
| [41276583151](https://github.com/promptctl/cc-candybar/actions/runs/41276583151) | 11-01 05:20 | main | Release step: push to main rejected | Release push rejected | flake | real external | read |
| [41275424672](https://github.com/promptctl/cc-candybar/actions/runs/41275424672) | 11-01 05:03 | PR zrb | frame-feed | frame-feed one draw per turn | real | product defect, timing-triggered | ticketed |
| [41275369908](https://github.com/promptctl/cc-candybar/actions/runs/41275369908) | 11-01 05:02 | PR zrb | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41271350436](https://github.com/promptctl/cc-candybar/actions/runs/41271350436) | 11-01 04:00 | PR 425 | frame-feed | frame-feed one draw per turn | real | product defect, timing-triggered | ticketed |
| [41267354003](https://github.com/promptctl/cc-candybar/actions/runs/41267354003) | 11-01 02:59 | PR 0mz | frame-feed | frame-feed one draw per turn | real | product defect, timing-triggered | ticketed |
| [41264694866](https://github.com/promptctl/cc-candybar/actions/runs/41264694866) | 11-01 02:19 | PR a5k3 | frame-feed | frame-feed one draw per turn | real | product defect, timing-triggered | ticketed |
| [41263983705](https://github.com/promptctl/cc-candybar/actions/runs/41263983705) | 11-01 02:09 | PR keo | lint | lint, typecheck, format, schema or ratchet | real | the commit | read |
| [41263953117](https://github.com/promptctl/cc-candybar/actions/runs/41263953117) | 11-01 02:08 | PR keo | lint | lint, typecheck, format, schema or ratchet | real | the commit | read |
| [41259456554](https://github.com/promptctl/cc-candybar/actions/runs/41259456554) | 11-01 01:03 | PR 945 | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41256389658](https://github.com/promptctl/cc-candybar/actions/runs/41256389658) | 11-01 00:21 | PR 6el | frame-feed | frame-feed one draw per turn | real | product defect, timing-triggered | ticketed |
| [41254623078](https://github.com/promptctl/cc-candybar/actions/runs/41254623078) | 10-31 23:57 | PR settings-one-list-labelled-options | format (prettier) | lint, typecheck, format, schema or ratchet | real | the commit | read |
| [41254142119](https://github.com/promptctl/cc-candybar/actions/runs/41254142119) | 10-31 23:49 | PR brandon-menus-sjhy.ju8 | draw-reserve.process | draw-reserve p99 | flake | timing | ticketed |
| [41249819293](https://github.com/promptctl/cc-candybar/actions/runs/41249819293) | 10-31 22:48 | main | doc-snippets | blank-stack throw from another file | flake | shared state | ticketed |
| [41236694283](https://github.com/promptctl/cc-candybar/actions/runs/41236694283) | 10-31 19:58 | PR 1ur | daemon-render-event-e2e | render that outlives its timeout writes timedOut=Y | flake | timing | ticketed |
| [41234374953](https://github.com/promptctl/cc-candybar/actions/runs/41234374953) | 10-31 19:28 | PR 1ur | draw-reserve | draw-reserve p99 | flake | timing | ticketed |
| [41229284764](https://github.com/promptctl/cc-candybar/actions/runs/41229284764) | 10-31 18:24 | main | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41227534625](https://github.com/promptctl/cc-candybar/actions/runs/41227534625) | 10-31 18:03 | PR snf | var-sources, daemon-render-event-e2e | the branch's own change, render-event clickError owed/over | real | the branch's own change | read |
| [41217076611](https://github.com/promptctl/cc-candybar/actions/runs/41217076611) | 10-31 15:54 | PR c3x | in-worker-daemon | the branch's own change (inferred) | real | the branch's own change | inferred |
| [41212082538](https://github.com/promptctl/cc-candybar/actions/runs/41212082538) | 10-31 14:51 | PR spa-any-stream | daemon-log | blank-stack throw from another file | flake | shared state | ticketed |
| [41210328239](https://github.com/promptctl/cc-candybar/actions/runs/41210328239) | 10-31 14:29 | PR spa-any-stream | daemon-connection | the branch's own change | real | the branch's own change | read |
| [41157149656](https://github.com/promptctl/cc-candybar/actions/runs/41157149656) | 10-31 01:49 | PR erwl | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41152900265](https://github.com/promptctl/cc-candybar/actions/runs/41152900265) | 10-31 00:57 | main | daemon-log | blank-stack throw from another file | flake | shared state | ticketed |
| [41151924121](https://github.com/promptctl/cc-candybar/actions/runs/41151924121) | 10-31 00:45 | PR source-checkout-is-install | daemon-log | blank-stack throw from another file | flake | shared state | ticketed |
| [41151241156](https://github.com/promptctl/cc-candybar/actions/runs/41151241156) | 10-31 00:38 | PR source-checkout-is-install | metrics | blank-stack throw from another file | flake | shared state | ticketed |
| [41148221577](https://github.com/promptctl/cc-candybar/actions/runs/41148221577) | 10-31 00:05 | PR joiners-turn-press-34r | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41141087223](https://github.com/promptctl/cc-candybar/actions/runs/41141087223) | 10-30 22:53 | main | frame-feed | frame-feed one draw per turn | real | product defect, timing-triggered | ticketed |
| [41137830882](https://github.com/promptctl/cc-candybar/actions/runs/41137830882) | 10-30 22:23 | main | draw-reserve | draw-reserve p99 | flake | timing | ticketed |
| [41136622234](https://github.com/promptctl/cc-candybar/actions/runs/41136622234) | 10-30 22:13 | PR speed-10x | update-act | blank-stack throw from another file | flake | shared state | ticketed |
| [41136230283](https://github.com/promptctl/cc-candybar/actions/runs/41136230283) | 10-30 22:09 | PR speed-10x | schema drift check | lint, typecheck, format, schema or ratchet | real | the commit | read |
| [41131118459](https://github.com/promptctl/cc-candybar/actions/runs/41131118459) | 10-30 21:26 | PR site-nav | draw-reserve | draw-reserve p99 | flake | timing | ticketed |
| [41130839528](https://github.com/promptctl/cc-candybar/actions/runs/41130839528) | 10-30 21:24 | PR site-nav | daemon-log | blank-stack throw from another file | flake | shared state | ticketed |
| [41130246255](https://github.com/promptctl/cc-candybar/actions/runs/41130246255) | 10-30 21:20 | PR site-nav | daemon-click | blank-stack throw from another file | flake | shared state | ticketed |
| [41128901586](https://github.com/promptctl/cc-candybar/actions/runs/41128901586) | 10-30 21:09 | main | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41116756762](https://github.com/promptctl/cc-candybar/actions/runs/41116756762) | 10-30 19:37 | PR build-currency-e2e-ci-cuvv | doc-snippets | blank-stack throw from another file | flake | shared state | ticketed |
| [41112102509](https://github.com/promptctl/cc-candybar/actions/runs/41112102509) | 10-30 19:03 | main | frame-feed | frame-feed one draw per turn | real | product defect, timing-triggered | ticketed |
| [41111797434](https://github.com/promptctl/cc-candybar/actions/runs/41111797434) | 10-30 19:01 | PR joiners-depth-window-686 | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41109783461](https://github.com/promptctl/cc-candybar/actions/runs/41109783461) | 10-30 18:46 | main | doc-snippets | blank-stack throw from another file | flake | shared state | ticketed |
| [41107754379](https://github.com/promptctl/cc-candybar/actions/runs/41107754379) | 10-30 18:32 | PR 8uk | draw-reserve | draw-reserve p99 | flake | timing | ticketed |
| [41106263048](https://github.com/promptctl/cc-candybar/actions/runs/41106263048) | 10-30 18:21 | main | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41104093593](https://github.com/promptctl/cc-candybar/actions/runs/41104093593) | 10-30 18:07 | PR chl | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41101586015](https://github.com/promptctl/cc-candybar/actions/runs/41101586015) | 10-30 17:47 | PR chl | cli-check, daemon-render-event-e2e, render-cache-sharing | the branch's own change (inferred), render-event clickError owed/over, render-cache-sharing gc retention | real | the branch's own change | inferred |
| [41099247732](https://github.com/promptctl/cc-candybar/actions/runs/41099247732) | 10-30 17:29 | PR build-currency-e2e-ci-cuvv | daemon-render-event-e2e, daemon-broken-config-e2e | render-event clickError owed/over, blank-stack throw from another file | flake | timing | ticketed |
| [41091000333](https://github.com/promptctl/cc-candybar/actions/runs/41091000333) | 10-30 16:33 | PR qzx | typecheck | lint, typecheck, format, schema or ratchet | real | the commit | read |
| [41088149532](https://github.com/promptctl/cc-candybar/actions/runs/41088149532) | 10-30 16:15 | PR act-survives-killed-daemon-linux | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41084975455](https://github.com/promptctl/cc-candybar/actions/runs/41084975455) | 10-30 15:54 | PR 0mvx | daemon-build-currency-e2e | build-currency SIGKILLed mid-act | flake | timing | ticketed |
| [41084692088](https://github.com/promptctl/cc-candybar/actions/runs/41084692088) | 10-30 15:52 | PR act-survives-killed-daemon-linux | daemon-build-currency-e2e | build-currency SIGKILLed mid-act | flake | timing | ticketed |
| [41083691137](https://github.com/promptctl/cc-candybar/actions/runs/41083691137) | 10-30 15:45 | main | daemon-build-currency-e2e | build-currency SIGKILLed mid-act | flake | timing | ticketed |
| [41082743517](https://github.com/promptctl/cc-candybar/actions/runs/41082743517) | 10-30 15:39 | main | Release step: push to main rejected | Release push rejected | flake | real external | read |
| [41079120163](https://github.com/promptctl/cc-candybar/actions/runs/41079120163) | 10-30 15:16 | PR qzx | daemon-build-currency-e2e | build-currency SIGKILLed mid-act | flake | timing | ticketed |
| [41078579370](https://github.com/promptctl/cc-candybar/actions/runs/41078579370) | 10-30 15:12 | PR pijr | daemon-git-cache | daemon-git-cache while its branch was being written | real | the branch's own change | read |
| [41077960351](https://github.com/promptctl/cc-candybar/actions/runs/41077960351) | 10-30 15:08 | PR pijr | daemon-git-cache | daemon-git-cache while its branch was being written | real | the branch's own change | read |
| [41077934088](https://github.com/promptctl/cc-candybar/actions/runs/41077934088) | 10-30 15:08 | main | daemon-build-currency-e2e | build-currency SIGKILLed mid-act | flake | timing | ticketed |
| [41077616303](https://github.com/promptctl/cc-candybar/actions/runs/41077616303) | 10-30 15:06 | PR pijr | daemon-git-cache | daemon-git-cache while its branch was being written | real | the branch's own change | read |
| [41075891333](https://github.com/promptctl/cc-candybar/actions/runs/41075891333) | 10-30 14:55 | PR pijr | daemon-git-cache | daemon-git-cache while its branch was being written | real | the branch's own change | read |
| [41074623757](https://github.com/promptctl/cc-candybar/actions/runs/41074623757) | 10-30 14:46 | PR pijr | daemon-git-cache, daemon-build-currency-e2e | daemon-git-cache while its branch was being written, build-currency SIGKILLed mid-act | real | the branch's own change | read |
| [41074284933](https://github.com/promptctl/cc-candybar/actions/runs/41074284933) | 10-30 14:44 | PR qzx | doc-snippets | blank-stack throw from another file | flake | shared state | ticketed |
| [41072483175](https://github.com/promptctl/cc-candybar/actions/runs/41072483175) | 10-30 14:32 | PR pijr | daemon-git-cache, daemon-build-currency-e2e | daemon-git-cache while its branch was being written, build-currency SIGKILLed mid-act | real | the branch's own change | read |
| [41070117938](https://github.com/promptctl/cc-candybar/actions/runs/41070117938) | 10-30 14:14 | PR odm | daemon-build-currency-e2e | build-currency SIGKILLed mid-act | flake | timing | ticketed |
| [41065039660](https://github.com/promptctl/cc-candybar/actions/runs/41065039660) | 10-30 13:39 | PR joiners-bump-0hr | 200 files | dependency bump | real | dependency bump | read |
| [41062343644](https://github.com/promptctl/cc-candybar/actions/runs/41062343644) | 10-30 13:19 | PR odm | daemon-build-currency-e2e | build-currency SIGKILLed mid-act | flake | timing | ticketed |
| [41061882935](https://github.com/promptctl/cc-candybar/actions/runs/41061882935) | 10-30 13:16 | PR joiners-bump-0hr | 200 files | dependency bump | real | dependency bump | read |
| [41059089693](https://github.com/promptctl/cc-candybar/actions/runs/41059089693) | 10-30 12:55 | PR sy24 | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41053520338](https://github.com/promptctl/cc-candybar/actions/runs/41053520338) | 10-30 12:11 | main | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41052519492](https://github.com/promptctl/cc-candybar/actions/runs/41052519492) | 10-30 12:03 | PR z676 | daemon-build-currency-e2e | build-currency SIGKILLed mid-act | flake | timing | ticketed |
| [41051989282](https://github.com/promptctl/cc-candybar/actions/runs/41051989282) | 10-30 11:59 | main | daemon-render-event-e2e, render-cache-sharing | render-event clickError owed/over, render-cache-sharing gc retention | flake | timing | ticketed |
| [41051613708](https://github.com/promptctl/cc-candybar/actions/runs/41051613708) | 10-30 11:55 | PR 3gg | daemon-render-event-e2e, render-cache-sharing | render-event clickError owed/over, render-cache-sharing gc retention | flake | timing | ticketed |
| [41049907479](https://github.com/promptctl/cc-candybar/actions/runs/41049907479) | 10-30 11:41 | PR immutable-sleeping-barto | daemon-build-currency-e2e | blank-stack throw from another file | flake | shared state | ticketed |
| [41049070569](https://github.com/promptctl/cc-candybar/actions/runs/41049070569) | 10-30 11:34 | PR 3gg | daemon-build-currency-e2e | blank-stack throw from another file | flake | shared state | ticketed |
| [41048612146](https://github.com/promptctl/cc-candybar/actions/runs/41048612146) | 10-30 11:30 | PR z676 | daemon-build-currency-e2e | build-currency SIGKILLed mid-act | flake | timing | ticketed |
| [41048515213](https://github.com/promptctl/cc-candybar/actions/runs/41048515213) | 10-30 11:30 | PR z676 | daemon-render-event-e2e | render-event clickError owed/over | flake | timing | ticketed |
| [41037650105](https://github.com/promptctl/cc-candybar/actions/runs/41037650105) | 10-30 10:01 | main | daemon-build-currency-e2e | blank-stack throw from another file | flake | shared state | ticketed |
| [41034393409](https://github.com/promptctl/cc-candybar/actions/runs/41034393409) | 10-30 09:34 | PR 99v | daemon-build-currency-e2e | blank-stack throw from another file | flake | shared state | ticketed |
| [41031942815](https://github.com/promptctl/cc-candybar/actions/runs/41031942815) | 10-30 09:14 | PR y66h | daemon-render-event-e2e, daemon-build-currency-e2e | render-event clickError owed/over, blank-stack throw from another file | flake | timing | ticketed |
| [41031717514](https://github.com/promptctl/cc-candybar/actions/runs/41031717514) | 10-30 09:12 | PR 99v | typecheck | lint, typecheck, format, schema or ratchet | real | the commit | read |
| [41030124267](https://github.com/promptctl/cc-candybar/actions/runs/41030124267) | 10-30 08:59 | main | render-cache-sharing | render-cache-sharing gc retention | flake | timing | ticketed |
| [41026051000](https://github.com/promptctl/cc-candybar/actions/runs/41026051000) | 10-30 08:22 | PR 0rr5 | plain | the branch's own change | real | the branch's own change | read |

## The 22 runs that passed on rerun

Each failed its first attempt and went green on a later attempt, so the commit did not cause the failure. The group names what failed. A group marked `real` above can still pass on rerun, because its trigger is timing.

| Run | When (UTC) | On | Failing | Group |
|---|---|---|---|---|
| [41465826647](https://github.com/promptctl/cc-candybar/actions/runs/41465826647) | 11-02 14:50 | PR candybar-launch-q7o7.6wi | daemon-value | daemon-value close, timers armed after it |
| [41434399044](https://github.com/promptctl/cc-candybar/actions/runs/41434399044) | 11-02 11:08 | PR test/design-tests-advisory | frame-feed | frame-feed one draw per turn |
| [41317858900](https://github.com/promptctl/cc-candybar/actions/runs/41317858900) | 11-01 14:46 | PR candybar-isolated-daemon-bfab.2nq | draw-reserve.process | draw-reserve p99 |
| [41271441069](https://github.com/promptctl/cc-candybar/actions/runs/41271441069) | 11-01 04:01 | PR 425 | render-cache-sharing | render-cache-sharing gc retention |
| [41269789592](https://github.com/promptctl/cc-candybar/actions/runs/41269789592) | 11-01 03:35 | PR 425 | frame-feed | frame-feed one draw per turn |
| [41254978600](https://github.com/promptctl/cc-candybar/actions/runs/41254978600) | 11-01 00:02 | PR brandon-menus-sjhy.ju8 | frame-feed | frame-feed one draw per turn |
| [41250232226](https://github.com/promptctl/cc-candybar/actions/runs/41250232226) | 10-31 22:54 | PR 1izo | daemon-value | daemon-value close read after a fixed sleep |
| [41219957342](https://github.com/promptctl/cc-candybar/actions/runs/41219957342) | 10-31 16:29 | PR c3x | draw-reserve | draw-reserve p99 |
| [41203407051](https://github.com/promptctl/cc-candybar/actions/runs/41203407051) | 10-31 12:57 | PR 3c7 | doc-snippets | blank-stack throw from another file |
| [41195145965](https://github.com/promptctl/cc-candybar/actions/runs/41195145965) | 10-31 11:01 | PR hpxb | daemon-render-event-e2e | render-event clickError owed/over |
| [41138463350](https://github.com/promptctl/cc-candybar/actions/runs/41138463350) | 10-30 22:29 | PR joiners-window-count-cfm | daemon-config-persistence-e2e | blank-stack throw from another file |
| [41114420011](https://github.com/promptctl/cc-candybar/actions/runs/41114420011) | 10-30 19:20 | PR joiners-depth-window-686 | frame-feed | frame-feed one draw per turn |
| [41100151584](https://github.com/promptctl/cc-candybar/actions/runs/41100151584) | 10-30 17:35 | PR build-currency-e2e-ci-cuvv | daemon-render-event-e2e | render-event clickError owed/over |
| [41094015312](https://github.com/promptctl/cc-candybar/actions/runs/41094015312) | 10-30 16:53 | PR qzx | daemon-render-event-e2e, render-cache-sharing | render-event clickError owed/over, render-cache-sharing gc retention |
| [41091352768](https://github.com/promptctl/cc-candybar/actions/runs/41091352768) | 10-30 16:35 | PR build-currency-e2e-ci-cuvv | client-deadline | client-deadline stated budget |
| [41091325680](https://github.com/promptctl/cc-candybar/actions/runs/41091325680) | 10-30 16:35 | PR build-currency-e2e-ci-cuvv | daemon-render-event-e2e | render-event clickError owed/over |
| [41089033102](https://github.com/promptctl/cc-candybar/actions/runs/41089033102) | 10-30 16:20 | PR joiners-tone-adjacency-tx7 | daemon-build-currency-e2e | build-currency SIGKILLed mid-act |
| [41084738870](https://github.com/promptctl/cc-candybar/actions/runs/41084738870) | 10-30 15:52 | PR joiners-row-positions-3m7 | daemon-build-currency-e2e | build-currency SIGKILLed mid-act |
| [41079456026](https://github.com/promptctl/cc-candybar/actions/runs/41079456026) | 10-30 15:18 | PR pijr | daemon-build-currency-e2e | build-currency SIGKILLed mid-act |
| [41074503667](https://github.com/promptctl/cc-candybar/actions/runs/41074503667) | 10-30 14:45 | PR joiners-bump-0hr | daemon-build-currency-e2e | build-currency SIGKILLed mid-act |
| [41070232824](https://github.com/promptctl/cc-candybar/actions/runs/41070232824) | 10-30 14:15 | PR odm | daemon-build-currency-e2e | build-currency SIGKILLed mid-act |
| [41051676039](https://github.com/promptctl/cc-candybar/actions/runs/41051676039) | 10-30 11:56 | PR 3gg | daemon-build-currency-e2e | blank-stack throw from another file |
