import module from "node:module";

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

// src spells a TypeScript module's import with `.js`, the name its build emits.
// A test's module registry maps that spelling to the source (moduleNameMapper
// below), but jest loads the global setup and teardown through Node's own
// resolver, which the mapper never reaches. So this process resolves the same
// spelling the same way, when no file has the name: whatever src the global
// hooks import resolves as it does in a test.
// [LAW:one-source-of-truth] One pattern for both resolvers.
// `module.registerHooks` arrived in Node 22.15 and 23.5, later than the floor
// the package runs on (`engines`), so the repository's own floor is
// package.json's `devEngines`, which pnpm refuses an older Node by.
const SOURCE_SPECIFIER = /^(\.{1,2}\/.*)\.js$/;
const NOT_FOUND = new Set(["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"]);
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const source = SOURCE_SPECIFIER.exec(specifier);
      if (source === null || !NOT_FOUND.has(error.code)) throw error;
      return nextResolve(`${source[1]}.ts`, context);
    }
  },
});

// [LAW:single-enforcer] This file holds what every run shares and selects no
// test, so a bare `jest`, `--watch` or `--coverage` finds nothing and says so
// instead of running a file outside the checks of its own tier: the unit
// refusal, the end-to-end cap and assertion limit. A run names its tier's
// config, and that config says what it selects.
export const TEST_MATCH = ["**/*.test.ts"];

export default {
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
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  // Jest's node environment, plus the one place a quarantined case leaves the
  // gate and the keeper of how long the running case has left.
  testEnvironment: "<rootDir>/test/helpers/quarantine-environment.cjs",
  roots: ["<rootDir>/test"],
  testMatch: [],
  moduleNameMapper: {
    "^@promptctl/rich-js$": "<rootDir>/node_modules/@promptctl/rich-js/dist/index.js",
    "^@promptctl/rich-js/themes/data$": "<rootDir>/node_modules/@promptctl/rich-js/dist/themes/data/index.js",
    "^@promptctl/rich-js/template-bindings$": "<rootDir>/node_modules/@promptctl/rich-js/dist/template-bindings/index.js",
    "^@promptctl/go-template-js$": "<rootDir>/node_modules/@promptctl/go-template-js/dist/index.js",
    [SOURCE_SPECIFIER.source]: "$1",
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