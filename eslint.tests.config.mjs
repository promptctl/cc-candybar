import tsparser from "@typescript-eslint/parser";

// [LAW:effects-at-boundaries] [LAW:no-shared-mutable-globals] A test states the
// machine it runs on by handing src a Host (test/helpers/host.ts `hostOf`), and
// never by writing `process.env`: the environment is one ambient value per
// worker, so a write is a fixture every later test in the file inherits.
//
// This config holds that one rule and nothing else, because the test tree is
// not under the src lint (formatting, imports). `pnpm lint` runs it beside the
// src config.
//
// The writes that remain are the ones that isolate or feed what a run spawns:
//   - the setup files, which isolate the worker from the host;
//   - the in-worker harness, which places a daemon's env (deleted by
//     candybar-testing-ihvy ticket 35);
//   - PATH, for the stubs a test puts ahead of a real program (deleted by
//     tickets 16 and 17, which give those programs a port).
const WRITE_MESSAGE =
  "Hand src a Host (hostOf) instead of writing process.env. [LAW:effects-at-boundaries]";

export const ENV_WRITES = [
  // process.env.X = v, process.env[k] = v, process.env = v
  `AssignmentExpression[left.object.object.name='process'][left.object.property.name='env']:not([left.property.name='PATH'])`,
  `AssignmentExpression[left.object.name='process'][left.property.name='env']`,
  // delete process.env.X
  `UnaryExpression[operator='delete'] > MemberExpression[object.object.name='process'][object.property.name='env']:not([property.name='PATH'])`,
  // Object.assign(process.env, ...)
  "CallExpression[callee.object.name='Object'][callee.property.name='assign'][arguments.0.object.name='process'][arguments.0.property.name='env']",
].map((selector) => ({ selector, message: WRITE_MESSAGE }));

// [LAW:effects-at-boundaries] [LAW:single-enforcer] A test that is not testing
// the launcher's adapter does not start a real program: it scripts its programs
// on a fake (test/helpers/fake-launcher.ts) and holds a clock. The machine's
// launcher is imported only by the launcher's adapter tests, the process tier,
// the harness that builds it, and the files below. The integration layer holds
// every test that touches a real dependency, so it is named file by file: a
// test there that reaches only the disk or the clock has no program to start.
// Each exception is owned by the ticket that gives its program a port or a
// script; the list may shrink and no file joins it.
//   the repository tools   candybar-testing-ihvy.31f, candybar-testing-ihvy.xp7
//   tmux                   candybar-testing-ihvy.dcv
//   shell sources, verbs, jobs, ps   candybar-testing-ihvy.fvw.1dl
const REAL_LAUNCHER_ADAPTERS = [
  "test/integration/launch.test.ts",
  "test/integration/launch-group-end.test.ts",
  "test/integration/launcher-settled.test.ts",
  "test/integration/system-probe.test.ts",
  "test/integration/system-spawner.test.ts",
  "test/integration/process/**",
  "test/helpers/host.ts",
  "test/helpers/daemon-pool.ts",
  "test/integration/daemon-pool.test.ts",
];
const REAL_LAUNCHER_EXCEPTIONS = [
  // the repository tools
  "test/integration/git-root-ascent.test.ts",
  "test/integration/git-service-outcomes.test.ts",
  "test/integration/git-spawn-budget.test.ts",
  "test/integration/git-stash-count.test.ts",
  "test/integration/git-worktree.test.ts",
  "test/integration/daemon-watchers.test.ts",
  "test/integration/doctor-segment-data.test.ts",
  // tmux
  "test/integration/claude-input.test.ts",
  "test/integration/click-order.test.ts",
  "test/integration/segments-tmux-cache.test.ts",
  "test/integration/lane-edge-bar-pane.test.ts",
  // shell sources, verbs, jobs, ps
  "test/integration/click-launch.test.ts",
  "test/integration/daemon-process-fingerprint.test.ts",
  "test/integration/derived-payload.test.ts",
  "test/integration/journal-turns.test.ts",
  "test/integration/memory-report.test.ts",
  "test/integration/plugin-sources.test.ts",
  "test/integration/plugins.test.ts",
  "test/integration/run-action.test.ts",
  "test/integration/session-views.test.ts",
  "test/integration/update-act.test.ts",
  "test/integration/var-sources.test.ts",
];
const REAL_LAUNCHER_MESSAGE =
  "Script the program on a fake launcher (test/helpers/fake-launcher.ts), or test the adapter under test/integration. [LAW:effects-at-boundaries]";

export default [
  {
    files: ["test/**/*.{ts,mts}"],
    ignores: [
      "test/setup.ts",
      "test/unit-global-setup.ts",
      "test/helpers/in-worker-daemon.ts",
    ],
    languageOptions: { parser: tsparser, ecmaVersion: "latest", sourceType: "module" },
    rules: { "no-restricted-syntax": ["error", ...ENV_WRITES] },
  },
  {
    files: ["test/**/*.{ts,mts}"],
    ignores: [...REAL_LAUNCHER_ADAPTERS, ...REAL_LAUNCHER_EXCEPTIONS],
    languageOptions: { parser: tsparser, ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/helpers/host"],
              importNames: ["processLauncher"],
              message: REAL_LAUNCHER_MESSAGE,
            },
            {
              group: ["**/proc/system-launcher", "**/proc/system-launcher.js"],
              importNames: ["systemLauncher", "systemOneShotLauncher"],
              message: REAL_LAUNCHER_MESSAGE,
            },
            {
              group: ["**/proc/spawner", "**/proc/spawner.js"],
              importNames: ["systemSpawner"],
              message: REAL_LAUNCHER_MESSAGE,
            },
          ],
        },
      ],
    },
  },
];
