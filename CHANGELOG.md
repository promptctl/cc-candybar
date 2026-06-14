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
