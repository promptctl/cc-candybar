import tsparser from "@typescript-eslint/parser";
import { builtinRules } from "eslint/use-at-your-own-risk";

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
// launcher is imported only by the adapter tiers (integration, the launcher's
// own tests, the process tier), by the harness that builds it, and by the files
// below. Each exception is owned by the ticket that gives its program a port or
// a script; the list may shrink and no file joins it.
//   the repository tools   candybar-testing-ihvy.31f, candybar-testing-ihvy.xp7
//   tmux                   candybar-testing-ihvy.dcv
//   shell sources, verbs, jobs, ps   candybar-testing-ihvy.fvw.1dl
const REAL_LAUNCHER_ADAPTERS = [
  "test/integration/**",
  "test/proc/**",
  "test/daemon-boots/process/**",
  "test/helpers/host.ts",
  "test/helpers/daemon-pool.ts",
  "test/daemon-pool.test.ts",
];
const REAL_LAUNCHER_EXCEPTIONS = [
  // the repository tools
  "test/git-root-ascent.test.ts",
  "test/git-service-outcomes.test.ts",
  "test/git-spawn-budget.test.ts",
  "test/git-stash-count.test.ts",
  "test/git-worktree.test.ts",
  "test/daemon-watchers.test.ts",
  "test/doctor-segment-data.test.ts",
  // tmux
  "test/claude-input.test.ts",
  "test/click-order.test.ts",
  "test/segments-tmux-cache.test.ts",
  "test/lane-edge-bar-pane.process.test.ts",
  // shell sources, verbs, jobs, ps
  "test/click-launch.test.ts",
  "test/daemon-process-fingerprint.test.ts",
  "test/derived-payload.test.ts",
  "test/journal-turns.test.ts",
  "test/memory-report.test.ts",
  "test/plugin-sources.test.ts",
  "test/plugins.test.ts",
  "test/run-action.test.ts",
  "test/session-views.test.ts",
  "test/update-act.test.ts",
  "test/var-sources.test.ts",
];
const REAL_LAUNCHER_MESSAGE =
  "Script the program on a fake launcher (test/helpers/fake-launcher.ts), or test the adapter under test/integration. [LAW:effects-at-boundaries]";

// [LAW:effects-at-boundaries] [LAW:single-enforcer] A test of a client dials
// the daemon a case stands up on a fake dialer (test/helpers/dial.ts), and
// listens on no socket of its own. A real socket is the adapter tier's
// (test/integration), and the tmux stub's gate, which tmux dials.
const NET_OWNERS = ["test/integration/**", "test/helpers/tmux-stub.ts"];
const NET_MESSAGE =
  "Listen on a fake dialer (test/helpers/dial.ts), or test the socket under test/integration. [LAW:effects-at-boundaries]";
const NET_MODULE = "/^(node:)?net$/";
const NET_SYNTAX = [
  `ImportDeclaration[source.value=${NET_MODULE}][importKind!='type']`,
  `ImportExpression[source.value=${NET_MODULE}]`,
].map((selector) => ({ selector, message: NET_MESSAGE }));

export default [
  {
    files: ["test/**/*.{ts,mts}"],
    ignores: [
      "test/setup.ts",
      "test/global-setup.ts",
      "test/setup-after-env.ts",
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
  // Its own rule name, so the env-write block's `no-restricted-syntax` is
  // neither dropped nor repeated.
  {
    files: ["test/**/*.{ts,mts}"],
    ignores: NET_OWNERS,
    languageOptions: { parser: tsparser, ecmaVersion: "latest", sourceType: "module" },
    plugins: {
      dial: { rules: { "no-net": builtinRules.get("no-restricted-syntax") } },
    },
    rules: { "dial/no-net": ["error", ...NET_SYNTAX] },
  },
];
