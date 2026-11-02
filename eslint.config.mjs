import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

// [LAW:single-enforcer] (kz8.2) src/proc/launch.ts is the only file allowed to
// import node:child_process directly. Every other spawn site routes through a
// Launcher. This rule keeps the invariant load-bearing: a future regression
// fails lint, not just a manual grep.
const CHILD_PROCESS_PATHS = ["child_process", "node:child_process"].map(
  (name) => ({
    name,
    message:
      "Launch through a Launcher from src/proc/launch instead. [LAW:single-enforcer] (kz8.2)",
  }),
);

// [LAW:single-enforcer] Names only their owners may import, so what makes a
// launch ownerless, or a path ambient, cannot be reached for by accident. Daemon
// work holds its daemon's launcher: an owner's close is what refuses its
// launches, and none reaches work that went around it. A daemon is handed its
// adapters and its paths (src/daemon/production-adapters.ts builds the real
// ones, src/daemon/server.ts reads the environment's), so `createDaemon` names
// neither.
const PATHS = [
  "**/daemon/paths",
  "**/daemon/paths.js",
  "**/paths",
  "**/paths.js",
];

const OWNED_IMPORTS = {
  // The process's one launcher, built beside the host it inherits from: a
  // process main takes it from `processWorld`, and everything else is handed it.
  createOneShotLauncher: {
    group: ["**/proc/launch", "**/proc/launch.js"],
    owners: ["src/host.ts"],
    message:
      "The process has its one-shot launcher: take the one you are given.",
  },
  // The composition root of the one owner that is not the process.
  createLauncher: {
    group: ["**/proc/launch", "**/proc/launch.js"],
    owners: ["src/daemon/production-adapters.ts"],
    message: "A Launcher is an owner's: take the one you are handed.",
  },
  // The real adapters a daemon is handed.
  fileStores: {
    group: ["**/doctor/edge", "**/doctor/edge.js"],
    owners: ["src/daemon/production-adapters.ts"],
    message: "A daemon is handed its adapters (production-adapters.ts).",
  },
  productionEdge: {
    group: ["**/doctor/edge", "**/doctor/edge.js"],
    owners: ["src/daemon/production-adapters.ts", "src/doctor/cli.ts"],
    message: "A daemon is handed its adapters (production-adapters.ts).",
  },
  productionClaudeInputEdge: {
    group: ["**/claude-input/edge", "**/claude-input/edge.js"],
    owners: ["src/daemon/production-adapters.ts", "src/daemon/lane-edge.ts"],
    message: "A daemon is handed its adapters (production-adapters.ts).",
  },
  productionLaneEdge: {
    group: ["**/lane-edge", "**/lane-edge.js"],
    owners: ["src/daemon/production-adapters.ts"],
    message: "A daemon is handed its adapters (production-adapters.ts).",
  },
  realLimitsDeps: {
    group: ["**/limits", "**/limits.js"],
    owners: ["src/daemon/production-adapters.ts"],
    message: "A daemon is handed its adapters (production-adapters.ts).",
  },
  fileStorage: {
    group: ["**/file-storage", "**/file-storage.js"],
    owners: ["src/daemon/production-adapters.ts"],
    message: "A daemon is handed its adapters (production-adapters.ts).",
  },
  linkSignerFromKeyFile: {
    group: ["**/link-key", "**/link-key.js"],
    owners: [
      "src/daemon/production-adapters.ts",
      "src/check.ts",
      "src/demo/dsl.ts",
      "src/doctor/cli.ts",
    ],
    message: "A daemon is handed its link signer (production-adapters.ts).",
  },
  // Where files are, read from the environment by a process's entry point and
  // handed down. The daemon process reads it once, in server.ts.
  daemonPaths: {
    group: PATHS,
    owners: ["src/daemon/server.ts"],
    message: "A daemon is handed its paths: take the value you are given.",
  },
  stateDir: {
    group: PATHS,
    owners: [
      "src/check.ts",
      "src/demo/dsl.ts",
      "src/demo/gallery.ts",
      "src/doctor/cli.ts",
    ],
    message: "A daemon is handed its paths: take the value you are given.",
  },
  ...Object.fromEntries(
    ["socketPath", "defaultSocketPath"].map((name) => [
      name,
      {
        group: PATHS,
        owners: [
          "src/frames-cli.ts",
          "src/bar-pane/index.ts",
          "src/doctor/handler-probe.ts",
          "src/daemon/client-transport.ts",
          "src/daemon/acquire.ts",
        ],
        message:
          "Only a client of the daemon reads its socket from the environment.",
      },
    ]),
  ),
  ...Object.fromEntries(
    ["daemonDir", "spawnLockPath", "spawnCooldownPath", "spawnBackoffPath"].map(
      (name) => [
        name,
        {
          group: PATHS,
          owners: ["src/daemon/acquire.ts"],
          message: "Only the client that spawns a daemon reads these.",
        },
      ],
    ),
  ),
  // The pricing disk cache is read ahead of its port
  // (candybar-testing-ihvy.89p), which takes its directory as an input.
  cacheDir: {
    group: PATHS,
    owners: ["src/daemon/cache/session-usage-store.ts"],
    message: "A daemon is handed its paths: take the value you are given.",
  },
  ...Object.fromEntries(
    [
      "logPath",
      "leasePath",
      "sessionStatePath",
      "settingsHistoryPath",
      "daemonRegistryDir",
      "watchProbeDir",
    ].map((name) => [
      name,
      {
        group: PATHS,
        owners: [],
        message: "A daemon is handed its paths: take the value you are given.",
      },
    ]),
  ),
};

// [LAW:effects-at-boundaries] [LAW:single-enforcer] The environment, the home
// directory (`os.homedir` reads `HOME`) and the temporary directory
// (`os.tmpdir` reads `TMPDIR`) are read once, by `processWorld` in
// src/host.ts, and handed down as a `Host`. The preload's main runs apart from
// the rest of src and reads its own. Every other file takes what it is given.
const HOST_READERS = ["src/host.ts", "src/attach-preload-exec.ts"];
const HOST_READ_MESSAGE =
  "Take the Host you are handed: src/host.ts reads the process once. [LAW:effects-at-boundaries]";
const HOST_NAMED_IMPORTS = [
  {
    group: ["os", "node:os"],
    importNames: ["homedir", "tmpdir"],
    message: HOST_READ_MESSAGE,
  },
  {
    group: ["process", "node:process"],
    importNames: ["env"],
    message: HOST_READ_MESSAGE,
  },
];

// [LAW:one-way-deps] Foundations (src/daemon/foundations/) is the row every
// piece of the daemon may reach, so it reaches none of them: a relative import
// out of it into the rest of src/daemon fails. The two regexes are the two
// spellings of that edge, `../x` and `../../daemon/x` (through src, too); `./x`
// and the modules outside src/daemon (`../../config/x`) stay legal.
const FOUNDATIONS_FILES = "src/daemon/foundations/**/*.ts";
const FOUNDATIONS_IMPORTS = [
  {
    regex: "^(\\./)?\\.\\.(/([^.]|$)|$)",
    message:
      "Foundations sits below every piece of the daemon: import nothing from them. [LAW:one-way-deps]",
  },
  {
    regex: "^\\.{1,2}/(\\.\\./)*(src/)?daemon(/|$)",
    message:
      "Foundations sits below every piece of the daemon: import nothing from them. [LAW:one-way-deps]",
  },
];

// A file's whole rule: flat config replaces a rule per file rather than merging
// it, so each block carries the child_process paths and every name but its own,
// and the import edges its row forbids (`rowPatterns`).
// `patterns`, not `paths`: a path matches only the literal import string, and
// these are imported by relative spellings that differ file to file.
function restrictedImports(file, rowPatterns = []) {
  return [
    "error",
    {
      paths: CHILD_PROCESS_PATHS,
      patterns: [
        ...Object.entries(OWNED_IMPORTS)
          .filter(([, { owners }]) => !owners.includes(file))
          .map(([name, { group, message }]) => ({
            group,
            importNames: [name],
            message: `${message} [LAW:single-enforcer]`,
          })),
        ...HOST_NAMED_IMPORTS,
        ...rowPatterns,
      ],
    },
  ];
}

function ownedImportBlocks() {
  const owners = [
    ...new Set(Object.values(OWNED_IMPORTS).flatMap((o) => o.owners)),
  ];
  return [
    {
      files: ["src/**/*.{ts,mts}"],
      ignores: ["src/proc/**"],
      rules: { "no-restricted-imports": restrictedImports(null) },
    },
    ...owners.map((file) => ({
      files: [file],
      rules: { "no-restricted-imports": restrictedImports(file) },
    })),
    {
      files: [FOUNDATIONS_FILES],
      rules: {
        "no-restricted-imports": restrictedImports(null, FOUNDATIONS_IMPORTS),
      },
    },
  ];
}

export default [
  js.configs.recommended,
  {
    files: ["**/*.{ts,mts}"],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        BufferEncoding: "readonly",
        NodeJS: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        // The build stamp tsdown bakes (src/build-stamps.d.ts).
        __SOURCE_DIGEST__: "readonly",
        URL: "readonly",
        fetch: "readonly",
        // A monotonic clock, global in Node and the browser page alike.
        performance: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        Response: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        jest: "readonly",
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        require: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      prettier: prettierPlugin,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-console": "off",
      "prefer-const": "warn",
      "no-var": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-case-declarations": "off",
      "prettier/prettier": "error",
      curly: "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  prettierConfig,
  ...ownedImportBlocks(),
  // `no-restricted-properties` is its own rule, so the per-file replacement of
  // `no-restricted-imports` and `no-restricted-syntax` above leaves it alone.
  // It also catches the destructured spelling (`const { env } = process`); an
  // alias of `process` itself is the one it cannot see.
  {
    files: ["src/**/*.{ts,mts}"],
    ignores: HOST_READERS,
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: HOST_READ_MESSAGE },
        { object: "os", property: "homedir", message: HOST_READ_MESSAGE },
        { object: "os", property: "tmpdir", message: HOST_READ_MESSAGE },
      ],
    },
  },
  // [LAW:verifiable-goals] A path the daemon serves holds its loop if it
  // launches synchronously, so these cannot name the way to. Goes with the
  // launchSync half when `Launcher` drops it (candybar-launch-q7o7.4em).
  // server.ts is the shell: it alone names `runTmux`, for the at-exit handle.
  {
    files: [
      "src/daemon/**/*.ts",
      "src/claude-input/**/*.ts",
      "src/segments/**/*.ts",
      "src/var-system/**/*.ts",
      "src/doctor/edge.ts",
      "src/doctor/font-edge.ts",
    ],
    ignores: ["src/daemon/server.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='launchSync']",
          message: "A path the daemon serves awaits `launch`.",
        },
        {
          selector: "Identifier[name='runTmux']",
          message: "A path the daemon serves awaits `runTmuxAsync`.",
        },
      ],
    },
  },
  // [LAW:effects-at-boundaries] `createDaemon` reaches the machine through its
  // inputs (DaemonAdapters): neither the network nor the disk is named in it.
  {
    files: ["src/daemon/daemon.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Take `fetch` from the daemon's inputs." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='launchSync']",
          message: "A path the daemon serves awaits `launch`.",
        },
        {
          selector: "Identifier[name='runTmux']",
          message: "A path the daemon serves awaits `runTmuxAsync`.",
        },
        {
          selector: "ImportDeclaration[source.value=/^(node:)?fs$/]",
          message: "Take the disk from the daemon's inputs.",
        },
      ],
    },
  },
  {
    files: ["src/daemon/server.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='launchSync']",
          message: "A path the daemon serves awaits `launch`.",
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/",
      "dist/",
      "**/*.d.ts",
      "**/*.js",
      "!eslint.config.mjs",
    ],
  },
];
