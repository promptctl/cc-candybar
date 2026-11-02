import { E2E_DIR, UNIT_DIR, ignoring } from "./test/helpers/tiers.cjs";

// Jest reports through its "agent" reporter when an agent runs it and its
// "default" one otherwise, but only while no reporter list is configured.
// [LAW:one-source-of-truth] exception: the list below copies the one
// @jest/core's detectAgent reads (jest 30.3). jest does not export that check,
// and a reporter list has no entry for "jest's choice", so keeping the choice
// beside the reporter this config adds means reading the same variables here.
// On a jest upgrade, compare this list with detectAgent's.
const AGENT_ENV_VARS = [
  "AI_AGENT",
  "AUGMENT_AGENT",
  "CLAUDE_CODE",
  "CLAUDECODE",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "GOOSE_PROVIDER",
  "OPENCODE",
  "REPL_ID",
];
const jestReporter = AGENT_ENV_VARS.some((key) => (process.env[key] ?? "") !== "")
  ? "agent"
  : "default";

// [LAW:nothing-unseen] Every run keeps one record per test file, named for the
// run so the two CI steps and a local `pnpm test` do not overwrite each other.
export function reportersFor(run) {
  return [
    jestReporter,
    "<rootDir>/test/stackless-failure-reporter.mjs",
    ["<rootDir>/test/test-records-reporter.cjs", { run }],
  ];
}

// [LAW:single-enforcer] A test under test/e2e/ runs only through jest.e2e.config.js,
// which carries the cap and the assertion limit, and a test under test/unit/ only
// through jest.unit.config.js, which refuses what a unit test may not touch. This
// base ignores both directories, so no run reaches either without its checks, and
// `jest <path>` on one finds nothing and says so instead of passing unguarded.
export const E2E_DIR_PATTERN = ignoring(E2E_DIR);
export const UNIT_DIR_PATTERN = ignoring(UNIT_DIR);

export default {
  testPathIgnorePatterns: [E2E_DIR_PATTERN, UNIT_DIR_PATTERN],
  setupFiles: ["<rootDir>/test/setup.ts"],
  setupFilesAfterEnv: ["<rootDir>/test/setup-after-env.ts"],
  // [LAW:no-mode-explosion] A small fixed cap, not "cores-1" (the default),
  // on how many test files this ONE `pnpm test` invocation runs concurrently.
  // The real hard ceiling on concurrent daemon subprocesses is the shared
  // pool in test/helpers/daemon-pool.ts (machine-global, so it also bounds
  // concurrent worktree runs); this cap additionally bounds baseline
  // per-invocation resource pressure (brandon-daemon-lifecycle-gad.1).
  maxWorkers: 4,
  globalSetup: "<rootDir>/test/global-setup.ts",
  globalTeardown: "<rootDir>/test/global-teardown.ts",
  reporters: reportersFor("all"),
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^@promptctl/rich-js$": "<rootDir>/node_modules/@promptctl/rich-js/dist/index.js",
    "^@promptctl/rich-js/themes/data$": "<rootDir>/node_modules/@promptctl/rich-js/dist/themes/data/index.js",
    "^@promptctl/rich-js/template-bindings$": "<rootDir>/node_modules/@promptctl/rich-js/dist/template-bindings/index.js",
    "^@promptctl/go-template-js$": "<rootDir>/node_modules/@promptctl/go-template-js/dist/index.js",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transformIgnorePatterns: [
    // pnpm reroutes file: deps through node_modules/.pnpm/<spec>/node_modules/<pkg>,
    // so the same set of ESM packages must be allow-listed under both the
    // direct path and the .pnpm/ shadow.
    // Scoped packages (@scope/name) are encoded as @scope+name in the pnpm
    // shadow directory prefix — [/+] covers both the direct and shadow forms.
    "node_modules/(?!(\\.pnpm/)?(@promptctl[/+]go-template-js|@promptctl[/+]rich-js|@noble[/+]hashes)(@|/))",
  ],
  transform: {
    "^.+\\.(t|j)sx?$": [
      "ts-jest",
      {
        useESM: true,
        // [LAW:single-enforcer] Types are checked once, by `tsc --noEmit`
        // (the Test job's typecheck step, and publish). The transform only
        // transpiles: with a type-check it re-reads the module graph in every
        // worker on a cold cache, which is seconds per test file on CI. The
        // switch is tsconfig's `isolatedModules`, which ts-jest reads; it is
        // not set here, where ts-jest deprecates it.
      },
    ],
  },
  testTimeout: 30000,
};