## [1.18.1](https://github.com/promptctl/cc-candybar/compare/v1.18.0...v1.18.1) (2026-07-25)


### Performance Improvements

* **git:** collapse core git fan-out into one porcelain=v2 read (brandon-daemon-perf-bb9.1) ([#152](https://github.com/promptctl/cc-candybar/issues/152)) ([f3ba999](https://github.com/promptctl/cc-candybar/commit/f3ba99934a8bd56f4747816491b00cb65744138a))

# [1.18.0](https://github.com/promptctl/cc-candybar/compare/v1.17.5...v1.18.0) (2026-07-22)


### Features

* **config:** two-row informational default bar (brandon-segments-4uy) ([#151](https://github.com/promptctl/cc-candybar/issues/151)) ([04ffc7a](https://github.com/promptctl/cc-candybar/commit/04ffc7a34c6ca53ea75aefc53ce3504700756a08))

## [1.17.5](https://github.com/promptctl/cc-candybar/compare/v1.17.4...v1.17.5) (2026-07-10)


### Performance Improvements

* **daemon:** incremental append-only transcript fold (brandon-daemon-perf-bb9) ([#150](https://github.com/promptctl/cc-candybar/issues/150)) ([c39d90e](https://github.com/promptctl/cc-candybar/commit/c39d90e4f45c78af660824c57710a92a8f0c09b3))

## [1.17.4](https://github.com/promptctl/cc-candybar/compare/v1.17.3...v1.17.4) (2026-07-09)


### Bug Fixes

* **daemon:** pid+start-time fingerprint closes the two socket-lease residuals (brandon-daemon-lifecycle-2b3.4) ([#149](https://github.com/promptctl/cc-candybar/issues/149)) ([d45e24b](https://github.com/promptctl/cc-candybar/commit/d45e24bc7137f2ff1629b22c9e4ca838a56c322a))

## [1.17.3](https://github.com/promptctl/cc-candybar/compare/v1.17.2...v1.17.3) (2026-07-09)


### Bug Fixes

* **daemon:** spawn cooldown bounds daemon-spawn rate during outages (brandon-daemon-lifecycle-2b3.3) ([#148](https://github.com/promptctl/cc-candybar/issues/148)) ([3f261c4](https://github.com/promptctl/cc-candybar/commit/3f261c411adce4af7243227da4c9b0346c20734e))

## [1.17.2](https://github.com/promptctl/cc-candybar/compare/v1.17.1...v1.17.2) (2026-07-09)


### Bug Fixes

* **daemon:** ownership self-check exits a displaced daemon within one interval (brandon-daemon-lifecycle-2b3.2) ([#147](https://github.com/promptctl/cc-candybar/issues/147)) ([d00221a](https://github.com/promptctl/cc-candybar/commit/d00221a3d659ce840a45ba5401db2c560e3b950e))

## [1.17.1](https://github.com/promptctl/cc-candybar/compare/v1.17.0...v1.17.1) (2026-07-09)


### Bug Fixes

* **daemon:** pid lease replaces connect-probe as socket-reclaim authority (brandon-daemon-lifecycle-2b3.1) ([#146](https://github.com/promptctl/cc-candybar/issues/146)) ([85b1bf6](https://github.com/promptctl/cc-candybar/commit/85b1bf6f4121fc29209bbc3cda91f6b90a1ff3a2))

# [1.17.0](https://github.com/promptctl/cc-candybar/compare/v1.16.0...v1.17.0) (2026-07-08)


### Features

* **config:** expose daemon-resolved effective theme name as `theme.effective` (brandon-config-b9j) ([#145](https://github.com/promptctl/cc-candybar/issues/145)) ([15fa29f](https://github.com/promptctl/cc-candybar/commit/15fa29fbba152519dbd8c12c99cbb443d6f8ec4c))

# [1.16.0](https://github.com/promptctl/cc-candybar/compare/v1.15.0...v1.16.0) (2026-07-07)


### Features

* **config:** legacy-parity example config (brandon-config-aoi) ([#144](https://github.com/promptctl/cc-candybar/issues/144)) ([0698e35](https://github.com/promptctl/cc-candybar/commit/0698e357d961d95bb38ff6a4301137854e7c50db))

# [1.15.0](https://github.com/promptctl/cc-candybar/compare/v1.14.0...v1.15.0) (2026-07-07)


### Features

* **directory:** fish-style abbreviated paths as the default rendering ([#143](https://github.com/promptctl/cc-candybar/issues/143)) ([3869218](https://github.com/promptctl/cc-candybar/commit/3869218a98871906c49159e7da12247c4f373ba5))

# [1.14.0](https://github.com/promptctl/cc-candybar/compare/v1.13.0...v1.14.0) (2026-07-07)


### Features

* **config:** restore session-level budget warning (brandon-budget-kry) ([#141](https://github.com/promptctl/cc-candybar/issues/141)) ([5895f5b](https://github.com/promptctl/cc-candybar/commit/5895f5bd2af27628840ba6e9f14554d3b818465c))

# [1.13.0](https://github.com/promptctl/cc-candybar/compare/v1.12.0...v1.13.0) (2026-07-06)


### Features

* standalone candybar-lite statusline script ([#142](https://github.com/promptctl/cc-candybar/issues/142)) ([8b1e7f2](https://github.com/promptctl/cc-candybar/commit/8b1e7f2e3572080acf92ab0bda389968be72d7c9))

# [1.12.0](https://github.com/promptctl/cc-candybar/compare/v1.11.0...v1.12.0) (2026-07-03)


### Features

* **config:** restore globals.colorCompatibility — color depth / downsampling control (brandon-display-dam.4) ([#140](https://github.com/promptctl/cc-candybar/issues/140)) ([0a425f0](https://github.com/promptctl/cc-candybar/commit/0a425f02904deb6cd0e5cb4b997b073c80fdb13d)), closes [#139](https://github.com/promptctl/cc-candybar/issues/139)

# [1.11.0](https://github.com/promptctl/cc-candybar/compare/v1.10.0...v1.11.0) (2026-07-03)


### Features

* **config:** restore globals.charset — ASCII fallback for powerline joiner glyphs (brandon-display-dam.3) ([#139](https://github.com/promptctl/cc-candybar/issues/139)) ([5d9fef2](https://github.com/promptctl/cc-candybar/commit/5d9fef247f7f59fdaf420c87265836c120ff7cfa))

# [1.10.0](https://github.com/promptctl/cc-candybar/compare/v1.9.0...v1.10.0) (2026-07-03)


### Features

* **config:** restore globals.padding — structural intra-cell segment padding (brandon-display-dam.2) ([#138](https://github.com/promptctl/cc-candybar/issues/138)) ([042c655](https://github.com/promptctl/cc-candybar/commit/042c655708be12250638ce9c7d285d4addba6632))

# [1.9.0](https://github.com/promptctl/cc-candybar/compare/v1.8.4...v1.9.0) (2026-07-03)


### Features

* **config:** restore globals.autoWrap — toggle FlexStrip width-based soft-wrap (brandon-display-dam.1) ([#137](https://github.com/promptctl/cc-candybar/issues/137)) ([f856a7e](https://github.com/promptctl/cc-candybar/commit/f856a7edd3473026b0486a8eb5cb87d36c0b73a6))

## [1.8.4](https://github.com/promptctl/cc-candybar/compare/v1.8.3...v1.8.4) (2026-06-17)


### Bug Fixes

* **picker:** paged menus overflow term width on pages after the first (abg) ([#135](https://github.com/promptctl/cc-candybar/issues/135)) ([b5cdaf4](https://github.com/promptctl/cc-candybar/commit/b5cdaf44f56b988b597d3932452ad81dbd8e3065))

## [1.8.3](https://github.com/promptctl/cc-candybar/compare/v1.8.2...v1.8.3) (2026-06-17)


### Bug Fixes

* **menu:** migrate theme/style menus to the {{ menu }} disclosure; reset page on toggle (arq) ([#134](https://github.com/promptctl/cc-candybar/issues/134)) ([457d5be](https://github.com/promptctl/cc-candybar/commit/457d5be0051125f840e808959eb01023b9645cd9))

## [1.8.2](https://github.com/promptctl/cc-candybar/compare/v1.8.1...v1.8.2) (2026-06-16)


### Bug Fixes

* **menu:** inline/drop channels + name-derived identity — N menus per segment, anywhere (pdu.5) ([#133](https://github.com/promptctl/cc-candybar/issues/133)) ([f0878af](https://github.com/promptctl/cc-candybar/commit/f0878afb5010b94d27b606199bf09c3f9555fdb2))

## [1.8.1](https://github.com/promptctl/cc-candybar/compare/v1.8.0...v1.8.1) (2026-06-16)


### Bug Fixes

* **examples:** migrate demo-variables.json5 to root A-grammar (pdu.10) ([#132](https://github.com/promptctl/cc-candybar/issues/132)) ([3ce7a77](https://github.com/promptctl/cc-candybar/commit/3ce7a778b46b25bfe60acd0ab9775dc09cf6c924))

# [1.8.0](https://github.com/promptctl/cc-candybar/compare/v1.7.3...v1.8.0) (2026-06-15)


### Features

* **render:** horizontal compose stacks drops; embeddable {{ menu }} disclosure (pdu.9) ([#131](https://github.com/promptctl/cc-candybar/issues/131)) ([60f1976](https://github.com/promptctl/cc-candybar/commit/60f1976a87515fe56bcc4509f59059bcfff804a0))

## [1.7.3](https://github.com/promptctl/cc-candybar/compare/v1.7.2...v1.7.3) (2026-06-15)


### Bug Fixes

* **loader:** group toggle disclosure glyph trails the label it gates (pdu.8) ([#130](https://github.com/promptctl/cc-candybar/issues/130)) ([99a12e9](https://github.com/promptctl/cc-candybar/commit/99a12e931a6cbd577050c558621d0b51763652bf))

## [1.7.2](https://github.com/promptctl/cc-candybar/compare/v1.7.1...v1.7.2) (2026-06-15)


### Bug Fixes

* **render:** theme/style picker stays open on pick by default (closeOnPick) ([#129](https://github.com/promptctl/cc-candybar/issues/129)) ([fc17b42](https://github.com/promptctl/cc-candybar/commit/fc17b42280a61592682bcdef63f3d4a2a1049345))

## [1.7.1](https://github.com/promptctl/cc-candybar/compare/v1.7.0...v1.7.1) (2026-06-15)


### Bug Fixes

* **render:** correct over-reserved terminal width (45→2 cols) (render-bugs-pdu.2) ([#126](https://github.com/promptctl/cc-candybar/issues/126)) ([8b15249](https://github.com/promptctl/cc-candybar/commit/8b1524985a2860492810b59eabb25f5a7d84da5c))

# [1.7.0](https://github.com/promptctl/cc-candybar/compare/v1.6.0...v1.7.0) (2026-06-15)


### Features

* **helpers:** sparkline template helper — inline unicode burn-rate mini-graph ([#124](https://github.com/promptctl/cc-candybar/issues/124)) ([43f0378](https://github.com/promptctl/cc-candybar/commit/43f037856f0c520e595c89a361dac606eee29c62))

# [1.6.0](https://github.com/promptctl/cc-candybar/compare/v1.5.0...v1.6.0) (2026-06-15)


### Features

* **git:** forge PR/MR segment — clickable open-PR link for the branch ([#123](https://github.com/promptctl/cc-candybar/issues/123)) ([4b67f7b](https://github.com/promptctl/cc-candybar/commit/4b67f7b6cfe871d7cf591ecc283b9b09e537ed23))

# [1.5.0](https://github.com/promptctl/cc-candybar/compare/v1.4.0...v1.5.0) (2026-06-14)


### Features

* **usage:** token-speed segment — input/output/total tok/s for the active turn ([#122](https://github.com/promptctl/cc-candybar/issues/122)) ([03920d2](https://github.com/promptctl/cc-candybar/commit/03920d2f21afc8a2015788b43395e2f2e7ca8c4e)), closes [#119](https://github.com/promptctl/cc-candybar/issues/119)

# [1.4.0](https://github.com/promptctl/cc-candybar/compare/v1.3.0...v1.4.0) (2026-06-14)


### Features

* **theming:** wire the style picker into the default bar (live powerline-shape switcher) ([#121](https://github.com/promptctl/cc-candybar/issues/121)) ([35a73f4](https://github.com/promptctl/cc-candybar/commit/35a73f4ba53fa252b6cedc0abff5a95d8a7eac3a))

# [1.3.0](https://github.com/promptctl/cc-candybar/compare/v1.2.0...v1.3.0) (2026-06-14)


### Features

* **actions:** quick-action tray in the default bar (copy id/cwd, open project/transcript) ([#120](https://github.com/promptctl/cc-candybar/issues/120)) ([e05a4fc](https://github.com/promptctl/cc-candybar/commit/e05a4fc9382b9b8d4a03960ccb3cd69330e4ae7f))

# [1.2.0](https://github.com/promptctl/cc-candybar/compare/v1.1.1...v1.2.0) (2026-06-14)


### Features

* **usage:** burn-rate + cap-projection segment ($/hr · ETA to 5h & weekly cap) ([#119](https://github.com/promptctl/cc-candybar/issues/119)) ([be28212](https://github.com/promptctl/cc-candybar/commit/be282128130a494bea3952a614971348f1b74933))

## [1.1.1](https://github.com/promptctl/cc-candybar/compare/v1.1.0...v1.1.1) (2026-06-14)


### Bug Fixes

* **ci:** migrate code review action to OpenAI/Codex provider ([b4c215a](https://github.com/promptctl/cc-candybar/commit/b4c215a7679fa4242f7ef54404dad81b7601fee3))

# [1.1.0](https://github.com/promptctl/cc-candybar/compare/v1.0.3...v1.1.0) (2026-06-14)


### Bug Fixes

* **release:** retry lockfile re-sync until registry propagation completes ([#117](https://github.com/promptctl/cc-candybar/issues/117)) ([0ab785d](https://github.com/promptctl/cc-candybar/commit/0ab785d8bb86fc8d12ff6f37263872eb269da13e)), closes [#116](https://github.com/promptctl/cc-candybar/issues/116)


### Features

* **examples:** flagship "showcase" config exercising the full 2de substrate ([#114](https://github.com/promptctl/cc-candybar/issues/114)) ([595be22](https://github.com/promptctl/cc-candybar/commit/595be2243d28d4543491371debd8d37c9e00c01f))

## [1.0.3](https://github.com/promptctl/cc-candybar/compare/v1.0.2...v1.0.3) (2026-06-14)


### Bug Fixes

* **deps:** lock platform binaries for all architectures via supportedArchitectures ([#116](https://github.com/promptctl/cc-candybar/issues/116)) ([4d2b7c1](https://github.com/promptctl/cc-candybar/commit/4d2b7c15970f66b26c339d5bc67307365cc6736c)), closes [#115](https://github.com/promptctl/cc-candybar/issues/115) [#115](https://github.com/promptctl/cc-candybar/issues/115)

## [1.0.2](https://github.com/promptctl/cc-candybar/compare/v1.0.1...v1.0.2) (2026-06-14)


### Bug Fixes

* **release:** re-sync pnpm-lock.yaml on every release, not just once ([#115](https://github.com/promptctl/cc-candybar/issues/115)) ([a30ea27](https://github.com/promptctl/cc-candybar/commit/a30ea2744c3ae5e184a21d18c52d68f44dcb830f)), closes [#113](https://github.com/promptctl/cc-candybar/issues/113) [#113](https://github.com/promptctl/cc-candybar/issues/113)

## [1.0.1](https://github.com/promptctl/cc-candybar/compare/v1.0.0...v1.0.1) (2026-06-14)


### Bug Fixes

* **prepack:** guard placeholder write on bin existence, not Cargo.toml ([#113](https://github.com/promptctl/cc-candybar/issues/113)) ([3c496a7](https://github.com/promptctl/cc-candybar/commit/3c496a716f629add60c588ab920f669e71d1e1b6))
