## [1.176.0](https://github.com/promptctl/cc-candybar/compare/v1.175.0...v1.176.0) (2026-11-01)

### Features

* **landscape:** captured bars play in the explorer, with capture tooling and the live-bar link ([#544](https://github.com/promptctl/cc-candybar/issues/544)) ([22a4d97](https://github.com/promptctl/cc-candybar/commit/22a4d977fc08426311fbc21d544a5c130ec8183b)), closes [#472](https://github.com/promptctl/cc-candybar/issues/472)

## [1.175.0](https://github.com/promptctl/cc-candybar/compare/v1.174.7...v1.175.0) (2026-11-01)

### Features

* **daemon:** journals take turns so click handlers can await (candybar-launch-q7o7.rs0) ([#542](https://github.com/promptctl/cc-candybar/issues/542)) ([e7c7caa](https://github.com/promptctl/cc-candybar/commit/e7c7caacfb9c807a1424dde9d75a66559451e5ed))
* **git:** gitaculous shows a worktree-aware location, and offers init outside a repo ([#543](https://github.com/promptctl/cc-candybar/issues/543)) ([52c69be](https://github.com/promptctl/cc-candybar/commit/52c69beb5b01d9c842ae7f38fbb59f0c64086cb1))

## [1.174.7](https://github.com/promptctl/cc-candybar/compare/v1.174.6...v1.174.7) (2026-11-01)

### Bug Fixes

* **proc:** a settled launch stops reading what outlives it (candybar-testing-0x6u.v5t) ([#541](https://github.com/promptctl/cc-candybar/issues/541)) ([63c79c5](https://github.com/promptctl/cc-candybar/commit/63c79c571fe30da5a6ba1df1c66e3c0610a95c03))

## [1.174.6](https://github.com/promptctl/cc-candybar/compare/v1.174.5...v1.174.6) (2026-11-01)

### Bug Fixes

* **proc:** a character split across two reads stays whole (candybar-testing-0x6u.71b) ([#540](https://github.com/promptctl/cc-candybar/issues/540)) ([62bc62d](https://github.com/promptctl/cc-candybar/commit/62bc62daea77f6e6c8b7543db42bf9736245ebaa))

## [1.174.5](https://github.com/promptctl/cc-candybar/compare/v1.174.4...v1.174.5) (2026-11-01)

### Bug Fixes

* **proc:** a job group that refuses a signal no longer ends the daemon (candybar-testing-0x6u.zrb) ([#538](https://github.com/promptctl/cc-candybar/issues/538)) ([6917276](https://github.com/promptctl/cc-candybar/commit/691727676169eed0e0826fea6dee07d1d902077d))
* **var-sources:** a watch_file variable says when a stall has stopped it refreshing (brandon-unfiled-3248.fme8) ([#539](https://github.com/promptctl/cc-candybar/issues/539)) ([1435f5c](https://github.com/promptctl/cc-candybar/commit/1435f5c909561280b02fc77cc21e462541e582fb))

## [1.174.4](https://github.com/promptctl/cc-candybar/compare/v1.174.3...v1.174.4) (2026-11-01)

### Bug Fixes

* **proc:** input a child leaves unread no longer ends the daemon (candybar-testing-0x6u.47e) ([#537](https://github.com/promptctl/cc-candybar/issues/537)) ([e98fef8](https://github.com/promptctl/cc-candybar/commit/e98fef8ecc1558cc8cdf59993c8534b6d584d2fd))

## [1.174.3](https://github.com/promptctl/cc-candybar/compare/v1.174.2...v1.174.3) (2026-11-01)

### Bug Fixes

* **proc:** a launch ends with its group, not with whoever holds its pipes (candybar-testing-0x6u.425) ([#535](https://github.com/promptctl/cc-candybar/issues/535)) ([043f443](https://github.com/promptctl/cc-candybar/commit/043f44379d2c1a27622f7b48535a323be7a59242))

## [1.174.2](https://github.com/promptctl/cc-candybar/compare/v1.174.1...v1.174.2) (2026-11-01)

### Bug Fixes

* **daemon:** a request's timers run on its clock, and the deadline case holds them (brandon-unfiled-3248.a5k3) ([#533](https://github.com/promptctl/cc-candybar/issues/533)) ([4814ee7](https://github.com/promptctl/cc-candybar/commit/4814ee778a28c55a7193789772cc2d681d409ab0))

## [1.174.1](https://github.com/promptctl/cc-candybar/compare/v1.174.0...v1.174.1) (2026-11-01)

### Bug Fixes

* **proc:** a zombie child's group is no refusal of its signal (candybar-testing-0x6u.0mz) ([#534](https://github.com/promptctl/cc-candybar/issues/534)) ([96f1881](https://github.com/promptctl/cc-candybar/commit/96f1881bee934f602971a13dea41977a614a98e3))

## [1.174.0](https://github.com/promptctl/cc-candybar/compare/v1.173.1...v1.174.0) (2026-11-01)

### Features

* **daemon:** close says when the launches it ended have ended (candybar-testing-0x6u.keo) ([#532](https://github.com/promptctl/cc-candybar/issues/532)) ([d189b5c](https://github.com/promptctl/cc-candybar/commit/d189b5c56cbf38da7151f2400b2ae226f8331328))

## [1.173.1](https://github.com/promptctl/cc-candybar/compare/v1.173.0...v1.173.1) (2026-11-01)

### Bug Fixes

* **test:** a fake launch holds the run, and the daemon test keeps only the wiring (brandon-unfiled-3248.2ywj) ([#531](https://github.com/promptctl/cc-candybar/issues/531)) ([7b77d5f](https://github.com/promptctl/cc-candybar/commit/7b77d5fab04cc3822fa430e086169ef7f984b873))

## [1.173.0](https://github.com/promptctl/cc-candybar/compare/v1.172.0...v1.173.0) (2026-11-01)

### Features

* **effect:** the wheel turns each segment at a pace set by where it sits (brandon-menus-sjhy.ju8) ([#528](https://github.com/promptctl/cc-candybar/issues/528)) ([8169390](https://github.com/promptctl/cc-candybar/commit/8169390eb96da95acccf40e944cb0c61f88a1f39))

### Bug Fixes

* **test:** a wait hands a late probe's throw to the test that made it (candybar-testing-0x6u.6el) ([#529](https://github.com/promptctl/cc-candybar/issues/529)) ([516c3eb](https://github.com/promptctl/cc-candybar/commit/516c3eb319a548c706d04da1795e462774d057a7))

## [1.172.0](https://github.com/promptctl/cc-candybar/compare/v1.171.0...v1.172.0) (2026-11-01)

### Features

* **settings:** a setting has one list, and an option's label is separate from its value (brandon-menus-sjhy.pyt) ([#527](https://github.com/promptctl/cc-candybar/issues/527)) ([3439d4a](https://github.com/promptctl/cc-candybar/commit/3439d4a05a61f8cd02c3099414d573b8e8e1cffc))

## [1.171.0](https://github.com/promptctl/cc-candybar/compare/v1.170.1...v1.171.0) (2026-10-31)

### Features

* **carousel:** the standard control names the setting it changes, not its value (brandon-menus-sjhy.vxr) ([#518](https://github.com/promptctl/cc-candybar/issues/518)) ([e0b1483](https://github.com/promptctl/cc-candybar/commit/e0b1483c0864fe01633d47904d1f453e411b8da2))

## [1.170.1](https://github.com/promptctl/cc-candybar/compare/v1.170.0...v1.170.1) (2026-10-31)

### Bug Fixes

* **doctor:** the config verdict names what it judged and what named it (brandon-unfiled-3248.hpxb) ([#519](https://github.com/promptctl/cc-candybar/issues/519)) ([3405285](https://github.com/promptctl/cc-candybar/commit/3405285f6ee15d063c84e720f6659f9babe4bc6a))

## [1.170.0](https://github.com/promptctl/cc-candybar/compare/v1.169.2...v1.170.0) (2026-10-31)

### Features

* **menu:** the menu opens with no tab open, and its timeout defaults to 120s in 15s steps ([#516](https://github.com/promptctl/cc-candybar/issues/516)) ([8da9964](https://github.com/promptctl/cc-candybar/commit/8da9964e91dd7db20d259a81a05cf0f2328ee0c2))

## [1.169.2](https://github.com/promptctl/cc-candybar/compare/v1.169.1...v1.169.2) (2026-10-31)

### Bug Fixes

* **site:** the live bar defines Symbol.dispose where Safari has none ([#515](https://github.com/promptctl/cc-candybar/issues/515)) ([0a5c459](https://github.com/promptctl/cc-candybar/commit/0a5c459f404f83438a0772eb02741da617b6a82b))

## [1.169.1](https://github.com/promptctl/cc-candybar/compare/v1.169.0...v1.169.1) (2026-10-31)

### Bug Fixes

* **watchers:** every directory watch is judged against the disk on the delivery owner's period (brandon-unfiled-3248.erwl) ([#514](https://github.com/promptctl/cc-candybar/issues/514)) ([0d7e327](https://github.com/promptctl/cc-candybar/commit/0d7e32730906f412f757614cd2ea4aed3dbd3cac))

## [1.169.0](https://github.com/promptctl/cc-candybar/compare/v1.168.1...v1.169.0) (2026-10-31)

### Features

* **menus:** the animation speed menu offers 10x between 5x and 20x (brandon-menus-sjhy.why) ([#511](https://github.com/promptctl/cc-candybar/issues/511)) ([7fa9b11](https://github.com/promptctl/cc-candybar/commit/7fa9b112cc7061c7e0e1a63a7955c56987054064))

### Bug Fixes

* **colour:** a cell moved at a hue turn never wears the pressed shade an open trigger beside it would wear (candybar-joiners-e5r4.34r) ([#512](https://github.com/promptctl/cc-candybar/issues/512)) ([0160616](https://github.com/promptctl/cc-candybar/commit/016061643ad23b49d130b2c30124599d4beab3bb))
* **colour:** a dial window widens toward its position's count of tones and leaves its ladder's last colour to the pressed button (candybar-joiners-e5r4.cfm) ([#510](https://github.com/promptctl/cc-candybar/issues/510)) ([0ed75d1](https://github.com/promptctl/cc-candybar/commit/0ed75d194e35c845f139e257b73bd2118c63d722))

## [1.168.1](https://github.com/promptctl/cc-candybar/compare/v1.168.0...v1.168.1) (2026-10-30)

### Bug Fixes

* **colour:** the cells either side of a hue turn draw as two colours at every depth (candybar-joiners-e5r4.5x1) ([#508](https://github.com/promptctl/cc-candybar/issues/508)) ([b51f005](https://github.com/promptctl/cc-candybar/commit/b51f00510c4bcca14fc9ff4177320380f9052873))
* **site:** the live bar and the landscape explorer link to each other ([#509](https://github.com/promptctl/cc-candybar/issues/509)) ([19183e1](https://github.com/promptctl/cc-candybar/commit/19183e1e39371f3a80b53ee9182655ebec2787f9))

## [1.168.0](https://github.com/promptctl/cc-candybar/compare/v1.167.1...v1.168.0) (2026-10-30)

### Features

* **feed:** a frame is drawn when the bar next changes, not at a fixed 30 fps (candybar-animation-wbxz.014) ([#505](https://github.com/promptctl/cc-candybar/issues/505)) ([5b44ba9](https://github.com/promptctl/cc-candybar/commit/5b44ba9e047f7fd59d83562b39c5d23776c81d14))

### Bug Fixes

* **colour:** a dial window holds only the rungs the depth draws distinct, and no seam on the bundled bar joins one colour (candybar-joiners-e5r4.686) ([#506](https://github.com/promptctl/cc-candybar/issues/506)) ([35846ae](https://github.com/promptctl/cc-candybar/commit/35846ae8042324805c53b14c0c5fc02d669edcd3))
* **diagnostics:** what the config watch cannot hear shows in the ⚠ indicator (candybar-plugins-vf6g.8uk) ([#507](https://github.com/promptctl/cc-candybar/issues/507)) ([38412c6](https://github.com/promptctl/cc-candybar/commit/38412c68e7a12dce2557dc35449033e18226bae2))
* **test:** the build-currency e2e waits on the daemon's own signal, so a loaded runner cannot fail it (brandon-unfiled-3248.cuvv) ([#502](https://github.com/promptctl/cc-candybar/issues/502)) ([b100e43](https://github.com/promptctl/cc-candybar/commit/b100e4391f45deea8b68df49f4ebdd4a6ee988cb))

## [1.167.1](https://github.com/promptctl/cc-candybar/compare/v1.167.0...v1.167.1) (2026-10-30)

### Bug Fixes

* **colour:** the door's open ✖ wears the theme's text-red, so it reads on its activated ground (candybar-joiners-e5r4.i30) ([#503](https://github.com/promptctl/cc-candybar/issues/503)) ([e03723c](https://github.com/promptctl/cc-candybar/commit/e03723ccfd5e2ed7bcd921e08ab6228dc1949671))

## [1.167.0](https://github.com/promptctl/cc-candybar/compare/v1.166.3...v1.167.0) (2026-10-30)

### Features

* **tmux:** the tmux status line is a renderer the config menu offers inside tmux (candybar-plugins-vf6g.qzx) ([#499](https://github.com/promptctl/cc-candybar/issues/499)) ([4674510](https://github.com/promptctl/cc-candybar/commit/46745100f446a07971644e712c1ae93efc7f4a04))

## [1.166.3](https://github.com/promptctl/cc-candybar/compare/v1.166.2...v1.166.3) (2026-10-30)

### Bug Fixes

* **watchers:** the registry refuses a directory it cannot open, on every platform (brandon-unfiled-3248.0mvx) ([#501](https://github.com/promptctl/cc-candybar/issues/501)) ([ac7fa00](https://github.com/promptctl/cc-candybar/commit/ac7fa0066116393d2e51df899b6ec19d31ba5071))

## [1.166.2](https://github.com/promptctl/cc-candybar/compare/v1.166.1...v1.166.2) (2026-10-30)

### Bug Fixes

* **colour:** adjacent row positions never select one tone, and the muted dial gets two (candybar-joiners-e5r4.tx7) ([#494](https://github.com/promptctl/cc-candybar/issues/494)) ([db7ae9e](https://github.com/promptctl/cc-candybar/commit/db7ae9ee8f9ab8e5bcaf98a2977284b727ef5d2f))
* **test:** a test that SIGKILLs a daemon waits for its session state to be saved (brandon-unfiled-3248.vfhf) ([#500](https://github.com/promptctl/cc-candybar/issues/500)) ([79eac59](https://github.com/promptctl/cc-candybar/commit/79eac595257ef87be616ea19c3ea787386d26db6))

## [1.166.1](https://github.com/promptctl/cc-candybar/compare/v1.166.0...v1.166.1) (2026-10-30)

### Bug Fixes

* **colour:** grouped cells and the door's rate cell take their own row positions (candybar-joiners-e5r4.3m7) ([#493](https://github.com/promptctl/cc-candybar/issues/493)) ([73801c6](https://github.com/promptctl/cc-candybar/commit/73801c6e3b63cf23ed6af12476e50b45a0c45333))
* **colour:** the activated segment and its menu plane wear named theme shades; the inter-cell floors go (candybar-joiners-e5r4.dg6) ([#492](https://github.com/promptctl/cc-candybar/issues/492)) ([fe783f4](https://github.com/promptctl/cc-candybar/commit/fe783f48728a83116d74cf3674e4695aff77fd76))
* **render:** bump rich-js to 0.25 so every join is an arrow, and the tests say so (candybar-joiners-e5r4.0hr) ([#496](https://github.com/promptctl/cc-candybar/issues/496)) ([16ba284](https://github.com/promptctl/cc-candybar/commit/16ba284b459a5bc135c21f529414a4020a2b2b46))

## [1.166.0](https://github.com/promptctl/cc-candybar/compare/v1.165.1...v1.166.0) (2026-10-30)

### Features

* **plugins:** a missing segment is an error only when its plugin is present (candybar-plugins-vf6g.odm) ([#497](https://github.com/promptctl/cc-candybar/issues/497)) ([5577ddd](https://github.com/promptctl/cc-candybar/commit/5577ddd8731d529e5500113fe2febc34aff9f5b2))

## [1.165.1](https://github.com/promptctl/cc-candybar/compare/v1.165.0...v1.165.1) (2026-10-30)

### Bug Fixes

* **var-system:** a watch_file path is heard wherever its link chain can change, by the rule the config watcher shares (brandon-unfiled-3248.sy24) ([#495](https://github.com/promptctl/cc-candybar/issues/495)) ([5920905](https://github.com/promptctl/cc-candybar/commit/592090572d8ec1c672f7c5994824e93e218f8291))

## [1.165.0](https://github.com/promptctl/cc-candybar/compare/v1.164.1...v1.165.0) (2026-10-30)

### Features

* **plugins:** a repo's own plugins load as repo.<name> beside installed plugins.<name> (candybar-plugins-vf6g.3gg) ([#489](https://github.com/promptctl/cc-candybar/issues/489)) ([c7c3ecd](https://github.com/promptctl/cc-candybar/commit/c7c3ecda46896168f06ef5bc176b5bb541bd0a28))

### Bug Fixes

* **daemon:** the update act is a job every daemon reads, so it finishes whatever happens to the daemon that started it (brandon-unfiled-3248.z676) ([#491](https://github.com/promptctl/cc-candybar/issues/491)) ([3ac1f0e](https://github.com/promptctl/cc-candybar/commit/3ac1f0ebd17dcc49615d30cb2f79602aa362240d))

## [1.164.1](https://github.com/promptctl/cc-candybar/compare/v1.164.0...v1.164.1) (2026-10-30)

### Bug Fixes

* **proc:** a launch child dies with the process that launched it, SIGKILL included (brandon-unfiled-3248.86ga) ([#488](https://github.com/promptctl/cc-candybar/issues/488)) ([092f79f](https://github.com/promptctl/cc-candybar/commit/092f79f3f5bc5cd6eea2aa0a0ea0ce725f0e64d4))

## [1.164.0](https://github.com/promptctl/cc-candybar/compare/v1.163.0...v1.164.0) (2026-10-30)

### Features

* **config:** a repo config can add a cell beside a placement the user already has (candybar-plugins-vf6g.99v) ([#486](https://github.com/promptctl/cc-candybar/issues/486)) ([cd51ad0](https://github.com/promptctl/cc-candybar/commit/cd51ad088846247d4d8d328c870849e2b81ba424))

### Bug Fixes

* **ci:** the committed schema has one writer, and the Test job fails a PR that leaves it stale (brandon-unfiled-3248.oq80) ([#487](https://github.com/promptctl/cc-candybar/issues/487)) ([e31c958](https://github.com/promptctl/cc-candybar/commit/e31c958417e5127d95819930643df17eb59fe2bf))

## [1.163.0](https://github.com/promptctl/cc-candybar/compare/v1.162.5...v1.163.0) (2026-10-30)

### Features

* **diagnostics:** every error and warning shows as one indicator with a viewer (candybar-plugins-vf6g.84i) ([#483](https://github.com/promptctl/cc-candybar/issues/483)) ([4363d2a](https://github.com/promptctl/cc-candybar/commit/4363d2a7982c76c6f6ada1028f154dd9a498309c))

### Bug Fixes

* **daemon:** one owner says whether the OS is delivering file events, and an edit made while it wasn't reloads when they resume (brandon-unfiled-3248.y66h) ([#485](https://github.com/promptctl/cc-candybar/issues/485)) ([5a804ba](https://github.com/promptctl/cc-candybar/commit/5a804bae2e48bf30b8b4d2ff3d85331f9dff15ad))

## [1.162.5](https://github.com/promptctl/cc-candybar/compare/v1.162.4...v1.162.5) (2026-10-30)

### Bug Fixes

* **daemon:** a reload of the inputs a state was built from keeps it, so a save reopens each view once (brandon-unfiled-3248.0rr5) ([#484](https://github.com/promptctl/cc-candybar/issues/484)) ([df3c874](https://github.com/promptctl/cc-candybar/commit/df3c874c2a35e7f73d2857ab19c085ce8fe7c0d7))

## [1.162.4](https://github.com/promptctl/cc-candybar/compare/v1.162.3...v1.162.4) (2026-10-29)

### Bug Fixes

* **daemon:** every config load says why it ran, and a click reloads no entry (brandon-unfiled-3248.7nq0) ([#481](https://github.com/promptctl/cc-candybar/issues/481)) ([34f2f8f](https://github.com/promptctl/cc-candybar/commit/34f2f8f995929cdfb25ae15d119ac336290790d4))

## [1.162.3](https://github.com/promptctl/cc-candybar/compare/v1.162.2...v1.162.3) (2026-10-29)

### Bug Fixes

* **test:** the tmux stub waits on a gate the test holds (brandon-unfiled-3248.009i) ([#480](https://github.com/promptctl/cc-candybar/issues/480)) ([fd6ec8d](https://github.com/promptctl/cc-candybar/commit/fd6ec8d4733e93e217d07463582ca5edf2c228bb))

## [1.162.2](https://github.com/promptctl/cc-candybar/compare/v1.162.1...v1.162.2) (2026-10-29)

### Bug Fixes

* **test:** a removed folder's wait lays the folder down again each round, until the watch hears it (brandon-unfiled-3248.rfpg) ([#479](https://github.com/promptctl/cc-candybar/issues/479)) ([571b5c5](https://github.com/promptctl/cc-candybar/commit/571b5c50dc27af202258dd28207a56c2deaa5169))

## [1.162.1](https://github.com/promptctl/cc-candybar/compare/v1.162.0...v1.162.1) (2026-10-29)

### Bug Fixes

* **test:** a watched-file rewrite is a rename over the file, re-applied until the feed hears it (brandon-unfiled-3248.v9ix) ([#478](https://github.com/promptctl/cc-candybar/issues/478)) ([2377fc2](https://github.com/promptctl/cc-candybar/commit/2377fc2986a52b1c81e1717e5c90e7b17373a205))

## [1.162.0](https://github.com/promptctl/cc-candybar/compare/v1.161.4...v1.162.0) (2026-10-29)

### Features

* **approval:** approving a repository covers all of its worktrees (candybar-plugins-vf6g.svv) ([#477](https://github.com/promptctl/cc-candybar/issues/477)) ([c0cbfc6](https://github.com/promptctl/cc-candybar/commit/c0cbfc62bf5d8cc64dcaf60c67df971379b28fcc))

## [1.161.4](https://github.com/promptctl/cc-candybar/compare/v1.161.3...v1.161.4) (2026-10-28)

### Bug Fixes

* **load-gate:** the budget judges the charge once V8 has collected (brandon-frame-feed-znsy.zpm) ([#475](https://github.com/promptctl/cc-candybar/issues/475)) ([fd4f89e](https://github.com/promptctl/cc-candybar/commit/fd4f89eba779df530659e2fd7e1506eac358f8d1))

## [1.161.3](https://github.com/promptctl/cc-candybar/compare/v1.161.2...v1.161.3) (2026-10-28)

### Bug Fixes

* **menu:** a menu's items are the theme's shades of its header's colour; the trial looks sit in 🧪 trials (brandon-menus-sjhy.6xa) ([#451](https://github.com/promptctl/cc-candybar/issues/451)) ([f2eecdf](https://github.com/promptctl/cc-candybar/commit/f2eecdf3cb2dbd4e1b9ff2837047e9aeadae7d7f))

## [1.161.2](https://github.com/promptctl/cc-candybar/compare/v1.161.1...v1.161.2) (2026-10-28)

### Bug Fixes

* **test:** the real-client e2e runs the client again on a blank answer, as the next tick would (brandon-unfiled-3248.s1je) ([#474](https://github.com/promptctl/cc-candybar/issues/474)) ([c425751](https://github.com/promptctl/cc-candybar/commit/c425751301e47461eaace7e400402d0882682ee6))

## [1.161.1](https://github.com/promptctl/cc-candybar/compare/v1.161.0...v1.161.1) (2026-10-28)

### Bug Fixes

* **check:** each preset's pass awaits the runs its payload started (brandon-unfiled-3248.qniv) ([#470](https://github.com/promptctl/cc-candybar/issues/470)) ([1a69a2d](https://github.com/promptctl/cc-candybar/commit/1a69a2d3008355bf63db5bb29fd536ea9d1eab7c))

## [1.161.0](https://github.com/promptctl/cc-candybar/compare/v1.160.11...v1.161.0) (2026-10-28)

### Features

* **bench:** a benchmark of what a statusline tick costs (brandon-unfiled-3248.1vnf) ([#473](https://github.com/promptctl/cc-candybar/issues/473)) ([10aa78b](https://github.com/promptctl/cc-candybar/commit/10aa78b576fe62e635399b0300e17c1ef0b1e65a))

## [1.160.11](https://github.com/promptctl/cc-candybar/compare/v1.160.10...v1.160.11) (2026-10-28)

### Bug Fixes

* **daemon:** the repository answers get a watched folder of their own; nothing watches the state folder the log writes to (brandon-unfiled-3248.0m61) ([#471](https://github.com/promptctl/cc-candybar/issues/471)) ([df480cf](https://github.com/promptctl/cc-candybar/commit/df480cf2a6da9871f1973a200f9b7fda112be13d))

## [1.160.10](https://github.com/promptctl/cc-candybar/compare/v1.160.9...v1.160.10) (2026-10-28)

### Bug Fixes

* **daemon:** a repo's watch is keyed on the directories it bound, and every pass rebinds it (brandon-unfiled-3248.gf07) ([#467](https://github.com/promptctl/cc-candybar/issues/467)) ([88e0cea](https://github.com/promptctl/cc-candybar/commit/88e0ceab9133a88fcba17a013ba1572b50db6441))

## [1.160.9](https://github.com/promptctl/cc-candybar/compare/v1.160.8...v1.160.9) (2026-10-27)

### Bug Fixes

* **daemon:** a repo's watch covers the whole refs tree of its common git dir (brandon-unfiled-3248.1x2q) ([#466](https://github.com/promptctl/cc-candybar/issues/466)) ([bf5cee0](https://github.com/promptctl/cc-candybar/commit/bf5cee06d09c18f6e48cb289d3e03d442c4896b5))

## [1.160.8](https://github.com/promptctl/cc-candybar/compare/v1.160.7...v1.160.8) (2026-10-27)

### Bug Fixes

* **cli:** a one-shot command exits once its streams have taken the plan (brandon-unfiled-3248.6di0) ([#465](https://github.com/promptctl/cc-candybar/issues/465)) ([80c6c54](https://github.com/promptctl/cc-candybar/commit/80c6c54a5f214b6f1eb182b540656eec3770c234))

## [1.160.7](https://github.com/promptctl/cc-candybar/compare/v1.160.6...v1.160.7) (2026-10-27)

### Bug Fixes

* **test:** the backoff test owns the one clock the cooldown reads (brandon-unfiled-3248.9h9) ([#464](https://github.com/promptctl/cc-candybar/issues/464)) ([7c7eb31](https://github.com/promptctl/cc-candybar/commit/7c7eb3123c7a361191f1bc79aa403b1190e3a07c))

## [1.160.6](https://github.com/promptctl/cc-candybar/compare/v1.160.5...v1.160.6) (2026-10-27)

### Bug Fixes

* **doctor:** an empty config argument to doctor and check is no override, as the bar reads it (brandon-unfiled-3248.e3r) ([#463](https://github.com/promptctl/cc-candybar/issues/463)) ([a560eb1](https://github.com/promptctl/cc-candybar/commit/a560eb1cab9d992ac084c05c7a75465835666512))

## [1.160.5](https://github.com/promptctl/cc-candybar/compare/v1.160.4...v1.160.5) (2026-10-27)

### Bug Fixes

* **protocol:** check:protocol reads every anchor from code (brandon-unfiled-3248.x4t) ([#462](https://github.com/promptctl/cc-candybar/issues/462)) ([963899b](https://github.com/promptctl/cc-candybar/commit/963899b090b5471adf79b14c85343af1dc49c8ae))

## [1.160.4](https://github.com/promptctl/cc-candybar/compare/v1.160.3...v1.160.4) (2026-10-27)

### Bug Fixes

* **test:** every poll names what never held, and one helper keeps real time under a fake clock (brandon-unfiled-3248.bqq) ([#460](https://github.com/promptctl/cc-candybar/issues/460)) ([e95f6d4](https://github.com/promptctl/cc-candybar/commit/e95f6d40b74430e3ed0c815b584dfff41b0c08f8))

## [1.160.3](https://github.com/promptctl/cc-candybar/compare/v1.160.2...v1.160.3) (2026-10-27)

### Bug Fixes

* **config:** a symlinked config is watched where a write to it lands, and no file is watched by its inode (brandon-unfiled-3248.wyc) ([#459](https://github.com/promptctl/cc-candybar/issues/459)) ([68a0bd7](https://github.com/promptctl/cc-candybar/commit/68a0bd744efdcc5c3292272895a34a54e880db58))

## [1.160.2](https://github.com/promptctl/cc-candybar/compare/v1.160.1...v1.160.2) (2026-10-27)

### Bug Fixes

* a plugin folder whose watch has stopped delivering reads as stalled, not frozen (candybar-plugin-api-4rls.yaw) ([#458](https://github.com/promptctl/cc-candybar/issues/458)) ([a907bfe](https://github.com/promptctl/cc-candybar/commit/a907bfebbff8f2f4db0c2c8fd1b9b00c3479fa39))

## [1.160.1](https://github.com/promptctl/cc-candybar/compare/v1.160.0...v1.160.1) (2026-10-27)

### Bug Fixes

* **daemon:** the session-state rename leaves the daemon's thread, and the load gate's steady phase starts once the collection's backlog is served (brandon-frame-feed-znsy.2dj) ([#457](https://github.com/promptctl/cc-candybar/issues/457)) ([d92aece](https://github.com/promptctl/cc-candybar/commit/d92aece3eea9069a6cd603ee2fe21f169812f1d5))

## [1.160.0](https://github.com/promptctl/cc-candybar/compare/v1.159.0...v1.160.0) (2026-10-27)

### Features

* **config:** a repository's config runs only once the user approves it in the bar (brandon-unfiled-3248.kezw) ([#454](https://github.com/promptctl/cc-candybar/issues/454)) ([f945a18](https://github.com/promptctl/cc-candybar/commit/f945a18e70e9dd90588d3ee8b7ec4d7d175564b9))

## [1.159.0](https://github.com/promptctl/cc-candybar/compare/v1.158.1...v1.159.0) (2026-10-27)

### Features

* **menu:** every bar says how it is redrawn, in a cell beside the door (brandon-unfiled-3248.9uht) ([#448](https://github.com/promptctl/cc-candybar/issues/448)) ([c72c7c4](https://github.com/promptctl/cc-candybar/commit/c72c7c42a53d716951a4b5f391475c3111dd8f12))

## [1.158.1](https://github.com/promptctl/cc-candybar/compare/v1.158.0...v1.158.1) (2026-10-27)

### Bug Fixes

* **daemon:** a click says how long it waited, and the load gate clicks beside a shown feed (brandon-unfiled-3248.9b04) ([#447](https://github.com/promptctl/cc-candybar/issues/447)) ([f27c3af](https://github.com/promptctl/cc-candybar/commit/f27c3af161e1ddb2f16b86fc8ff370c450163956))

## [1.158.0](https://github.com/promptctl/cc-candybar/compare/v1.157.0...v1.158.0) (2026-10-27)

### Features

* **sources:** every source records its refreshes in one ledger (8ro6 §7) ([#446](https://github.com/promptctl/cc-candybar/issues/446)) ([99568f4](https://github.com/promptctl/cc-candybar/commit/99568f4ac50246f6a033cb582a65f0e3c7a5d582))

## [1.157.0](https://github.com/promptctl/cc-candybar/compare/v1.156.4...v1.157.0) (2026-10-26)

### ⚠ BREAKING CHANGES

* **test:** the built-in `ceiling` segment and cc-candybar's memento integration are removed (#443). memento 0.11.0 and later ship their own cc-candybar plugin: place `plugins.memento.ceiling` where `ceiling` stood. A config that still names `ceiling` gets an error saying the segment was removed. Plugins can now declare per-session sources that a program writes, `run` actions that run the plugin's own program, and their own variables (#441).

### Bug Fixes

* **test:** a key's run waits at a gate the test opens, so a loaded runner cannot end it before the check (brandon-unfiled-3248.2uq4) ([#445](https://github.com/promptctl/cc-candybar/issues/445)) ([0b3046c](https://github.com/promptctl/cc-candybar/commit/0b3046c23ea645d918c8637267116bb18eecaced)), closes [promptctl/cc-candybar#441](https://github.com/promptctl/cc-candybar/issues/441) [#443](https://github.com/promptctl/cc-candybar/issues/443)

## [1.156.4](https://github.com/promptctl/cc-candybar/compare/v1.156.3...v1.156.4) (2026-10-23)

### Bug Fixes

* **menu:** a sub-menu closes when its parent closes (brandon-menus-sjhy.9p6) ([#418](https://github.com/promptctl/cc-candybar/issues/418)) ([9c65b5a](https://github.com/promptctl/cc-candybar/commit/9c65b5a2315f16c1e50bd26cd397654754974dba))

## [1.156.3](https://github.com/promptctl/cc-candybar/compare/v1.156.2...v1.156.3) (2026-10-23)

### Bug Fixes

* **render-cache:** a cache is closed, and the heap tools read snapshots past 512 MiB (8ro6) ([#417](https://github.com/promptctl/cc-candybar/issues/417)) ([f1f4822](https://github.com/promptctl/cc-candybar/commit/f1f4822e7a54bdc010194ac77eaaabe3e4be595a)), closes [#416](https://github.com/promptctl/cc-candybar/issues/416)

## [1.156.2](https://github.com/promptctl/cc-candybar/compare/v1.156.1...v1.156.2) (2026-10-23)

### Bug Fixes

* **menu:** neighbouring menu cells wear two shades joined by a filled arrow (brandon-menus-sjhy.b9w) ([#415](https://github.com/promptctl/cc-candybar/issues/415)) ([fefa3a1](https://github.com/promptctl/cc-candybar/commit/fefa3a1e1b600fea9df0cae164274e4f500db01a))

## [1.156.1](https://github.com/promptctl/cc-candybar/compare/v1.156.0...v1.156.1) (2026-10-22)

### Bug Fixes

* **doctor:** effect refresh judges from the settings files again; remove the arrival-count measure (brandon-doctor-v62x.5at) ([#414](https://github.com/promptctl/cc-candybar/issues/414)) ([b861a25](https://github.com/promptctl/cc-candybar/commit/b861a25684942958c6564128b2c651097c0abea5)), closes [#394](https://github.com/promptctl/cc-candybar/issues/394)

## [1.156.0](https://github.com/promptctl/cc-candybar/compare/v1.155.2...v1.156.0) (2026-10-22)

### Features

* **menu:** theme and arrange beside preset; wrap and padding in ⚙ config ([#413](https://github.com/promptctl/cc-candybar/issues/413)) ([939d570](https://github.com/promptctl/cc-candybar/commit/939d5702aa465c220e7271d74abe2cc5b7e05d42))

## [1.155.2](https://github.com/promptctl/cc-candybar/compare/v1.155.1...v1.155.2) (2026-10-22)

### Bug Fixes

* **daemon:** a repo's watch outlives the git values cached from it, so macOS stops leaking a CFString per watched directory per refetch ([#412](https://github.com/promptctl/cc-candybar/issues/412)) ([b2ac597](https://github.com/promptctl/cc-candybar/commit/b2ac597e6774de3d65c7ee12da9951615b954346))

## [1.155.1](https://github.com/promptctl/cc-candybar/compare/v1.155.0...v1.155.1) (2026-10-22)

### Bug Fixes

* **daemon:** one unread footprint no longer ends the daemon on the RSS standing in for it ([#411](https://github.com/promptctl/cc-candybar/issues/411)) ([c1056b2](https://github.com/promptctl/cc-candybar/commit/c1056b28564fbf384e712a6d46979d012bcc76f8))

## [1.155.0](https://github.com/promptctl/cc-candybar/compare/v1.154.1...v1.155.0) (2026-10-22)

### Features

* **lanes:** lane C draws the animated bar in the tmux status line too ([#405](https://github.com/promptctl/cc-candybar/issues/405)) ([3d7e291](https://github.com/promptctl/cc-candybar/commit/3d7e2919e22c42034ad5d1586465a83a93f0e78c))

## [1.154.1](https://github.com/promptctl/cc-candybar/compare/v1.154.0...v1.154.1) (2026-10-21)

### Bug Fixes

* **lanes:** lane B's restart waits for the TUI to mount before judging it a one-shot ([#410](https://github.com/promptctl/cc-candybar/issues/410)) ([1b417ef](https://github.com/promptctl/cc-candybar/commit/1b417ef0bd9702e3dcaa60bfb629b70c4a7bb15c))

## [1.154.0](https://github.com/promptctl/cc-candybar/compare/v1.153.0...v1.154.0) (2026-10-21)

### Features

* **lanes:** lane B's restart types one line the user can rerun from history ([#409](https://github.com/promptctl/cc-candybar/issues/409)) ([2f97f83](https://github.com/promptctl/cc-candybar/commit/2f97f83def8ea99e34cd2988022cd46da76a65f2))

## [1.153.0](https://github.com/promptctl/cc-candybar/compare/v1.152.2...v1.153.0) (2026-10-21)

### Features

* **lanes:** lane B starts from one variable and `claude` ([#408](https://github.com/promptctl/cc-candybar/issues/408)) ([e339398](https://github.com/promptctl/cc-candybar/commit/e339398a9ace9eab2bf10065ace0de1432d59102))

## [1.152.2](https://github.com/promptctl/cc-candybar/compare/v1.152.1...v1.152.2) (2026-10-21)

### Bug Fixes

* **lanes:** lane B starts a session with no conversation afresh instead of refusing ([#407](https://github.com/promptctl/cc-candybar/issues/407)) ([6a07c0c](https://github.com/promptctl/cc-candybar/commit/6a07c0cf2c5430d770584f0410c751e2c1524d0b))

## [1.152.1](https://github.com/promptctl/cc-candybar/compare/v1.152.0...v1.152.1) (2026-10-21)

### Bug Fixes

* **lanes:** lane B restarts a --worktree session back into its worktree ([#406](https://github.com/promptctl/cc-candybar/issues/406)) ([f70a41c](https://github.com/promptctl/cc-candybar/commit/f70a41cee91b1dfbe949ebe823ae39c6f3c0603c))

## [1.152.0](https://github.com/promptctl/cc-candybar/compare/v1.151.0...v1.152.0) (2026-10-21)

### Features

* **daemon:** a fed bar shows the pace its feed draws at, beside the door ([#404](https://github.com/promptctl/cc-candybar/issues/404)) ([a2292fc](https://github.com/promptctl/cc-candybar/commit/a2292fc40c64415a15efe0be908f7fd8fda2134f))

## [1.151.0](https://github.com/promptctl/cc-candybar/compare/v1.150.0...v1.151.0) (2026-10-21)

### Features

* **menu:** each lane's toggle shows the frames it is sent ([5a0c087](https://github.com/promptctl/cc-candybar/commit/5a0c087ca379b741e0e4d362810713e3fbf895b1)), closes [#399](https://github.com/promptctl/cc-candybar/issues/399) [post-#399](https://github.com/promptctl/post-/issues/399)

## [1.150.0](https://github.com/promptctl/cc-candybar/compare/v1.149.5...v1.150.0) (2026-10-21)

### Features

* **menu:** each lane toggle explains its lane and starts what it runs ([#399](https://github.com/promptctl/cc-candybar/issues/399)) ([f09bdf8](https://github.com/promptctl/cc-candybar/commit/f09bdf8dad369a555a068ae1154a71ef62bf9553))

## [1.149.5](https://github.com/promptctl/cc-candybar/compare/v1.149.4...v1.149.5) (2026-10-21)

### Bug Fixes

* **daemon:** a transcript fold reads one window at a time, not the whole file ([#400](https://github.com/promptctl/cc-candybar/issues/400)) ([df72746](https://github.com/promptctl/cc-candybar/commit/df727460f094737f2de66021ca4f4e871610669b))

## [1.149.4](https://github.com/promptctl/cc-candybar/compare/v1.149.3...v1.149.4) (2026-10-21)

### Bug Fixes

* **render:** an omitted render selection resolves through the daemon's globals resolution ([#401](https://github.com/promptctl/cc-candybar/issues/401)) ([deacf85](https://github.com/promptctl/cc-candybar/commit/deacf851ef798fb416dd0aa2061df0af75d3f946))

## [1.149.3](https://github.com/promptctl/cc-candybar/compare/v1.149.2...v1.149.3) (2026-10-21)

### Bug Fixes

* **doctor:** judge each bar's effect refresh against its own session's settings chain ([#398](https://github.com/promptctl/cc-candybar/issues/398)) ([fec6ce5](https://github.com/promptctl/cc-candybar/commit/fec6ce5e28cb7f3545fa4017fc07beb9f8232a84))

## [1.149.2](https://github.com/promptctl/cc-candybar/compare/v1.149.1...v1.149.2) (2026-10-21)

### Bug Fixes

* **daemon:** the memory backstop judges what macOS charges, not RSS ([#397](https://github.com/promptctl/cc-candybar/issues/397)) ([e50cedb](https://github.com/promptctl/cc-candybar/commit/e50cedb24070fbf15956fbe88a6539b041b7e104)), closes [#391](https://github.com/promptctl/cc-candybar/issues/391)

## [1.149.1](https://github.com/promptctl/cc-candybar/compare/v1.149.0...v1.149.1) (2026-10-21)

### Bug Fixes

* **doctor:** effect refresh judges the redraw rate from render arrivals (brandon-doctor-v62x.5at) ([a3c4bda](https://github.com/promptctl/cc-candybar/commit/a3c4bda5a9cd891c2484204eaf9e5cc7e9136a49))

## [1.149.0](https://github.com/promptctl/cc-candybar/compare/v1.148.9...v1.149.0) (2026-10-21)

### Features

* **menu:** the animation-lane toggles live in a 🧪 toggles menu under ⚙ config ([#396](https://github.com/promptctl/cc-candybar/issues/396)) ([de5d65d](https://github.com/promptctl/cc-candybar/commit/de5d65d1f72758ebcc275c6140124e00214dc061))

## [1.148.9](https://github.com/promptctl/cc-candybar/compare/v1.148.8...v1.148.9) (2026-10-21)

### Bug Fixes

* **release:** pin publishing to 1.x ([#395](https://github.com/promptctl/cc-candybar/issues/395)) ([4cbaf0c](https://github.com/promptctl/cc-candybar/commit/4cbaf0c6d1cc7710511b7d772a814c363f8d432d))

## [1.148.8](https://github.com/promptctl/cc-candybar/compare/v1.148.7...v1.148.8) (2026-10-20)


### Bug Fixes

* **doctor:** cc-candybar doctor judges the session's own terminal width (brandon-doctor-v62x.1z2) ([#393](https://github.com/promptctl/cc-candybar/issues/393)) ([f810f85](https://github.com/promptctl/cc-candybar/commit/f810f85cbbc88d7d91cad617a9edc3c49bd722ee))

## [1.148.7](https://github.com/promptctl/cc-candybar/compare/v1.148.6...v1.148.7) (2026-10-20)


### Bug Fixes

* **doctor:** tmuxTruecolor reads CLAUDE_CODE_TMUX_TRUECOLOR over the settings chain (brandon-doctor-v62x.cbn) ([#392](https://github.com/promptctl/cc-candybar/issues/392)) ([1930d50](https://github.com/promptctl/cc-candybar/commit/1930d50795ce7b4916be94d98467ffcd75740f91))

## [1.148.6](https://github.com/promptctl/cc-candybar/compare/v1.148.5...v1.148.6) (2026-10-20)


### Bug Fixes

* **daemon:** render-cache entries share one compile per config, bounded by bytes (brandon-unfiled-3248.8yp) ([#391](https://github.com/promptctl/cc-candybar/issues/391)) ([a14ede9](https://github.com/promptctl/cc-candybar/commit/a14ede93f98021c81dbb86a192b84674a45a3c34))
* **doctor:** cc-candybar doctor reads the doctor's stores under the daemon's state dir (brandon-doctor-v62x.bmf) ([#388](https://github.com/promptctl/cc-candybar/issues/388)) ([513a905](https://github.com/promptctl/cc-candybar/commit/513a9059e4413dbc752f5102110912dc6974f824))

## [1.148.5](https://github.com/promptctl/cc-candybar/compare/v1.148.4...v1.148.5) (2026-10-20)


### Bug Fixes

* **config:** a bare --config is refused on the bar, not silently dropped (brandon-unfiled-3248.8bz) ([#390](https://github.com/promptctl/cc-candybar/issues/390)) ([08c75cb](https://github.com/promptctl/cc-candybar/commit/08c75cb9578e88cfa512fe507c793776a9719ffa))

## [1.148.4](https://github.com/promptctl/cc-candybar/compare/v1.148.3...v1.148.4) (2026-10-20)


### Bug Fixes

* **daemon:** a deleted bundle ends the daemon (brandon-unfiled-3248.bsz) ([#389](https://github.com/promptctl/cc-candybar/issues/389)) ([114b20a](https://github.com/promptctl/cc-candybar/commit/114b20a13519acf480741a3abc2b1ccc14a8032d))

## [1.148.3](https://github.com/promptctl/cc-candybar/compare/v1.148.2...v1.148.3) (2026-10-20)


### Bug Fixes

* **mod:** a child the band stopped ends with no failure logged (candybar-animation-wbxz.81o.2jn) ([#386](https://github.com/promptctl/cc-candybar/issues/386)) ([bb3ab4c](https://github.com/promptctl/cc-candybar/commit/bb3ab4c28266e3d160df6050acba81d2de963835))

## [1.148.2](https://github.com/promptctl/cc-candybar/compare/v1.148.1...v1.148.2) (2026-10-20)


### Bug Fixes

* **doctor:** a home-directory session's settings file is the user's; effect refresh's fix scope documented (brandon-doctor-v62x.49w) ([#384](https://github.com/promptctl/cc-candybar/issues/384)) ([ddc371e](https://github.com/promptctl/cc-candybar/commit/ddc371e7d6164eee8bf574ec4f4c6fe5ca2656ec))
* **test:** the frame-feed click-error test waits on frames, not on time (candybar-animation-wbxz.81o.dl4) ([#383](https://github.com/promptctl/cc-candybar/issues/383)) ([e38fff8](https://github.com/promptctl/cc-candybar/commit/e38fff8b0d856e7571c26587ce4bddf6bec8d384))

## [1.148.1](https://github.com/promptctl/cc-candybar/compare/v1.148.0...v1.148.1) (2026-10-20)


### Bug Fixes

* **doctor:** effect refresh reads the statusLine Claude Code runs (brandon-doctor-v62x.49w) ([#382](https://github.com/promptctl/cc-candybar/issues/382)) ([2dac849](https://github.com/promptctl/cc-candybar/commit/2dac8491de8a4ad1432f43de09a7b234a1d289d9))

# [1.148.0](https://github.com/promptctl/cc-candybar/compare/v1.147.2...v1.148.0) (2026-10-20)


### Features

* **band:** the daemon sends the band's frames, and the mod's child is the Rust client (candybar-animation-wbxz.81o.yaq) ([#381](https://github.com/promptctl/cc-candybar/issues/381)) ([7902b87](https://github.com/promptctl/cc-candybar/commit/7902b87d167d491f447086bd3d188df4bbeba7bd))

## [1.147.2](https://github.com/promptctl/cc-candybar/compare/v1.147.1...v1.147.2) (2026-10-20)


### Bug Fixes

* **doctor:** effect refresh reads motion off the drawn frame (brandon-doctor-v62x.tgp) ([#380](https://github.com/promptctl/cc-candybar/issues/380)) ([881fad3](https://github.com/promptctl/cc-candybar/commit/881fad3052e6c731a106bf24dcd36fc118404c5a))

## [1.147.1](https://github.com/promptctl/cc-candybar/compare/v1.147.0...v1.147.1) (2026-10-19)


### Bug Fixes

* **daemon:** a click error's hold is a question of time, asked by every render alike (candybar-animation-wbxz.81o.t39) ([#378](https://github.com/promptctl/cc-candybar/issues/378)) ([1aabe99](https://github.com/promptctl/cc-candybar/commit/1aabe9972311c952015bfb01da6cfba481dc70f0))

# [1.147.0](https://github.com/promptctl/cc-candybar/compare/v1.146.0...v1.147.0) (2026-10-19)


### Features

* **doctor:** session data is readable (brandon-doctor-v62x.p4l) ([#379](https://github.com/promptctl/cc-candybar/issues/379)) ([0e3c74d](https://github.com/promptctl/cc-candybar/commit/0e3c74dc51b5607578089e1f10b0c0615054edf4))

# [1.146.0](https://github.com/promptctl/cc-candybar/compare/v1.145.0...v1.146.0) (2026-10-19)


### Features

* **doctor:** segments have their data (brandon-doctor-v62x.onf) ([#376](https://github.com/promptctl/cc-candybar/issues/376)) ([17b7a9b](https://github.com/promptctl/cc-candybar/commit/17b7a9b894238eb2ff1cf2d293f423aab7c37fca))

# [1.145.0](https://github.com/promptctl/cc-candybar/compare/v1.144.0...v1.145.0) (2026-10-19)


### Features

* **bar-pane:** the bar in a tmux pane beside its session, as the daemon pushes it (lane C) ([#352](https://github.com/promptctl/cc-candybar/issues/352)) ([ce1fe76](https://github.com/promptctl/cc-candybar/commit/ce1fe765560f459fbb632b047f5953e5ac775481))

# [1.144.0](https://github.com/promptctl/cc-candybar/compare/v1.143.0...v1.144.0) (2026-10-19)


### Features

* **mod:** candybar's bar and menus, animated in the band above the prompt (lane A) ([#354](https://github.com/promptctl/cc-candybar/issues/354)) ([e7b76e0](https://github.com/promptctl/cc-candybar/commit/e7b76e098658b05be0759200a3b3491f8bb202e2))

# [1.143.0](https://github.com/promptctl/cc-candybar/compare/v1.142.0...v1.143.0) (2026-10-19)


### Features

* **animation:** each lane behind its own toggle, in the settings menu ([#374](https://github.com/promptctl/cc-candybar/issues/374)) ([11b805b](https://github.com/promptctl/cc-candybar/commit/11b805ba084d4b84f380453ab0b1a439fc8b89e5))

# [1.142.0](https://github.com/promptctl/cc-candybar/compare/v1.141.1...v1.142.0) (2026-10-19)


### Features

* **doctor:** daemon is healthy (brandon-doctor-v62x.5mq) ([#373](https://github.com/promptctl/cc-candybar/issues/373)) ([dbe653f](https://github.com/promptctl/cc-candybar/commit/dbe653fce99cf5db8bf54cfb3b25763b6a8329d7))

## [1.141.1](https://github.com/promptctl/cc-candybar/compare/v1.141.0...v1.141.1) (2026-10-19)


### Bug Fixes

* **daemon:** a pushed frame only draws; the request records what it said (candybar-animation-wbxz.81o.7ah) ([#371](https://github.com/promptctl/cc-candybar/issues/371)) ([6e8cd27](https://github.com/promptctl/cc-candybar/commit/6e8cd27442d1f060f17a5ee192207d40c2af0f89))

# [1.141.0](https://github.com/promptctl/cc-candybar/compare/v1.140.0...v1.141.0) (2026-10-19)


### Features

* **doctor:** install is current (brandon-doctor-v62x.tfb) ([#372](https://github.com/promptctl/cc-candybar/issues/372)) ([b7f6fb2](https://github.com/promptctl/cc-candybar/commit/b7f6fb2924e34f74ad9573b52d6f81002a4a520c))

# [1.140.0](https://github.com/promptctl/cc-candybar/compare/v1.139.1...v1.140.0) (2026-10-19)


### Features

* **doctor:** UTF-8 and terminal-width rows ([#369](https://github.com/promptctl/cc-candybar/issues/369)) ([0a29f32](https://github.com/promptctl/cc-candybar/commit/0a29f3201755cdaf4300f16bb9a7db677b0d9a4c))

## [1.139.1](https://github.com/promptctl/cc-candybar/compare/v1.139.0...v1.139.1) (2026-10-19)


### Bug Fixes

* **render:** segment text no longer carries bidi overrides or C1 controls to the terminal (brandon-unfiled-3248.qum) ([#370](https://github.com/promptctl/cc-candybar/issues/370)) ([078b549](https://github.com/promptctl/cc-candybar/commit/078b549a334d17a9c3c53dc17790dd8c5f23f12a))

# [1.139.0](https://github.com/promptctl/cc-candybar/compare/v1.138.0...v1.139.0) (2026-10-19)


### Features

* **daemon:** push a session's frames to subscribers ([#357](https://github.com/promptctl/cc-candybar/issues/357)) ([8844689](https://github.com/promptctl/cc-candybar/commit/88446893c4cc2fe275ac609b613ee15059761280))

# [1.138.0](https://github.com/promptctl/cc-candybar/compare/v1.137.0...v1.138.0) (2026-10-19)


### Bug Fixes

* **config:** a persist/reset target naming a removed globals field says why; plugin 2.1.0; stale charset refs gone (brandon-unfiled-3248.btn) ([048b88e](https://github.com/promptctl/cc-candybar/commit/048b88e062035ac88bbe3cf4b40c0bb54425246f))
* **daemon:** a render in flight pins its render-cache entry; eviction takes the oldest unpinned ([#367](https://github.com/promptctl/cc-candybar/issues/367)) ([cae3cf6](https://github.com/promptctl/cc-candybar/commit/cae3cf663759d84c0751c9dfaa45683072c087d8))


### Features

* **config:** delete ascii mode — the bar always draws Nerd Font glyphs (brandon-unfiled-3248.btn) ([4c61e85](https://github.com/promptctl/cc-candybar/commit/4c61e85656ec7dbd313f11cfb4b7841dcf87d1e4))

# [1.137.0](https://github.com/promptctl/cc-candybar/compare/v1.136.1...v1.137.0) (2026-10-19)


### Features

* **model:** effort gauge beside the model name ([#318](https://github.com/promptctl/cc-candybar/issues/318)) ([e3fe381](https://github.com/promptctl/cc-candybar/commit/e3fe38110b24f576bb5d1e980a642e779d845770))

## [1.136.1](https://github.com/promptctl/cc-candybar/compare/v1.136.0...v1.136.1) (2026-10-19)


### Bug Fixes

* **daemon:** a disposed config's store lets go of the SessionState atom (brandon-unfiled-3248.t14) ([#365](https://github.com/promptctl/cc-candybar/issues/365)) ([0e3f5b8](https://github.com/promptctl/cc-candybar/commit/0e3f5b8fec56e28bac29e18453273db42a4f1662))

# [1.136.0](https://github.com/promptctl/cc-candybar/compare/v1.135.0...v1.136.0) (2026-10-19)


### Features

* **plugins:** a plugin segment may hold a state variable, so a click can open a detail of its own ([#366](https://github.com/promptctl/cc-candybar/issues/366)) ([4060f0d](https://github.com/promptctl/cc-candybar/commit/4060f0d6ce41ecd294d603e5e44d00f8f8e60345))

# [1.135.0](https://github.com/promptctl/cc-candybar/compare/v1.134.0...v1.135.0) (2026-10-19)


### Features

* **plugins:** cc-candybar plugin install <path | owner/repo | git URL> ([#364](https://github.com/promptctl/cc-candybar/issues/364)) ([6a525ce](https://github.com/promptctl/cc-candybar/commit/6a525ce65f4987d8f985cf32a4995a592f8a8139))

# [1.134.0](https://github.com/promptctl/cc-candybar/compare/v1.133.0...v1.134.0) (2026-10-16)


### Features

* **doctor:** links check — the terminal draws OSC 8 links, and tmux passes them through ([#361](https://github.com/promptctl/cc-candybar/issues/361)) ([158cd5d](https://github.com/promptctl/cc-candybar/commit/158cd5d2c701665d269e7359bd193eb81593409e))

# [1.133.0](https://github.com/promptctl/cc-candybar/compare/v1.132.2...v1.133.0) (2026-10-16)


### Features

* **doctor:** Nerd Font check — does the terminal drawing the bar have its glyphs ([#360](https://github.com/promptctl/cc-candybar/issues/360)) ([c9bcf79](https://github.com/promptctl/cc-candybar/commit/c9bcf79a53ee3077244392d59804bdf3c92070ec))

## [1.132.2](https://github.com/promptctl/cc-candybar/compare/v1.132.1...v1.132.2) (2026-10-16)


### Bug Fixes

* **var-system:** a cache key that throws is the variable's error, not the empty key ([#359](https://github.com/promptctl/cc-candybar/issues/359)) ([72bcbe1](https://github.com/promptctl/cc-candybar/commit/72bcbe12ba05a312b724267cb1332552d184688f))

## [1.132.1](https://github.com/promptctl/cc-candybar/compare/v1.132.0...v1.132.1) (2026-10-16)


### Bug Fixes

* **loader:** a template variable's cache: is refused, not ignored ([#358](https://github.com/promptctl/cc-candybar/issues/358)) ([253106a](https://github.com/promptctl/cc-candybar/commit/253106a41f6f7eeaa2ecc3901e88bf7d5c2cf901))

# [1.132.0](https://github.com/promptctl/cc-candybar/compare/v1.131.0...v1.132.0) (2026-10-16)


### Features

* **daemon:** the render event says when the forge's PR was an earlier one ([#355](https://github.com/promptctl/cc-candybar/issues/355)) ([e8fe75d](https://github.com/promptctl/cc-candybar/commit/e8fe75d635cf9a988241c481941f9b7862a975b4))

# [1.131.0](https://github.com/promptctl/cc-candybar/compare/v1.130.5...v1.131.0) (2026-10-16)


### Features

* **lit:** work-loop stage segment; a branch's PR in every state ([#353](https://github.com/promptctl/cc-candybar/issues/353)) ([c451544](https://github.com/promptctl/cc-candybar/commit/c4515441d81228f5e2bece47d071674622cab144))

## [1.130.5](https://github.com/promptctl/cc-candybar/compare/v1.130.4...v1.130.5) (2026-10-16)


### Bug Fixes

* **render:** a layout when that throws costs its node, not the whole bar ([#351](https://github.com/promptctl/cc-candybar/issues/351)) ([ec9c777](https://github.com/promptctl/cc-candybar/commit/ec9c7771c904af25e76c8bd0f8049d7fed8e73a7))

## [1.130.4](https://github.com/promptctl/cc-candybar/compare/v1.130.3...v1.130.4) (2026-10-16)


### Bug Fixes

* **render:** a globals rule whose template throws renders its slot's floor and says so ([#349](https://github.com/promptctl/cc-candybar/issues/349)) ([978aa4a](https://github.com/promptctl/cc-candybar/commit/978aa4ac425efd2287019812f11f620d523ce376))

## [1.130.3](https://github.com/promptctl/cc-candybar/compare/v1.130.2...v1.130.3) (2026-10-16)


### Bug Fixes

* **daemon:** a render that throws or is refused still writes its render event ([#348](https://github.com/promptctl/cc-candybar/issues/348)) ([4755db7](https://github.com/promptctl/cc-candybar/commit/4755db7ab84de541dbc5600d7cfbc21e148f99a6))

## [1.130.2](https://github.com/promptctl/cc-candybar/compare/v1.130.1...v1.130.2) (2026-10-16)


### Bug Fixes

* **daemon:** the render event names the client hints it refused ([#347](https://github.com/promptctl/cc-candybar/issues/347)) ([53b513c](https://github.com/promptctl/cc-candybar/commit/53b513c99bddb97b8328c24ec1eba253aec0bf86))

## [1.130.1](https://github.com/promptctl/cc-candybar/compare/v1.130.0...v1.130.1) (2026-10-16)


### Bug Fixes

* **config:** a relative CC_CANDYBAR_CONFIG or --config resolves against the client's cwd ([#346](https://github.com/promptctl/cc-candybar/issues/346)) ([031c92c](https://github.com/promptctl/cc-candybar/commit/031c92ce4bafd57f6332cb97e5799d4a77b7b2e4))

# [1.130.0](https://github.com/promptctl/cc-candybar/compare/v1.129.5...v1.130.0) (2026-10-16)


### Features

* **settings:** the theme picker — a swatch beside every theme name, a two-row demo, style/variation/shade behind its gear ([#345](https://github.com/promptctl/cc-candybar/issues/345)) ([44ed949](https://github.com/promptctl/cc-candybar/commit/44ed949658c0ebba128f97c0b6fa154926c6996d))

## [1.129.5](https://github.com/promptctl/cc-candybar/compare/v1.129.4...v1.129.5) (2026-10-16)


### Bug Fixes

* **usage-store:** a session's record and speed ring live exactly as long as it is seen ([#344](https://github.com/promptctl/cc-candybar/issues/344)) ([e7ea90e](https://github.com/promptctl/cc-candybar/commit/e7ea90eaaa3a87e6b0a8de8c0211e9a3d81fc6f0))

## [1.129.4](https://github.com/promptctl/cc-candybar/compare/v1.129.3...v1.129.4) (2026-10-15)


### Bug Fixes

* **usage-store:** today catches up with never-rendering sessions by a background rescan ([#343](https://github.com/promptctl/cc-candybar/issues/343)) ([128c1c0](https://github.com/promptctl/cc-candybar/commit/128c1c0255e44c880f72c4c84263893fd9934bc9))

## [1.129.3](https://github.com/promptctl/cc-candybar/compare/v1.129.2...v1.129.3) (2026-10-15)


### Bug Fixes

* **usage-store:** today sums every session; the record cap is gone ([#341](https://github.com/promptctl/cc-candybar/issues/341)) ([3b97f28](https://github.com/promptctl/cc-candybar/commit/3b97f287a63bd77672235158922bad0b34b5f720))

## [1.129.2](https://github.com/promptctl/cc-candybar/compare/v1.129.1...v1.129.2) (2026-10-15)


### Bug Fixes

* **edit-mode:** the configure glyph is a default emoji, not a gear made wide by VS16 ([#340](https://github.com/promptctl/cc-candybar/issues/340)) ([fed719c](https://github.com/promptctl/cc-candybar/commit/fed719cef5c9b66dfc7e9b6fb2758dcc89bf483d))

## [1.129.1](https://github.com/promptctl/cc-candybar/compare/v1.129.0...v1.129.1) (2026-10-15)


### Bug Fixes

* **menu:** the preset delete glyph is a default emoji, measured as wide as it is drawn ([#338](https://github.com/promptctl/cc-candybar/issues/338)) ([f69e985](https://github.com/promptctl/cc-candybar/commit/f69e985a7f02253a1c81961998f4f4351ba4c5b3)), closes [#325](https://github.com/promptctl/cc-candybar/issues/325)

# [1.129.0](https://github.com/promptctl/cc-candybar/compare/v1.128.0...v1.129.0) (2026-10-15)


### Bug Fixes

* **activity:** only a prompt starts the bar's turn ([#336](https://github.com/promptctl/cc-candybar/issues/336)) ([bfb3f0f](https://github.com/promptctl/cc-candybar/commit/bfb3f0f38e1f7b1bbee9aff58d215931f1195fee))


### Features

* **plugins:** lit's ticket is the plugin lit ships, read from its statusline file ([#337](https://github.com/promptctl/cc-candybar/issues/337)) ([3489098](https://github.com/promptctl/cc-candybar/commit/3489098d9bd6b5812c3636c2279dcaf7e752afab))

# [1.128.0](https://github.com/promptctl/cc-candybar/compare/v1.127.2...v1.128.0) (2026-10-15)


### Features

* **effects:** a placement dissolves out when it leaves ([#334](https://github.com/promptctl/cc-candybar/issues/334)) ([763b2b0](https://github.com/promptctl/cc-candybar/commit/763b2b05f830ab19b99b90da666329b91a51f04c))

## [1.127.2](https://github.com/promptctl/cc-candybar/compare/v1.127.1...v1.127.2) (2026-10-15)


### Bug Fixes

* **daemon:** a render's log line names every warning its strip carried ([#335](https://github.com/promptctl/cc-candybar/issues/335)) ([424ef65](https://github.com/promptctl/cc-candybar/commit/424ef656df273978a1a9f770c9e5d3c6f7794b89))

## [1.127.1](https://github.com/promptctl/cc-candybar/compare/v1.127.0...v1.127.1) (2026-10-15)


### Bug Fixes

* **theme:** the colour code e5n touched, and its tests, hold the laws ([#331](https://github.com/promptctl/cc-candybar/issues/331)) ([ebc699a](https://github.com/promptctl/cc-candybar/commit/ebc699ad4c61c4d12f4d208f384d719dddceac8c)), closes [#326](https://github.com/promptctl/cc-candybar/issues/326) [#ffb65f](https://github.com/promptctl/cc-candybar/issues/ffb65f) [#333](https://github.com/promptctl/cc-candybar/issues/333)

# [1.127.0](https://github.com/promptctl/cc-candybar/compare/v1.126.0...v1.127.0) (2026-10-15)


### Features

* **effects:** a placement fades in when it appears ([#333](https://github.com/promptctl/cc-candybar/issues/333)) ([01689b7](https://github.com/promptctl/cc-candybar/commit/01689b73c1180712e649014d173adf88d3c29fe3))

# [1.126.0](https://github.com/promptctl/cc-candybar/compare/v1.125.0...v1.126.0) (2026-10-15)


### Features

* **effects:** a placement can carry its own effect ([#332](https://github.com/promptctl/cc-candybar/issues/332)) ([0571560](https://github.com/promptctl/cc-candybar/commit/0571560eac728a89e27286209e1639f81c624902))

# [1.125.0](https://github.com/promptctl/cc-candybar/compare/v1.124.0...v1.125.0) (2026-10-15)


### Features

* **doctor:** a bar wearing an effect needs statusLine.refreshInterval 1 ([#330](https://github.com/promptctl/cc-candybar/issues/330)) ([5260e66](https://github.com/promptctl/cc-candybar/commit/5260e66934ee3983185be1ab334b24a1f261208b))

# [1.124.0](https://github.com/promptctl/cc-candybar/compare/v1.123.0...v1.124.0) (2026-10-15)


### Features

* **render:** the whole bar wears a looping effect chosen by globals.effect ([#329](https://github.com/promptctl/cc-candybar/issues/329)) ([add6ddd](https://github.com/promptctl/cc-candybar/commit/add6ddd408447064dd1bfcbc999f74405ff0cf14))

# [1.123.0](https://github.com/promptctl/cc-candybar/compare/v1.122.0...v1.123.0) (2026-10-15)


### Features

* **theme:** each theme carries a default look, set from the bar ([#326](https://github.com/promptctl/cc-candybar/issues/326)) ([e686f75](https://github.com/promptctl/cc-candybar/commit/e686f758c67fcd8a9f5a60186ad7802df54bfd74)), closes [#328](https://github.com/promptctl/cc-candybar/issues/328)

# [1.122.0](https://github.com/promptctl/cc-candybar/compare/v1.121.0...v1.122.0) (2026-10-15)


### Features

* **theme:** the closed bar wears its theme's own shades, through a shade dial ([#325](https://github.com/promptctl/cc-candybar/issues/325)) ([a9b8e83](https://github.com/promptctl/cc-candybar/commit/a9b8e8384ebd02a789d3cd652da574aba6c29b17)), closes [#328](https://github.com/promptctl/cc-candybar/issues/328)

# [1.121.0](https://github.com/promptctl/cc-candybar/compare/v1.120.0...v1.121.0) (2026-10-15)


### Features

* **render:** each render is drawn at one instant, and bar:web redraws every second ([#328](https://github.com/promptctl/cc-candybar/issues/328)) ([d0163af](https://github.com/promptctl/cc-candybar/commit/d0163af8ffaa2b7cf13ed77618b156c9b2e3813c))

# [1.120.0](https://github.com/promptctl/cc-candybar/compare/v1.119.1...v1.120.0) (2026-10-15)


### Features

* **render:** endcaps choose among rich-js's named joiners ([#324](https://github.com/promptctl/cc-candybar/issues/324)) ([86dc4f2](https://github.com/promptctl/cc-candybar/commit/86dc4f2ebddc427bfdec4d3a3d401a4939a4424f))

## [1.119.1](https://github.com/promptctl/cc-candybar/compare/v1.119.0...v1.119.1) (2026-10-12)


### Performance Improvements

* **plugins:** check each plugin by its own declarations, not a full validateConfig ([#323](https://github.com/promptctl/cc-candybar/issues/323)) ([a9ce67f](https://github.com/promptctl/cc-candybar/commit/a9ce67f932fca88291003f5f699f2dcff6795519))

# [1.119.0](https://github.com/promptctl/cc-candybar/compare/v1.118.2...v1.119.0) (2026-10-12)


### Features

* **plugins:** installed plugins are discovered from plugin folders, data relative to the project ([#322](https://github.com/promptctl/cc-candybar/issues/322)) ([2d3943e](https://github.com/promptctl/cc-candybar/commit/2d3943e9f60fb55254485a8c50bdf8ce2b8660b2))

## [1.118.2](https://github.com/promptctl/cc-candybar/compare/v1.118.1...v1.118.2) (2026-10-12)


### Bug Fixes

* **config:** a project config layers over the user config instead of replacing it ([#321](https://github.com/promptctl/cc-candybar/issues/321)) ([2bec939](https://github.com/promptctl/cc-candybar/commit/2bec939922deb328f1d51f0315c39785734d5c5b))

## [1.118.1](https://github.com/promptctl/cc-candybar/compare/v1.118.0...v1.118.1) (2026-10-12)


### Bug Fixes

* **sources:** a watched file whose directories appear after load is read when written ([#320](https://github.com/promptctl/cc-candybar/issues/320)) ([e0146e9](https://github.com/promptctl/cc-candybar/commit/e0146e93f7e8b8851f9437037f23ce1ead936d60))

# [1.118.0](https://github.com/promptctl/cc-candybar/compare/v1.117.1...v1.118.0) (2026-10-12)


### Features

* **plugins:** apps ship segments as plugin definitions a config lists ([#319](https://github.com/promptctl/cc-candybar/issues/319)) ([b60ebc1](https://github.com/promptctl/cc-candybar/commit/b60ebc139b48709ec85c78114a1b898771c021db))

## [1.117.1](https://github.com/promptctl/cc-candybar/compare/v1.117.0...v1.117.1) (2026-10-08)


### Bug Fixes

* **render:** read a fragment's style through the render's theme on rich-js 0.19.0 ([#316](https://github.com/promptctl/cc-candybar/issues/316)) ([ec9e56d](https://github.com/promptctl/cc-candybar/commit/ec9e56dab1567780f93a4e4b48a5c090b568eda8))

# [1.117.0](https://github.com/promptctl/cc-candybar/compare/v1.116.1...v1.117.0) (2026-10-08)


### Features

* **segments:** show the lit ticket this session is working, its phase and epic progress ([#317](https://github.com/promptctl/cc-candybar/issues/317)) ([01bcfef](https://github.com/promptctl/cc-candybar/commit/01bcfefbb6575bcbe5cd599ea22d7e911cd049e4))

## [1.116.1](https://github.com/promptctl/cc-candybar/compare/v1.116.0...v1.116.1) (2026-10-04)


### Bug Fixes

* **config:** the style/endcaps rename leaves no stale surface ([#315](https://github.com/promptctl/cc-candybar/issues/315)) ([981f2c5](https://github.com/promptctl/cc-candybar/commit/981f2c525af514c0c196876fb70d896422a11a5d))

# [1.116.0](https://github.com/promptctl/cc-candybar/compare/v1.115.1...v1.116.0) (2026-10-04)


### Features

* **doctor:** the doctor checks that the URL handler works ([#314](https://github.com/promptctl/cc-candybar/issues/314)) ([c057dee](https://github.com/promptctl/cc-candybar/commit/c057deee82c8b43a0684f2b5f987fa84c3d1d70e))

## [1.115.1](https://github.com/promptctl/cc-candybar/compare/v1.115.0...v1.115.1) (2026-10-04)


### Bug Fixes

* **config:** a set on a setting key loads only with values that setting has ([#313](https://github.com/promptctl/cc-candybar/issues/313)) ([a59361b](https://github.com/promptctl/cc-candybar/commit/a59361b223a8a7f66b18a7af96438521a8d166cd))

# [1.115.0](https://github.com/promptctl/cc-candybar/compare/v1.114.1...v1.115.0) (2026-10-04)


### Bug Fixes

* **check:** render every preset, not only the one a fresh session opens in ([#312](https://github.com/promptctl/cc-candybar/issues/312)) ([e748c8e](https://github.com/promptctl/cc-candybar/commit/e748c8e972d8101683881c788df9ba924391aea8))


### Features

* **doctor:** the doctor checks that the config is correct ([#311](https://github.com/promptctl/cc-candybar/issues/311)) ([0eefcc6](https://github.com/promptctl/cc-candybar/commit/0eefcc611718e2e915deedb5ec824d441d787335))

## [1.114.1](https://github.com/promptctl/cc-candybar/compare/v1.114.0...v1.114.1) (2026-10-04)


### Bug Fixes

* **demo:** the config switcher loads the demo files beside the one loaded ([#310](https://github.com/promptctl/cc-candybar/issues/310)) ([220b522](https://github.com/promptctl/cc-candybar/commit/220b522edf1446f4c649dea7573d481b9d1b3207))

# [1.114.0](https://github.com/promptctl/cc-candybar/compare/v1.113.2...v1.114.0) (2026-10-04)


### Features

* **menu:** every option setting is ◀ value ▶, the value opening a plain list ([#308](https://github.com/promptctl/cc-candybar/issues/308)) ([c14bd8d](https://github.com/promptctl/cc-candybar/commit/c14bd8d9d60cf6d1f3a86453d7d3c0ccf990cbce))

## [1.113.2](https://github.com/promptctl/cc-candybar/compare/v1.113.1...v1.113.2) (2026-10-04)


### Bug Fixes

* **demo:** the demo's payload is the daemon's, built from a faked hook event ([#309](https://github.com/promptctl/cc-candybar/issues/309)) ([1fa6825](https://github.com/promptctl/cc-candybar/commit/1fa6825e266bfedb91dd847c16ec68bce33eb9ea))

## [1.113.1](https://github.com/promptctl/cc-candybar/compare/v1.113.0...v1.113.1) (2026-10-04)


### Bug Fixes

* **config:** a git variable takes no cache policy, and the loader refuses one ([#307](https://github.com/promptctl/cc-candybar/issues/307)) ([4e34bdf](https://github.com/promptctl/cc-candybar/commit/4e34bdf973ab3e3e1d2bebde0e253fff24157bda))

# [1.113.0](https://github.com/promptctl/cc-candybar/compare/v1.112.0...v1.113.0) (2026-10-04)


### Features

* **menu:** the session tab carries the autocompact control ([#306](https://github.com/promptctl/cc-candybar/issues/306)) ([1cf652f](https://github.com/promptctl/cc-candybar/commit/1cf652f874853237d71c86aaa39f97792adc2328))

# [1.112.0](https://github.com/promptctl/cc-candybar/compare/v1.111.0...v1.112.0) (2026-10-04)


### Bug Fixes

* **tmux:** the tmux payload is the session's client hint, and slash controls show only inside tmux ([#304](https://github.com/promptctl/cc-candybar/issues/304)) ([fe8f1d2](https://github.com/promptctl/cc-candybar/commit/fe8f1d282f615b9ac872b17cecb1eed0445b0dc6))


### Features

* **directory:** clicking the directory copies the full path ([#305](https://github.com/promptctl/cc-candybar/issues/305)) ([d139b14](https://github.com/promptctl/cc-candybar/commit/d139b1419fcc03da9621ba3c55148807f6140a3e))

# [1.111.0](https://github.com/promptctl/cc-candybar/compare/v1.110.0...v1.111.0) (2026-10-04)


### Features

* **theme:** the alt variation turns the hue every three cells along a row ([#303](https://github.com/promptctl/cc-candybar/issues/303)) ([c0e45ec](https://github.com/promptctl/cc-candybar/commit/c0e45ec0ab00d2b7b1e4594146d9d27188186a02))

# [1.110.0](https://github.com/promptctl/cc-candybar/compare/v1.109.1...v1.110.0) (2026-10-04)


### Features

* **menu:** mark every setting that differs from its default ([#302](https://github.com/promptctl/cc-candybar/issues/302)) ([edd43aa](https://github.com/promptctl/cc-candybar/commit/edd43aa794b88a07c794f7225613dfeaf6459d3c))

## [1.109.1](https://github.com/promptctl/cc-candybar/compare/v1.109.0...v1.109.1) (2026-10-04)


### Bug Fixes

* **daemon:** a session's click is gated and wrapped by the config it renders ([#301](https://github.com/promptctl/cc-candybar/issues/301)) ([46e5e39](https://github.com/promptctl/cc-candybar/commit/46e5e395fd3baf86dbc6a035b85c8cd34f7a946a))

# [1.109.0](https://github.com/promptctl/cc-candybar/compare/v1.108.1...v1.109.0) (2026-10-04)


### Features

* **menu:** the session tab gains ⎘ resume and ↗ config ([#300](https://github.com/promptctl/cc-candybar/issues/300)) ([c686759](https://github.com/promptctl/cc-candybar/commit/c686759f8fd34e6230c22dcfc102b9fcd7e12c26))

## [1.108.1](https://github.com/promptctl/cc-candybar/compare/v1.108.0...v1.108.1) (2026-10-04)


### Bug Fixes

* **daemon:** memento and the today seed read the session's Claude Code, not the daemon's env ([#299](https://github.com/promptctl/cc-candybar/issues/299)) ([65ea906](https://github.com/promptctl/cc-candybar/commit/65ea9060c93efdeb26f00a02889d84621a2b01eb))

# [1.108.0](https://github.com/promptctl/cc-candybar/compare/v1.107.0...v1.108.0) (2026-10-04)


### Features

* **menu:** charset and colour depth leave the settings menu ([#298](https://github.com/promptctl/cc-candybar/issues/298)) ([57c9603](https://github.com/promptctl/cc-candybar/commit/57c96030a8d29695756f562454bd43ea300f772e))

# [1.107.0](https://github.com/promptctl/cc-candybar/compare/v1.106.0...v1.107.0) (2026-10-04)


### Features

* **site:** the live bar on GitHub Pages, replaying Claude turns ([#297](https://github.com/promptctl/cc-candybar/issues/297)) ([490d129](https://github.com/promptctl/cc-candybar/commit/490d12913e678a1c678ee589c06aebe8f8fca5d6))

# [1.106.0](https://github.com/promptctl/cc-candybar/compare/v1.105.1...v1.106.0) (2026-10-04)


### Features

* **bar:** pnpm bar:web, the live bar in a browser terminal you can click ([#296](https://github.com/promptctl/cc-candybar/issues/296)) ([c479bb3](https://github.com/promptctl/cc-candybar/commit/c479bb3629c24ba8e770f464879fbec33b0fc885))

## [1.105.1](https://github.com/promptctl/cc-candybar/compare/v1.105.0...v1.105.1) (2026-10-03)


### Bug Fixes

* **daemon:** durable config clicks draw in the next render; UI elements inventory and pnpm bar harness ([#295](https://github.com/promptctl/cc-candybar/issues/295)) ([ab34725](https://github.com/promptctl/cc-candybar/commit/ab34725bf3e1338e64739b9d6c2df5e4bf9da8a0)), closes [#287](https://github.com/promptctl/cc-candybar/issues/287)

# [1.105.0](https://github.com/promptctl/cc-candybar/compare/v1.104.0...v1.105.0) (2026-10-03)


### Features

* **menu:** the door rises with its menu, ◁ back beside it; closes wear theme colours; arranging keeps the menu open ([#294](https://github.com/promptctl/cc-candybar/issues/294)) ([618b1f3](https://github.com/promptctl/cc-candybar/commit/618b1f34fce52ce5b7c9f6fff6e5b392456faa9b))

# [1.104.0](https://github.com/promptctl/cc-candybar/compare/v1.103.0...v1.104.0) (2026-10-03)


### Features

* **edit:** the add menu is a segment library ([#293](https://github.com/promptctl/cc-candybar/issues/293)) ([02889d5](https://github.com/promptctl/cc-candybar/commit/02889d52036f9887e135290fc7053cb8f74df7c5))

# [1.103.0](https://github.com/promptctl/cc-candybar/compare/v1.102.0...v1.103.0) (2026-10-03)


### Features

* **edit:** save and cancel for edit mode ([#292](https://github.com/promptctl/cc-candybar/issues/292)) ([a7307bc](https://github.com/promptctl/cc-candybar/commit/a7307bc55e6e1d5124b362320df525614db482be))

# [1.102.0](https://github.com/promptctl/cc-candybar/compare/v1.101.0...v1.102.0) (2026-10-03)


### Features

* **edit:** ⊖ removes in red, ⊕ adds in green on no fill ([#290](https://github.com/promptctl/cc-candybar/issues/290)) ([e83b63f](https://github.com/promptctl/cc-candybar/commit/e83b63f7b63759509fb3d9bba316bfc5f4ea06b2))

# [1.101.0](https://github.com/promptctl/cc-candybar/compare/v1.100.1...v1.101.0) (2026-10-03)


### Features

* **menu:** ◁ back, configure nested in arrange, door folds its body ([#289](https://github.com/promptctl/cc-candybar/issues/289)) ([d373675](https://github.com/promptctl/cc-candybar/commit/d373675c0b456edd923fce0ef56351db48efb0b8))

## [1.100.1](https://github.com/promptctl/cc-candybar/compare/v1.100.0...v1.100.1) (2026-10-03)


### Bug Fixes

* **edit:** lead each placement with a red ✖ and trail it with ⚙️ ([#288](https://github.com/promptctl/cc-candybar/issues/288)) ([aefb0ae](https://github.com/promptctl/cc-candybar/commit/aefb0aef061d20ff01e55981772cb550db19eb55))

# [1.100.0](https://github.com/promptctl/cc-candybar/compare/v1.99.0...v1.100.0) (2026-10-02)


### Features

* **menu:** the settings menu's second line is five tabs, one open at a time ([#286](https://github.com/promptctl/cc-candybar/issues/286)) ([f3e54db](https://github.com/promptctl/cc-candybar/commit/f3e54db074623b9346344eba8f168e862da1c088))

# [1.99.0](https://github.com/promptctl/cc-candybar/compare/v1.98.1...v1.99.0) (2026-09-30)


### Features

* **menu:** rename look → style, progression → variation, style → endcaps ([#285](https://github.com/promptctl/cc-candybar/issues/285)) ([8b10611](https://github.com/promptctl/cc-candybar/commit/8b1061186ad459bd4e73909f2c73a4cc540b6b7e))

## [1.98.1](https://github.com/promptctl/cc-candybar/compare/v1.98.0...v1.98.1) (2026-09-30)


### Bug Fixes

* **config:** a persist click under a preset that pins its field lands in that preset's globals ([#284](https://github.com/promptctl/cc-candybar/issues/284)) ([5e3367c](https://github.com/promptctl/cc-candybar/commit/5e3367c2f386dc4303f301b9d5feae24ddb46154))

# [1.98.0](https://github.com/promptctl/cc-candybar/compare/v1.97.4...v1.98.0) (2026-09-30)


### Features

* **menu:** the settings menu opens above the bar, as two door lines ([#283](https://github.com/promptctl/cc-candybar/issues/283)) ([21b2b79](https://github.com/promptctl/cc-candybar/commit/21b2b79dac511a289304b3764d485a11c9c93b7c))

## [1.97.4](https://github.com/promptctl/cc-candybar/compare/v1.97.3...v1.97.4) (2026-09-30)


### Bug Fixes

* **themes:** a rule inside a preset's globals is compiled, not a render throw ([#282](https://github.com/promptctl/cc-candybar/issues/282)) ([4f0598c](https://github.com/promptctl/cc-candybar/commit/4f0598c5b61753cf7e334a59476d21526add107a))

## [1.97.3](https://github.com/promptctl/cc-candybar/compare/v1.97.2...v1.97.3) (2026-09-30)


### Bug Fixes

* **config:** action, picker and carousel refs inside a helper are checked at load ([#280](https://github.com/promptctl/cc-candybar/issues/280)) ([2998479](https://github.com/promptctl/cc-candybar/commit/2998479b69d4f1ac56be4cd1dd9973debb7f919f))

## [1.97.2](https://github.com/promptctl/cc-candybar/compare/v1.97.1...v1.97.2) (2026-09-29)


### Bug Fixes

* **themes:** one name per palette — delete the dark/light aliases ([#279](https://github.com/promptctl/cc-candybar/issues/279)) ([52c44fc](https://github.com/promptctl/cc-candybar/commit/52c44fcbe28e45f83cfd27ca8427d4ff4dd8e5c0))

## [1.97.1](https://github.com/promptctl/cc-candybar/compare/v1.97.0...v1.97.1) (2026-09-29)


### Bug Fixes

* **deps:** go-template-js 0.10.0 + rich-js 0.18.1 — int gates refuse fractionals ([#277](https://github.com/promptctl/cc-candybar/issues/277)) ([aba746d](https://github.com/promptctl/cc-candybar/commit/aba746d07a90e16c9e8c81228f305f7fc6b07269))

# [1.97.0](https://github.com/promptctl/cc-candybar/compare/v1.96.1...v1.97.0) (2026-09-29)


### Features

* **settings:** menu controls are generated from the globals declarations ([#276](https://github.com/promptctl/cc-candybar/issues/276)) ([2cfebe6](https://github.com/promptctl/cc-candybar/commit/2cfebe6279fc668e1775bd8ce83c3f96bfcdc297))

## [1.96.1](https://github.com/promptctl/cc-candybar/compare/v1.96.0...v1.96.1) (2026-09-29)


### Bug Fixes

* **config:** refuse globals.default_bg/default_fg with a migration pointer ([#274](https://github.com/promptctl/cc-candybar/issues/274)) ([d065c08](https://github.com/promptctl/cc-candybar/commit/d065c088848558ec61a32274af69ece2ec3d1f7e))

# [1.96.0](https://github.com/promptctl/cc-candybar/compare/v1.95.0...v1.96.0) (2026-09-29)


### Bug Fixes

* **sources:** shell sources run in the session's working directory ([#273](https://github.com/promptctl/cc-candybar/issues/273)) ([7d28211](https://github.com/promptctl/cc-candybar/commit/7d28211f4f6b35c5d164a9fb30524dc5d751e7a4))
* **test:** threshold-settings registers its config with a cwd ([#275](https://github.com/promptctl/cc-candybar/issues/275)) ([de314b1](https://github.com/promptctl/cc-candybar/commit/de314b15c08a554a715a2fc06b949bb934c688f8)), closes [#273](https://github.com/promptctl/cc-candybar/issues/273) [#272](https://github.com/promptctl/cc-candybar/issues/272)


### Features

* **segments:** bundled thresholds and budgets are per-placement settings ([#272](https://github.com/promptctl/cc-candybar/issues/272)) ([2564232](https://github.com/promptctl/cc-candybar/commit/2564232300deab99b2553416bf38b2a24ccc81e6))

# [1.95.0](https://github.com/promptctl/cc-candybar/compare/v1.94.0...v1.95.0) (2026-09-29)


### Features

* **segments:** /compact, /model and /clear buttons, one click from the bar ([#271](https://github.com/promptctl/cc-candybar/issues/271)) ([7d8d7d6](https://github.com/promptctl/cc-candybar/commit/7d8d7d6c8c3ad9098d59c4bc11c15284ba23e770))

# [1.94.0](https://github.com/promptctl/cc-candybar/compare/v1.93.0...v1.94.0) (2026-09-29)


### Features

* **segments:** each gitaculous copy chooses which optional facts it shows ([#270](https://github.com/promptctl/cc-candybar/issues/270)) ([70a84b1](https://github.com/promptctl/cc-candybar/commit/70a84b1c6b71d7dbe0918b1f059fbc9267069d3f))

# [1.93.0](https://github.com/promptctl/cc-candybar/compare/v1.92.0...v1.93.0) (2026-09-29)


### Features

* **segments:** the auto-compact window beside the ceiling, set from the bar ([#268](https://github.com/promptctl/cc-candybar/issues/268)) ([5471f2f](https://github.com/promptctl/cc-candybar/commit/5471f2f89f2492cc656e771c0962e98d3b12ecaa)), closes [#269](https://github.com/promptctl/cc-candybar/issues/269)

# [1.92.0](https://github.com/promptctl/cc-candybar/compare/v1.91.0...v1.92.0) (2026-09-29)


### Features

* **segments:** theme is a setting every placement has ([#269](https://github.com/promptctl/cc-candybar/issues/269)) ([4f88738](https://github.com/promptctl/cc-candybar/commit/4f8873883ca548936ba5a88f713ca2cd6dd4fb63))

# [1.91.0](https://github.com/promptctl/cc-candybar/compare/v1.90.0...v1.91.0) (2026-09-29)


### Features

* **actions:** a slash action types a declared command into this Claude Code session ([#267](https://github.com/promptctl/cc-candybar/issues/267)) ([601e3fe](https://github.com/promptctl/cc-candybar/commit/601e3fe83aed67e3da077844be4ee00fcf4d2e59))
* **segments:** configure one placement's settings from the bar ([#266](https://github.com/promptctl/cc-candybar/issues/266)) ([0147b73](https://github.com/promptctl/cc-candybar/commit/0147b73e4e9a5798a50d5c7682e12b265f10bcef))

# [1.90.0](https://github.com/promptctl/cc-candybar/compare/v1.89.0...v1.90.0) (2026-09-29)


### Features

* **segments:** the memento context ceiling beside context use, moved from the bar ([#265](https://github.com/promptctl/cc-candybar/issues/265)) ([46d4269](https://github.com/promptctl/cc-candybar/commit/46d4269c168d44d0b57638de35d8645f4c03a3b0))

# [1.89.0](https://github.com/promptctl/cc-candybar/compare/v1.88.0...v1.89.0) (2026-09-29)


### Features

* **segments:** each placement has an id and its own settings ([#263](https://github.com/promptctl/cc-candybar/issues/263)) ([c46eb9e](https://github.com/promptctl/cc-candybar/commit/c46eb9ec851c9b117f6b03dcb5f8527a2010176b))

# [1.88.0](https://github.com/promptctl/cc-candybar/compare/v1.87.1...v1.88.0) (2026-09-29)


### Features

* **presets:** zen, git, usage and dense — a bundled preset for each way of working ([#264](https://github.com/promptctl/cc-candybar/issues/264)) ([fcca300](https://github.com/promptctl/cc-candybar/commit/fcca300368c6f251f127b43649afc9145935b786))

## [1.87.1](https://github.com/promptctl/cc-candybar/compare/v1.87.0...v1.87.1) (2026-09-29)


### Bug Fixes

* **settings:** an unpicked padding steps from the value the session's preset shows ([#262](https://github.com/promptctl/cc-candybar/issues/262)) ([1209e13](https://github.com/promptctl/cc-candybar/commit/1209e137625cb7815b432c1302dee148775be58f))

# [1.87.0](https://github.com/promptctl/cc-candybar/compare/v1.86.0...v1.87.0) (2026-09-29)


### Features

* **settings:** save the bar as a new preset, and delete a preset you made ([#261](https://github.com/promptctl/cc-candybar/issues/261)) ([58bb446](https://github.com/promptctl/cc-candybar/commit/58bb4466a0e0d74482ff4d287933b100668fb161))

# [1.86.0](https://github.com/promptctl/cc-candybar/compare/v1.85.0...v1.86.0) (2026-09-29)


### Features

* **git-segment:** gitaculous collapses to a summary, and an arrow at its right edge expands it ([#259](https://github.com/promptctl/cc-candybar/issues/259)) ([10434ea](https://github.com/promptctl/cc-candybar/commit/10434ead7943ca425a645a05d5b67aa2a2828ac4)), closes [#258](https://github.com/promptctl/cc-candybar/issues/258)
* **settings:** reset per setting and reset all return to the bundled default, each one undo step ([#258](https://github.com/promptctl/cc-candybar/issues/258)) ([1e9404e](https://github.com/promptctl/cc-candybar/commit/1e9404edaacf98b9e43994dad4dcd838be0ad904))

# [1.85.0](https://github.com/promptctl/cc-candybar/compare/v1.84.0...v1.85.0) (2026-09-29)


### Features

* **git-segment:** the git segments are assembled from named pieces a user overrides one at a time ([#257](https://github.com/promptctl/cc-candybar/issues/257)) ([af894b4](https://github.com/promptctl/cc-candybar/commit/af894b494c03b824de41086a77d7dcedb0c61963))

# [1.84.0](https://github.com/promptctl/cc-candybar/compare/v1.83.2...v1.84.0) (2026-09-29)


### Features

* **settings:** a Save button replaces the persist? checkbox ([#256](https://github.com/promptctl/cc-candybar/issues/256)) ([efc3667](https://github.com/promptctl/cc-candybar/commit/efc3667077fc8b3fba724b79281779fc0a0b7181))

## [1.83.2](https://github.com/promptctl/cc-candybar/compare/v1.83.1...v1.83.2) (2026-09-29)


### Bug Fixes

* **settings-menu:** when errors name the authored row; synthesis reads derive from the trees each pass returns ([#255](https://github.com/promptctl/cc-candybar/issues/255)) ([559c128](https://github.com/promptctl/cc-candybar/commit/559c12889002d72ee0c494af1605e5059a8d578e))

## [1.83.1](https://github.com/promptctl/cc-candybar/compare/v1.83.0...v1.83.1) (2026-09-29)


### Bug Fixes

* **settings-menu:** the menu appears in every config, ensuring the inputs it reads ([#253](https://github.com/promptctl/cc-candybar/issues/253)) ([9d20fa6](https://github.com/promptctl/cc-candybar/commit/9d20fa6e8951905dbe34cf1b56d0470dc68dc4a5))

# [1.83.0](https://github.com/promptctl/cc-candybar/compare/v1.82.0...v1.83.0) (2026-09-29)


### Features

* **settings:** one undo history for every settings change, with undo/redo in the menu ([#252](https://github.com/promptctl/cc-candybar/issues/252)) ([4b5fb16](https://github.com/promptctl/cc-candybar/commit/4b5fb16548f0c821cb25c3e915d3c16f3c78e6ca))

# [1.82.0](https://github.com/promptctl/cc-candybar/compare/v1.81.1...v1.82.0) (2026-09-29)


### Features

* **edit:** a visible way out of edit mode, and add/remove buttons that read as what they do ([#251](https://github.com/promptctl/cc-candybar/issues/251)) ([29fbfd4](https://github.com/promptctl/cc-candybar/commit/29fbfd4bbcccb7abf9a103edc26b0d37331c4794))

## [1.81.1](https://github.com/promptctl/cc-candybar/compare/v1.81.0...v1.81.1) (2026-09-29)


### Bug Fixes

* **menu:** a {{ menu }}'s dropped body survives any style wrapper ([#249](https://github.com/promptctl/cc-candybar/issues/249)) ([4e147f3](https://github.com/promptctl/cc-candybar/commit/4e147f3d78d71cf57a964422bdbe3e16ac4a44a8))

# [1.81.0](https://github.com/promptctl/cc-candybar/compare/v1.80.0...v1.81.0) (2026-09-28)


### Features

* **themes:** choose which theme role each bar row wears ([#247](https://github.com/promptctl/cc-candybar/issues/247)) ([99f3a3d](https://github.com/promptctl/cc-candybar/commit/99f3a3db82c316ff1d1f5d12cf29104734c5d575))

# [1.80.0](https://github.com/promptctl/cc-candybar/compare/v1.79.1...v1.80.0) (2026-09-27)


### Features

* **edit:** edit mode shows each segment by name, with a live toggle ([#246](https://github.com/promptctl/cc-candybar/issues/246)) ([c3ceec7](https://github.com/promptctl/cc-candybar/commit/c3ceec70b7fec476d537eba74eca0e8226e08e82))

## [1.79.1](https://github.com/promptctl/cc-candybar/compare/v1.79.0...v1.79.1) (2026-09-27)


### Bug Fixes

* **render:** colour depth none keeps every link, so the bar can undo it ([#245](https://github.com/promptctl/cc-candybar/issues/245)) ([6d34a14](https://github.com/promptctl/cc-candybar/commit/6d34a149b9c30dd3ec3f50074487a1e3be2f64c3))

# [1.79.0](https://github.com/promptctl/cc-candybar/compare/v1.78.0...v1.79.0) (2026-09-27)


### Features

* **strip:** every powerline row opens with a lead cap ([#244](https://github.com/promptctl/cc-candybar/issues/244)) ([181e8a4](https://github.com/promptctl/cc-candybar/commit/181e8a41bce723b89b8d7725996ede7a7639bd62))

# [1.78.0](https://github.com/promptctl/cc-candybar/compare/v1.77.0...v1.78.0) (2026-09-26)


### Features

* **themes:** themeSwitcher segment steps through themes on the bar ([#243](https://github.com/promptctl/cc-candybar/issues/243)) ([c452816](https://github.com/promptctl/cc-candybar/commit/c45281643e9aef19acbee4d8b22a6cad75ae38f1))

# [1.77.0](https://github.com/promptctl/cc-candybar/compare/v1.76.0...v1.77.0) (2026-09-25)


### Features

* **settings:** charset and colour depth move from the bar into the settings menu ([#242](https://github.com/promptctl/cc-candybar/issues/242)) ([64a8234](https://github.com/promptctl/cc-candybar/commit/64a8234295503c66214264a8e543c0efa6871524))

# [1.76.0](https://github.com/promptctl/cc-candybar/compare/v1.75.0...v1.76.0) (2026-09-25)


### Bug Fixes

* **themes:** state, band and seam floors hold on the colours drawn at 256 and ansi ([#241](https://github.com/promptctl/cc-candybar/issues/241)) ([42caf67](https://github.com/promptctl/cc-candybar/commit/42caf67c0724b20248094af8c6d503e700e529e7))


### Features

* **settings:** preset carousel with the layout drawn beneath it ([#240](https://github.com/promptctl/cc-candybar/issues/240)) ([0a6f75c](https://github.com/promptctl/cc-candybar/commit/0a6f75c66040985810524fc9d3bcd61132b9991e))

# [1.75.0](https://github.com/promptctl/cc-candybar/compare/v1.74.5...v1.75.0) (2026-09-24)


### Features

* **settings:** theme carousel — arrows rotate by applying, a palette preview beneath ([#239](https://github.com/promptctl/cc-candybar/issues/239)) ([77d4580](https://github.com/promptctl/cc-candybar/commit/77d4580de17cec6a08c9fc6ae359e07d61e9fac1))

## [1.74.5](https://github.com/promptctl/cc-candybar/compare/v1.74.4...v1.74.5) (2026-09-24)


### Bug Fixes

* **themes:** text floors hold at 256 colours ([#238](https://github.com/promptctl/cc-candybar/issues/238)) ([8520ee9](https://github.com/promptctl/cc-candybar/commit/8520ee9c322539acd1e4566a2c41e07a74e53d54))

## [1.74.4](https://github.com/promptctl/cc-candybar/compare/v1.74.3...v1.74.4) (2026-09-24)


### Bug Fixes

* **themes:** decoration follows Textual's colour roles — a row is one hue, its cells differ by tone ([#237](https://github.com/promptctl/cc-candybar/issues/237)) ([768485c](https://github.com/promptctl/cc-candybar/commit/768485ceffb03e89a64d73f42112b7ec53a47871))

## [1.74.3](https://github.com/promptctl/cc-candybar/compare/v1.74.2...v1.74.3) (2026-09-24)


### Bug Fixes

* **themes:** every theme's bar carries its own accents; neighbours never blur ([#236](https://github.com/promptctl/cc-candybar/issues/236)) ([6673b67](https://github.com/promptctl/cc-candybar/commit/6673b67e978e1af0cc4ce52b15d6254f4a23468b))

## [1.74.2](https://github.com/promptctl/cc-candybar/compare/v1.74.1...v1.74.2) (2026-09-24)


### Bug Fixes

* **themes:** legible text on every theme; a gallery to see them all ([#235](https://github.com/promptctl/cc-candybar/issues/235)) ([3bd6484](https://github.com/promptctl/cc-candybar/commit/3bd6484fa0cb11f7c939e8bb4b087537d93f43e3))

## [1.74.1](https://github.com/promptctl/cc-candybar/compare/v1.74.0...v1.74.1) (2026-09-24)


### Bug Fixes

* **settings-menu:** a pick leaves its picker open ([#234](https://github.com/promptctl/cc-candybar/issues/234)) ([0de9efc](https://github.com/promptctl/cc-candybar/commit/0de9efcf8ce33be6bd04477171d97cc460683465))

# [1.74.0](https://github.com/promptctl/cc-candybar/compare/v1.73.0...v1.74.0) (2026-09-23)


### Features

* **actions:** `do` fires several actions in one click; ✎ edit closes the settings menu ([#233](https://github.com/promptctl/cc-candybar/issues/233)) ([39beaf4](https://github.com/promptctl/cc-candybar/commit/39beaf4946324f6ea6e606d891d27e4ea2e302fe))

# [1.73.0](https://github.com/promptctl/cc-candybar/compare/v1.72.0...v1.73.0) (2026-09-23)


### Features

* **settings-menu:** visible under every condition, opens inline with ❌ ([#231](https://github.com/promptctl/cc-candybar/issues/231)) ([43b9b30](https://github.com/promptctl/cc-candybar/commit/43b9b30b1c20494d86678673ae1d33ea678f3338))

# [1.72.0](https://github.com/promptctl/cc-candybar/compare/v1.71.1...v1.72.0) (2026-09-23)


### Features

* **disclosure:** every row of an open disclosure body leads with a ✕ that closes it ([#229](https://github.com/promptctl/cc-candybar/issues/229)) ([a7a92e2](https://github.com/promptctl/cc-candybar/commit/a7a92e27e22af7397925e3d3b2d05ca52c5968cc))

## [1.71.1](https://github.com/promptctl/cc-candybar/compare/v1.71.0...v1.71.1) (2026-09-12)


### Bug Fixes

* **check:** a globals slot is not a segment, so `check` stops calling it one ([a3277a7](https://github.com/promptctl/cc-candybar/commit/a3277a70b28cf23f473ca2c9d21aa7ee85895e6b))

# [1.71.0](https://github.com/promptctl/cc-candybar/compare/v1.70.0...v1.71.0) (2026-09-12)


### Features

* **themes:** a theme may be chosen by data, not only by name (brandon-themes-dzl) ([60ea80c](https://github.com/promptctl/cc-candybar/commit/60ea80c53d26603f363e951b00406b0e78e9f9c1))

# [1.70.0](https://github.com/promptctl/cc-candybar/compare/v1.69.0...v1.70.0) (2026-09-12)


### Features

* **picker:** an option over a colour-valued domain is painted in what picking it would apply (brandon-picker-31z) ([b986706](https://github.com/promptctl/cc-candybar/commit/b98670678570444c93fd94c033d46691546a89cf))

# [1.69.0](https://github.com/promptctl/cc-candybar/compare/v1.68.0...v1.69.0) (2026-09-12)


### Features

* **activity:** the payload says what Claude is doing, not only how much (brandon-activity-ue7) ([4106e11](https://github.com/promptctl/cc-candybar/commit/4106e112e7f5d323104b23f70e0231706e740e2b))

# [1.68.0](https://github.com/promptctl/cc-candybar/compare/v1.67.0...v1.68.0) (2026-09-12)


### Features

* **looks:** a look can be chosen by data, not only by a name (brandon-looks-pe6) ([d806096](https://github.com/promptctl/cc-candybar/commit/d806096b4ef6f2a0b5f6b29475f26db1c7f7abc5))

# [1.67.0](https://github.com/promptctl/cc-candybar/compare/v1.66.0...v1.67.0) (2026-09-12)


### Features

* **template-funcs:** a threshold cascade whose result is text (brandon-template-funcs-jku) ([0792930](https://github.com/promptctl/cc-candybar/commit/079293062dd7616f361b0f16d5d761bb91c40a76))

# [1.66.0](https://github.com/promptctl/cc-candybar/compare/v1.65.0...v1.66.0) (2026-09-12)


### Features

* **template-funcs:** a gauge draws one value against a fixed maximum, cell by cell (brandon-template-funcs-zv5) ([fab6060](https://github.com/promptctl/cc-candybar/commit/fab60600d3581630c3b89210667c2dc1def96bd4))

# [1.65.0](https://github.com/promptctl/cc-candybar/compare/v1.64.1...v1.65.0) (2026-09-12)


### Features

* **layout:** a segment can take the row's leftover width (brandon-layout-0c2) ([813b2ed](https://github.com/promptctl/cc-candybar/commit/813b2ed9c98e94e911730b171d7118c5954efdbd))

## [1.64.1](https://github.com/promptctl/cc-candybar/compare/v1.64.0...v1.64.1) (2026-09-12)


### Bug Fixes

* **var-system:** one answer to "did this document change", and an age that means it (brandon-var-system-1tl) ([efa991f](https://github.com/promptctl/cc-candybar/commit/efa991f9dafb5f137d067bc96307f248bf17ebab))

# [1.64.0](https://github.com/promptctl/cc-candybar/compare/v1.63.0...v1.64.0) (2026-09-12)


### Features

* **limits:** a breach records where the memory actually was, not just the heap half (brandon-daemon-limits-inw) ([e4727ca](https://github.com/promptctl/cc-candybar/commit/e4727ca0f293752dae28c01c6d60d699c0259d1f))

# [1.63.0](https://github.com/promptctl/cc-candybar/compare/v1.62.1...v1.63.0) (2026-09-12)


### Features

* **config:** a segment says what it shows, and the schema and `segments` carry it (brandon-config-schema-qqg) ([073d474](https://github.com/promptctl/cc-candybar/commit/073d4749aa5fbd2f240bcd042300d4d528f2e096))

## [1.62.1](https://github.com/promptctl/cc-candybar/compare/v1.62.0...v1.62.1) (2026-09-12)


### Bug Fixes

* **release:** wait for the registry to serve the platform packages, not for a lockfile retry budget (brandon-release-j08) ([9572183](https://github.com/promptctl/cc-candybar/commit/95721838404876910a7dcd3ae572b8245e3786ad))

# [1.62.0](https://github.com/promptctl/cc-candybar/compare/v1.61.6...v1.62.0) (2026-09-12)


### Features

* **check:** `--render` prints the bar check already computed (brandon-check-m2a) ([8f31f3e](https://github.com/promptctl/cc-candybar/commit/8f31f3e04e80e350593c3542b5293de02247ce25))


### Performance Improvements

* **git:** cache the commit timestamp by commit, so `git log -1` fires once per commit (brandon-git-cache-y9h) ([53c1e17](https://github.com/promptctl/cc-candybar/commit/53c1e178b0326825889775f6579caf69bd0acbe1))
* **git:** count stashes from the refs/stash reflog instead of spawning git (brandon-git-cache-y9h) ([3fffadd](https://github.com/promptctl/cc-candybar/commit/3fffadddc7f3f00439e2f9a90b9e6e1b145850e4))
* **git:** find the repo root by filesystem ascent instead of spawning git (brandon-git-cache-y9h) ([8d438b1](https://github.com/promptctl/cc-candybar/commit/8d438b1c8ae317558a8fbc843357add62513e45c))
* **git:** memoise the remotes read against the config file, closing the four-spawn miss (brandon-git-cache-y9h) ([fcb2b7a](https://github.com/promptctl/cc-candybar/commit/fcb2b7a16f0061503324fdd98dce2ef07298ab52))

## [1.61.6](https://github.com/promptctl/cc-candybar/compare/v1.61.5...v1.61.6) (2026-09-12)


### Bug Fixes

* **config:** a reserved accordion key is a load error, compared after ident collapse (brandon-menus-du8) ([9c0760f](https://github.com/promptctl/cc-candybar/commit/9c0760f71b82da768d06f0c3f7cd5839831aae94))

## [1.61.5](https://github.com/promptctl/cc-candybar/compare/v1.61.4...v1.61.5) (2026-09-12)


### Bug Fixes

* **daemon:** cache the gitDir resolution so a non-repo cwd stops spawning git (brandon-git-cache-y2t) ([b1dbbb9](https://github.com/promptctl/cc-candybar/commit/b1dbbb93e20c0df72179545ab16dee98bfee8bca))

## [1.61.4](https://github.com/promptctl/cc-candybar/compare/v1.61.3...v1.61.4) (2026-09-12)


### Bug Fixes

* **config:** unknown keys on a variable declaration are rejected (brandon-config-9li) ([17e3d48](https://github.com/promptctl/cc-candybar/commit/17e3d48904708050f0b62dc842bf13aed0c564ac))

## [1.61.3](https://github.com/promptctl/cc-candybar/compare/v1.61.2...v1.61.3) (2026-09-12)


### Bug Fixes

* **var-system:** a template variable that fails reads as the failure (brandon-var-sources-1p6) ([9f33c6b](https://github.com/promptctl/cc-candybar/commit/9f33c6b934858c98de78e31bdf2bf6a7e18b7786))

## [1.61.2](https://github.com/promptctl/cc-candybar/compare/v1.61.1...v1.61.2) (2026-09-12)


### Bug Fixes

* **var-system:** a re-trigger during a read re-reads instead of being dropped (brandon-var-sources-tex) ([bfd46dd](https://github.com/promptctl/cc-candybar/commit/bfd46dd457569497c1bbd8404334aecb09c19cd0))

## [1.61.1](https://github.com/promptctl/cc-candybar/compare/v1.61.0...v1.61.1) (2026-09-12)


### Bug Fixes

* **check:** settled() waits for a git subscription's first delivery (brandon-check-settle-dt7) ([71b692b](https://github.com/promptctl/cc-candybar/commit/71b692b850fdfb80b2854f71c0da9c1315c58506))

# [1.61.0](https://github.com/promptctl/cc-candybar/compare/v1.60.0...v1.61.0) (2026-09-08)


### Features

* **config:** a duplicate object key warns at load, named by file and line (brandon-config-16g) ([#227](https://github.com/promptctl/cc-candybar/issues/227)) ([e7f0e12](https://github.com/promptctl/cc-candybar/commit/e7f0e12618c002c3850f1218fcc73249072377a7))

# [1.60.0](https://github.com/promptctl/cc-candybar/compare/v1.59.0...v1.60.0) (2026-09-08)


### Features

* **config:** segments and presets merge by name then by field — a first durable write lands one field (brandon-config-ph5) ([#225](https://github.com/promptctl/cc-candybar/issues/225)) ([3aca17b](https://github.com/promptctl/cc-candybar/commit/3aca17bef2a28388653492dd542b43708694fb21))

# [1.59.0](https://github.com/promptctl/cc-candybar/compare/v1.58.0...v1.59.0) (2026-09-08)


### Features

* **settings:** the global menu leads the bar, as one symbol in accent ([#224](https://github.com/promptctl/cc-candybar/issues/224)) ([dbdeb52](https://github.com/promptctl/cc-candybar/commit/dbdeb5229cd38dc7bc3e6a45a626a389b0bca19f))

# [1.58.0](https://github.com/promptctl/cc-candybar/compare/v1.57.0...v1.58.0) (2026-09-06)


### Features

* **color:** block/weekly/burnrate thresholds are one ramp call each — colour ramp primitive (brandon-custom-segments-g5z.2) ([#222](https://github.com/promptctl/cc-candybar/issues/222)) ([a9a8905](https://github.com/promptctl/cc-candybar/commit/a9a8905b5a30c7987c466db2ad15c7cec90aa253))

# [1.57.0](https://github.com/promptctl/cc-candybar/compare/v1.56.2...v1.57.0) (2026-09-06)


### Features

* **var-system:** shell/file sources parse once — parse: { regex } | { json } seam, documents read by dotted path (brandon-custom-segments-g5z.1) ([#221](https://github.com/promptctl/cc-candybar/issues/221)) ([8931484](https://github.com/promptctl/cc-candybar/commit/8931484115e4307a7b3aa11c64376436d227a32c))

## [1.56.2](https://github.com/promptctl/cc-candybar/compare/v1.56.1...v1.56.2) (2026-09-05)


### Bug Fixes

* **plugin:** rebuild the setup wizard on the current config model (brandon-plugin-templates-irq) ([#219](https://github.com/promptctl/cc-candybar/issues/219)) ([281f368](https://github.com/promptctl/cc-candybar/commit/281f3685bf9e8ff1f82aaeab5b15834f852a7c79))

## [1.56.1](https://github.com/promptctl/cc-candybar/compare/v1.56.0...v1.56.1) (2026-09-05)


### Bug Fixes

* **config:** CC_CANDYBAR_CONFIG is a client hint; a missing explicit config is loud (brandon-config-5g8) ([#218](https://github.com/promptctl/cc-candybar/issues/218)) ([b07df7f](https://github.com/promptctl/cc-candybar/commit/b07df7f84a3e7e3b2598339717be22d739326054))

# [1.56.0](https://github.com/promptctl/cc-candybar/compare/v1.55.0...v1.56.0) (2026-09-05)


### Features

* **doctor:** settings menu 🧰 tools › 🩺 doctor; first check repairs Claude Code's 256-colour downgrade in tmux (brandon-doctor-b6a) ([#216](https://github.com/promptctl/cc-candybar/issues/216)) ([c79fd80](https://github.com/promptctl/cc-candybar/commit/c79fd80ae82c341960b83c126a904a4aeb2f1aa7))

# [1.55.0](https://github.com/promptctl/cc-candybar/compare/v1.54.0...v1.55.0) (2026-09-05)


### Features

* **render:** a disclosure body is a node fact; depth reaches the walk (candybar-render-ai7.9) ([#215](https://github.com/promptctl/cc-candybar/issues/215)) ([e22ac57](https://github.com/promptctl/cc-candybar/commit/e22ac576bf62a4d4437b109090b2135543901b67)), closes [#e0e0e0](https://github.com/promptctl/cc-candybar/issues/e0e0e0)

# [1.54.0](https://github.com/promptctl/cc-candybar/compare/v1.53.0...v1.54.0) (2026-09-05)


### Features

* **config:** author the placement distribution per placer (candybar-render-ai7.8) ([#214](https://github.com/promptctl/cc-candybar/issues/214)) ([fd59660](https://github.com/promptctl/cc-candybar/commit/fd59660abc5a02eb4889856108c95a34994f57c7))

# [1.53.0](https://github.com/promptctl/cc-candybar/compare/v1.52.0...v1.53.0) (2026-09-05)


### Features

* **config:** author no decorative `bg:` — the vocabulary tint is every cell's floor (candybar-render-ai7.5) ([#212](https://github.com/promptctl/cc-candybar/issues/212)) ([6867eb6](https://github.com/promptctl/cc-candybar/commit/6867eb62fbe5b894277f53dd761b2b8a36ce1464)), closes [#1e1e1e](https://github.com/promptctl/cc-candybar/issues/1e1e1e) [#242f38](https://github.com/promptctl/cc-candybar/issues/242f38)

# [1.52.0](https://github.com/promptctl/cc-candybar/compare/v1.51.0...v1.52.0) (2026-09-05)


### Features

* **render:** paint the closed cell from the vocabulary; delete the hue cursor (candybar-render-ai7.4) ([#211](https://github.com/promptctl/cc-candybar/issues/211)) ([d6fb1f1](https://github.com/promptctl/cc-candybar/commit/d6fb1f124908ef985ad97dbe0eeeaa5ac764e619)), closes [#242f38](https://github.com/promptctl/cc-candybar/issues/242f38)

# [1.51.0](https://github.com/promptctl/cc-candybar/compare/v1.50.0...v1.51.0) (2026-09-05)


### Features

* **render:** disclosure bands — trigger wears the state of the band it opens, items on the plane, focusTint deleted (candybar-render-ai7.3) ([#210](https://github.com/promptctl/cc-candybar/issues/210)) ([df779c2](https://github.com/promptctl/cc-candybar/commit/df779c2d4a9fabee5a85f1e4ddd799c4dcdb9e08))

# [1.50.0](https://github.com/promptctl/cc-candybar/compare/v1.49.0...v1.50.0) (2026-09-05)


### Features

* **config:** root merges by named row — `{ rows }` fragments cascade like every other section (brandon-config-merge-uk3) ([#209](https://github.com/promptctl/cc-candybar/issues/209)) ([1171771](https://github.com/promptctl/cc-candybar/commit/11717715501ca71d74f53200da1b048d82fb8c48))

# [1.49.0](https://github.com/promptctl/cc-candybar/compare/v1.48.0...v1.49.0) (2026-09-04)


### Features

* **daemon:** the update notice — digest-identified build currency with rebuild/dismiss/disable (brandon-build-notice-5d6) ([#208](https://github.com/promptctl/cc-candybar/issues/208)) ([0024ca9](https://github.com/promptctl/cc-candybar/commit/0024ca9137a0cb908240a7d43927f6d6e887c08c))

# [1.48.0](https://github.com/promptctl/cc-candybar/compare/v1.47.0...v1.48.0) (2026-09-04)


### Features

* **themes:** the state colour — enforce the state/decoration contrast floor (candybar-render-ai7.2) ([#207](https://github.com/promptctl/cc-candybar/issues/207)) ([ddd3a15](https://github.com/promptctl/cc-candybar/commit/ddd3a154f583e446165e6e2f9bfb8f6318b7e93a))

# [1.47.0](https://github.com/promptctl/cc-candybar/compare/v1.46.0...v1.47.0) (2026-09-04)


### Features

* **themes:** the colour function — address -> theme vocabulary entry (candybar-render-ai7.1) ([#206](https://github.com/promptctl/cc-candybar/issues/206)) ([ddb966e](https://github.com/promptctl/cc-candybar/commit/ddb966ef3fd84970ec11af6ff9538186d7065e0f))

# [1.46.0](https://github.com/promptctl/cc-candybar/compare/v1.45.0...v1.46.0) (2026-09-04)


### Features

* **diagnostics:** wrap the config error to the terminal, cap its rows, link the full text as file:// (candybar-diagnostics-avi) ([#205](https://github.com/promptctl/cc-candybar/issues/205)) ([12005cc](https://github.com/promptctl/cc-candybar/commit/12005ccd9f7f07b5f197f771e5476049b534a536))

# [1.45.0](https://github.com/promptctl/cc-candybar/compare/v1.44.0...v1.45.0) (2026-09-04)


### Features

* **daemon:** the settings menu survives a config that fails to load (candybar-settings-ui-0gz) ([#204](https://github.com/promptctl/cc-candybar/issues/204)) ([78c32f0](https://github.com/promptctl/cc-candybar/commit/78c32f0c4d03ce3394973a7dc3852a07bb64c044))

# [1.44.0](https://github.com/promptctl/cc-candybar/compare/v1.43.0...v1.44.0) (2026-09-04)


### Features

* **config:** the config file is the one durable store (candybar-config-dqe) ([#203](https://github.com/promptctl/cc-candybar/issues/203)) ([c097cb7](https://github.com/promptctl/cc-candybar/commit/c097cb75779c97ddefd49ea96e5dd7ab9a86324c))

# [1.43.0](https://github.com/promptctl/cc-candybar/compare/v1.42.1...v1.43.0) (2026-09-04)


### Features

* **daemon:** warn when the bundle is older than the source beside it (candybar-build-2s5) ([#202](https://github.com/promptctl/cc-candybar/issues/202)) ([04eac87](https://github.com/promptctl/cc-candybar/commit/04eac87e644fa5ad339b28df678dd508bc7c302e)), closes [#78](https://github.com/promptctl/cc-candybar/issues/78)

## [1.42.1](https://github.com/promptctl/cc-candybar/compare/v1.42.0...v1.42.1) (2026-09-04)


### Bug Fixes

* **install:** compare the staged version to the registry's latest and warn loudly on a stale install (candybar-install-7fs) ([#201](https://github.com/promptctl/cc-candybar/issues/201)) ([0be0a6d](https://github.com/promptctl/cc-candybar/commit/0be0a6dba49cc373ff58f056c791d02dbe7d54d5))

# [1.42.0](https://github.com/promptctl/cc-candybar/compare/v1.41.3...v1.42.0) (2026-09-04)


### Features

* **cli:** `--version`/`-V` prints the baked package stamp; daemon-stats carries its own (candybar-cli-0x2) ([#200](https://github.com/promptctl/cc-candybar/issues/200)) ([69c92f7](https://github.com/promptctl/cc-candybar/commit/69c92f72a21621b6860d91e6e971c4dbfd29023c))

## [1.41.3](https://github.com/promptctl/cc-candybar/compare/v1.41.2...v1.41.3) (2026-09-03)


### Bug Fixes

* **daemon:** RenderCache publishes reload completion; tests await it instead of polling a clock (brandon-testing-82q) ([#199](https://github.com/promptctl/cc-candybar/issues/199)) ([18a1c7b](https://github.com/promptctl/cc-candybar/commit/18a1c7b1e1488f355b6033d04b0890cd3c73b6f9))

## [1.41.2](https://github.com/promptctl/cc-candybar/compare/v1.41.1...v1.41.2) (2026-09-03)


### Bug Fixes

* **dsl:** helpers are one shared Defines, not a preamble re-parsed into every template ([#198](https://github.com/promptctl/cc-candybar/issues/198)) ([54428d0](https://github.com/promptctl/cc-candybar/commit/54428d0c40c3a42e9c4fd8711099ab0627024eb6)), closes [#197](https://github.com/promptctl/cc-candybar/issues/197) [#197](https://github.com/promptctl/cc-candybar/issues/197)

## [1.41.1](https://github.com/promptctl/cc-candybar/compare/v1.41.0...v1.41.1) (2026-09-03)


### Bug Fixes

* **daemon:** derive the V8 heap cap from the RSS budget (outage: silent SIGABRT crash-loop) ([#197](https://github.com/promptctl/cc-candybar/issues/197)) ([35067e9](https://github.com/promptctl/cc-candybar/commit/35067e94522c52304aba5f14651c4ca922bbd98f))

# [1.41.0](https://github.com/promptctl/cc-candybar/compare/v1.40.0...v1.41.0) (2026-09-01)


### Features

* **config:** a reusable (?) that shows instructions where they are needed (candybar-settings-ui-aok.6) ([#195](https://github.com/promptctl/cc-candybar/issues/195)) ([d1903db](https://github.com/promptctl/cc-candybar/commit/d1903dbda3153d58945529851a3a5bff9a73645b))

# [1.40.0](https://github.com/promptctl/cc-candybar/compare/v1.39.0...v1.40.0) (2026-08-31)


### Features

* **config:** edit mode's look is a staged globals fragment, not renderer constants (candybar-settings-ui-aok.5) ([#194](https://github.com/promptctl/cc-candybar/issues/194)) ([480e6a9](https://github.com/promptctl/cc-candybar/commit/480e6a931a805fe5f38edec2768afc2455200642))

# [1.39.0](https://github.com/promptctl/cc-candybar/compare/v1.38.0...v1.39.0) (2026-08-31)


### Features

* **menu:** the disclosure glyph becomes authored data, so the + menus drop the arrow (candybar-settings-ui-aok.4) ([#193](https://github.com/promptctl/cc-candybar/issues/193)) ([e82fe4d](https://github.com/promptctl/cc-candybar/commit/e82fe4de344d5844302b7a70f7b7d2a0c7a7c82c))

# [1.38.0](https://github.com/promptctl/cc-candybar/compare/v1.37.0...v1.38.0) (2026-08-31)


### Features

* **config:** one control per setting, with a persist? that chooses the destination (candybar-settings-ui-aok.3) ([#192](https://github.com/promptctl/cc-candybar/issues/192)) ([d501fec](https://github.com/promptctl/cc-candybar/commit/d501fec32f8d3b1749dcce15d372d513bc3151d1))

# [1.37.0](https://github.com/promptctl/cc-candybar/compare/v1.36.0...v1.37.0) (2026-08-31)


### Features

* **daemon:** autoWrap and padding resolve per session (candybar-settings-ui-aok.2) ([#191](https://github.com/promptctl/cc-candybar/issues/191)) ([3ade71e](https://github.com/promptctl/cc-candybar/commit/3ade71e2d9424af16916cbc52d3dc896e746d407))

# [1.36.0](https://github.com/promptctl/cc-candybar/compare/v1.35.0...v1.36.0) (2026-08-27)


### Features

* **config:** a global settings menu no config can delete (candybar-settings-ui-aok.1) ([#190](https://github.com/promptctl/cc-candybar/issues/190)) ([6ba46ee](https://github.com/promptctl/cc-candybar/commit/6ba46ee3ea77e9e4ecd1b47b592336bf87ecb5e1))

# [1.35.0](https://github.com/promptctl/cc-candybar/compare/v1.34.1...v1.35.0) (2026-08-27)


### Features

* **segments:** host/SSH segment — show user@host only when remote (candybar-segments-e7u) ([#189](https://github.com/promptctl/cc-candybar/issues/189)) ([ab940d9](https://github.com/promptctl/cc-candybar/commit/ab940d9e00a52c44ae3dab5534fff1539c7c4ee2))

## [1.34.1](https://github.com/promptctl/cc-candybar/compare/v1.34.0...v1.34.1) (2026-08-26)


### Bug Fixes

* **demo:** update stale fg auto grammar and justfile demo target ([#188](https://github.com/promptctl/cc-candybar/issues/188)) ([d60b90c](https://github.com/promptctl/cc-candybar/commit/d60b90c08a9d16c6c4c44625ca6c27c7d4971268))

# [1.34.0](https://github.com/promptctl/cc-candybar/compare/v1.33.0...v1.34.0) (2026-08-24)


### Features

* **config:** visible diagnostic + reset for accumulated edit-mode ops (brandon-layout-edit-2gc.5) ([#187](https://github.com/promptctl/cc-candybar/issues/187)) ([d5303bb](https://github.com/promptctl/cc-candybar/commit/d5303bb497fd8ed0c5eabd17dd378c361d5cf423))

# [1.33.0](https://github.com/promptctl/cc-candybar/compare/v1.32.0...v1.33.0) (2026-08-24)


### Features

* **config:** ship edit mode in the bundled default (brandon-layout-edit-2gc.4) ([#186](https://github.com/promptctl/cc-candybar/issues/186)) ([b38a9a7](https://github.com/promptctl/cc-candybar/commit/b38a9a74ffb05d68862b506a168249c567931cbd))

# [1.32.0](https://github.com/promptctl/cc-candybar/compare/v1.31.0...v1.32.0) (2026-08-24)


### Features

* **config:** edit mode — inline +/- affordances spliced into the layout tree (brandon-layout-edit-2gc.3) ([#185](https://github.com/promptctl/cc-candybar/issues/185)) ([9252109](https://github.com/promptctl/cc-candybar/commit/9252109f20bcd584bf46678802eff770f9393b93))

# [1.31.0](https://github.com/promptctl/cc-candybar/compare/v1.30.0...v1.31.0) (2026-08-24)


### Features

* **config:** undo/redo over the config-overrides layer (brandon-layout-edit-2gc.2) ([#184](https://github.com/promptctl/cc-candybar/issues/184)) ([dca17da](https://github.com/promptctl/cc-candybar/commit/dca17dae40073668c2dd50d2af890d18cc5480e2))

# [1.30.0](https://github.com/promptctl/cc-candybar/compare/v1.29.0...v1.30.0) (2026-08-24)


### Features

* **config:** layout mutation through the existing config writer (brandon-layout-edit-2gc.1) ([#183](https://github.com/promptctl/cc-candybar/issues/183)) ([692ff99](https://github.com/promptctl/cc-candybar/commit/692ff99e127c7193ebd61aebb72d6ed5fe65a367))

# [1.29.0](https://github.com/promptctl/cc-candybar/compare/v1.28.0...v1.29.0) (2026-08-24)


### Features

* **config:** bundled preset library in the default config (brandon-presets-0yk.3) ([#182](https://github.com/promptctl/cc-candybar/issues/182)) ([ec4f883](https://github.com/promptctl/cc-candybar/commit/ec4f88320a0741c503498427a1a549252bdb8b09))

# [1.28.0](https://github.com/promptctl/cc-candybar/compare/v1.27.0...v1.28.0) (2026-08-24)


### Features

* **config:** persist/reset a preset choice across restarts (brandon-presets-0yk.2) ([#181](https://github.com/promptctl/cc-candybar/issues/181)) ([cbc1048](https://github.com/promptctl/cc-candybar/commit/cbc104824085039ecb1fd06ddcedbd628ce08d14)), closes [#179](https://github.com/promptctl/cc-candybar/issues/179)

# [1.27.0](https://github.com/promptctl/cc-candybar/compare/v1.26.0...v1.27.0) (2026-08-24)


### Features

* **config:** presets block + per-render resolution seam (brandon-presets-0yk.1) ([#179](https://github.com/promptctl/cc-candybar/issues/179)) ([40d3461](https://github.com/promptctl/cc-candybar/commit/40d3461efccfc422cf8207edd6c65cf4adb28b0a))

# [1.26.0](https://github.com/promptctl/cc-candybar/compare/v1.25.0...v1.26.0) (2026-08-09)


### Features

* **cli:** mention the theme/look picker in --help and install output (8uj.3) ([#166](https://github.com/promptctl/cc-candybar/issues/166)) ([99405fa](https://github.com/promptctl/cc-candybar/commit/99405fa99b92c8009eefdbae86fb42987c70cf12))

# [1.25.0](https://github.com/promptctl/cc-candybar/compare/v1.24.0...v1.25.0) (2026-08-09)


### Features

* **theming:** switch bundled default palette to tokyo-night ([#165](https://github.com/promptctl/cc-candybar/issues/165)) ([104a146](https://github.com/promptctl/cc-candybar/commit/104a146adfb2e45ab39933020cd803e1eeb4d4ac))

# [1.24.0](https://github.com/promptctl/cc-candybar/compare/v1.23.0...v1.24.0) (2026-08-09)


### Features

* **theming:** wire theme/look picker into the bundled default ([#164](https://github.com/promptctl/cc-candybar/issues/164)) ([2da0143](https://github.com/promptctl/cc-candybar/commit/2da01434a84acde0bc6bbc0932873ef6bd50437a))

# [1.23.0](https://github.com/promptctl/cc-candybar/compare/v1.22.0...v1.23.0) (2026-08-05)


### Bug Fixes

* **deploy:** committed node bin + install-time staging replace postinstall machinery ([#159](https://github.com/promptctl/cc-candybar/issues/159)) ([10330e0](https://github.com/promptctl/cc-candybar/commit/10330e0c31f984f93887cb1268b6502966dcb236))


### Features

* **daemon-lifecycle:** exponential backoff on the spawn-cooldown rate bound ([#163](https://github.com/promptctl/cc-candybar/issues/163)) ([2298b27](https://github.com/promptctl/cc-candybar/commit/2298b27202edc931dadc9fdf957ed52161fb5d11))

# [1.22.0](https://github.com/promptctl/cc-candybar/compare/v1.21.0...v1.22.0) (2026-07-29)


### Features

* **daemon-lifecycle:** daemon-side fork-bomb circuit breaker ([#162](https://github.com/promptctl/cc-candybar/issues/162)) ([df50295](https://github.com/promptctl/cc-candybar/commit/df50295cf107e3ee70cd844491a5e538b6fbda9b))

# [1.21.0](https://github.com/promptctl/cc-candybar/compare/v1.20.0...v1.21.0) (2026-07-29)


### Features

* **themes:** "looks" — named theme adaptations composing over any theme ([#160](https://github.com/promptctl/cc-candybar/issues/160)) ([89ff4e8](https://github.com/promptctl/cc-candybar/commit/89ff4e8c1beb0a5910d3083aa19ae8246c6f724a))

# [1.20.0](https://github.com/promptctl/cc-candybar/compare/v1.19.0...v1.20.0) (2026-07-26)


### Features

* **config:** cc-candybar check — full-pipeline config validation with a text/exit-code contract (brandon-menus-bn5.7) ([#157](https://github.com/promptctl/cc-candybar/issues/157)) ([c3efbcb](https://github.com/promptctl/cc-candybar/commit/c3efbcb8be072980b290a9343528d37a64aa7c45))

# [1.19.0](https://github.com/promptctl/cc-candybar/compare/v1.18.1...v1.19.0) (2026-07-26)


### Features

* **menus:** `{{ menu }}` synthesizes the page cursor; named options replace the positional tail (brandon-menus-bn5.6) ([#156](https://github.com/promptctl/cc-candybar/issues/156)) ([9bf8a35](https://github.com/promptctl/cc-candybar/commit/9bf8a358cf97a262f1d97e1d795b227e3cc5479a))

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
