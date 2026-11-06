import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import { builtinRules } from "eslint/use-at-your-own-risk";

// [LAW:single-enforcer] (kz8.2) src/proc/spawner.ts is the only file allowed to
// import node:child_process directly. Every other spawn site routes through a
// Launcher, which reaches the OS through that Spawner. This rule keeps the
// invariant load-bearing: a future regression fails lint, not just a manual grep.
const SPAWNER_FILE = "src/proc/spawner.ts";
const CHILD_PROCESS_PATHS = ["child_process", "node:child_process"].map(
  (name) => ({
    name,
    message:
      "Launch through a Launcher from src/proc/launch instead. [LAW:single-enforcer] (kz8.2)",
  }),
);

// [LAW:effects-at-boundaries] [LAW:single-enforcer] The real clock, the timer
// globals and the loop's turn are read in src/time.ts alone; everything else is
// handed a Timekeeper. Flat config replaces a rule per file block, so each rule
// below is built as a function of the file and spread into every block that
// sets it, and no block drops the clock when it adds its own restrictions.
const CLOCK_FILE = "src/time.ts";
const CLOCK_MESSAGE =
  "Take the clock you are handed (src/time.ts): it alone reads the real one. [LAW:effects-at-boundaries]";
const CLOCK_PROPERTIES = [
  { object: "Date", property: "now", message: CLOCK_MESSAGE },
  { object: "performance", property: "now", message: CLOCK_MESSAGE },
  { object: "process", property: "hrtime", message: CLOCK_MESSAGE },
  { object: "process", property: "uptime", message: CLOCK_MESSAGE },
  { object: "AbortSignal", property: "timeout", message: CLOCK_MESSAGE },
];
// [LAW:single-enforcer] A signal sent to a pid or its group, or signal 0 asking
// whether it is there, is read of the process table: src/proc/spawner.ts owns
// it for a launch's groups and the ProcessProbe for a pid. The two files
// below are exceptions, each owned by the ticket that gives its program a port;
// the list may shrink and no other file joins it.
//   src/daemon/lane-edge.ts  SIGTERM to Claude Code (candybar-testing-ihvy.dcv)
//   src/daemon/server.ts     the daemon's own SIGKILL (the Lifetime piece)
const KILL_EXCEPTIONS = ["src/daemon/lane-edge.ts", "src/daemon/server.ts"];
const KILL_OWNERS = [
  "src/proc/spawner.ts",
  "src/daemon/process-fingerprint.ts",
  ...KILL_EXCEPTIONS,
];
const KILL_PROPERTY = {
  object: "process",
  property: "kill",
  message:
    "Signals and liveness reads go through a Spawner (a launch's group) or a ProcessProbe (a pid). [LAW:single-enforcer]",
};
const CLOCK_SYNTAX = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: CLOCK_MESSAGE,
  },
  {
    selector:
      "NewExpression[callee.name='Date'][arguments.length=1] > Identifier[name='undefined']",
    message: CLOCK_MESSAGE,
  },
  { selector: "CallExpression[callee.name='Date']", message: CLOCK_MESSAGE },
];
const CLOCK_GLOBALS = [
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
].map((name) => ({ name, message: CLOCK_MESSAGE }));
const CLOCK_IMPORT_PATHS = [
  "node:timers",
  "timers",
  "node:timers/promises",
  "timers/promises",
  "node:perf_hooks",
  "perf_hooks",
].map((name) => ({ name, message: CLOCK_MESSAGE }));

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

// [LAW:single-enforcer] [LAW:effects-at-boundaries] The disk is reached through
// a Filesystem (src/disk/filesystem.ts); src/disk/system-filesystem.ts is the
// only file that may name `fs`. FS_READERS are the files that still read the
// disk directly. The list only shrinks: a file joins it only by an edit here,
// so what is left to move onto the port is counted by its length.
const FILESYSTEM_FILE = "src/disk/system-filesystem.ts";
const FS_READERS = [
  "src/attach-preload-exec.ts",
  "src/check.ts",
  "src/claude-settings.ts",
  "src/config/cli.ts",
  "src/config/dsl-loader.ts",
  "src/config/loader/discovery.ts",
  "src/config/loader/plugin-folders.ts",
  "src/config/loader/plugins.ts",
  "src/daemon/acquire.ts",
  "src/daemon/build-currency.ts",
  "src/daemon/config-file-store.ts",
  "src/daemon/fork-bomb-breaker.ts",
  "src/daemon/lane-edge.ts",
  "src/daemon/limits.ts",
  "src/daemon/link-key.ts",
  "src/daemon/log.ts",
  "src/daemon/memory-report.ts",
  "src/daemon/paths.ts",
  "src/daemon/repo-configs.ts",
  "src/daemon/server.ts",
  "src/daemon/session-recorder.ts",
  "src/daemon/session-state-file.ts",
  "src/daemon/settings-history.ts",
  "src/daemon/socket-lease.ts",
  "src/daemon/socket-ownership.ts",
  "src/daemon/update-act.ts",
  "src/daemon/verbs/index.ts",
  "src/demo/play.ts",
  "src/doctor/cli.ts",
  "src/doctor/edge.ts",
  "src/doctor/font-edge.ts",
  "src/doctor/handler-probe.ts",
  "src/doctor/state-file.ts",
  "src/index.ts",
  "src/install/index.ts",
  "src/path-search.ts",
  "src/plugin-install.ts",
  "src/proc/launch.ts",
  "src/segments/autocompact-provider.ts",
  "src/segments/git.ts",
  "src/segments/pricing.ts",
  "src/source-digest.ts",
  "src/utils/atomic-write.ts",
  "src/utils/claude.ts",
  "src/utils/git-root.ts",
  "src/utils/presence.ts",
  "src/utils/transcript-fs.ts",
  "src/var-system/source-runs.ts",
];
const FS_MESSAGE =
  "Reach the disk through a Filesystem (src/disk/filesystem.ts). [LAW:effects-at-boundaries]";
const FS_MODULE = "/^(node:)?fs(\\u002Fpromises)?$/";
const FS_SYNTAX = [
  `ImportDeclaration[source.value=${FS_MODULE}]`,
  `ExportNamedDeclaration[source.value=${FS_MODULE}]`,
  `ExportAllDeclaration[source.value=${FS_MODULE}]`,
  `TSImportEqualsDeclaration[moduleReference.expression.value=${FS_MODULE}]`,
  `ImportExpression[source.value=${FS_MODULE}]`,
  `CallExpression[callee.name='require'][arguments.0.value=${FS_MODULE}]`,
].map((selector) => ({ selector, message: FS_MESSAGE }));

// [LAW:single-enforcer] A fake exists to be scripted by a test; no src file
// names one, so a stand-in cannot reach a daemon that runs for a person.
const FAKE_IMPORTS = [
  {
    group: [
      "**/spawner-fake",
      "**/spawner-fake.js",
      "**/process-probe-fake",
      "**/process-probe-fake.js",
      "**/filesystem-fake",
      "**/filesystem-fake.js",
    ],
    message: "A fake is a test's: src never imports one. [LAW:single-enforcer]",
  },
];

const OWNED_IMPORTS = {
  // The process's one launcher, built beside the host it inherits from: a
  // process main takes it from `processWorld`, and everything else is handed it.
  systemOneShotLauncher: {
    group: ["**/proc/system-launcher", "**/proc/system-launcher.js"],
    owners: ["src/host.ts"],
    message:
      "The process has its one-shot launcher: take the one you are given.",
  },
  // The composition root of the one owner that is not the process.
  systemLauncher: {
    group: ["**/proc/system-launcher", "**/proc/system-launcher.js"],
    owners: ["src/daemon/production-adapters.ts"],
    message: "A Launcher is an owner's: take the one you are handed.",
  },
  // A launcher over a Spawner other than the machine's is a test's to build.
  createOneShotLauncher: {
    group: ["**/proc/launch", "**/proc/launch.js"],
    owners: [],
    message: "A launcher over the machine is system-launcher's to build.",
  },
  createLauncher: {
    group: ["**/proc/launch", "**/proc/launch.js"],
    owners: [],
    message: "A launcher over the machine is system-launcher's to build.",
  },
  // The real disk, handed to a daemon by its adapters. The other owners still
  // reach for it ambiently, and the list only shrinks as they take it as a port.
  systemFilesystem: {
    group: ["**/disk/system-filesystem", "**/disk/system-filesystem.js"],
    owners: [
      "src/daemon/production-adapters.ts",
      "src/daemon/cache/git.ts",
      "src/daemon/config-file-store.ts",
      "src/daemon/paths.ts",
      "src/demo/dsl.ts",
      "src/plugin-install.ts",
      "src/utils/atomic-write.ts",
      "src/var-system/source-runs.ts",
    ],
    message: "A Filesystem is a daemon's: take the one you are handed.",
  },
  // The process's one real clock, built beside its host and launcher.
  systemTimekeeper: {
    group: ["**/time", "**/time.js"],
    owners: ["src/host.ts"],
    message:
      "The process has its one clock (src/host.ts): take the one you are given.",
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
  // The network a daemon prices by: production's, or the demo's own process.
  livePricing: {
    group: ["**/segments/pricing", "**/segments/pricing.js"],
    owners: ["src/daemon/production-adapters.ts", "src/demo/dsl.ts"],
    message:
      "Live pricing is built by a daemon's adapters (production-adapters.ts) or the demo's own process (demo/dsl.ts); take the one you are handed.",
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
  // Where files are: every path derives from the renderer home a process's
  // entry point parsed once (src/daemon/home.ts) and handed down. The daemon
  // process derives its record once, in server.ts, and the daemon value derives
  // what it writes from the home it is handed; the pieces below take the one
  // path they write to.
  daemonPaths: {
    group: PATHS,
    owners: ["src/daemon/server.ts", "src/daemon/daemon.ts"],
    message: "A daemon is handed its paths: take the value you are given.",
  },
  stateDir: {
    group: PATHS,
    owners: [
      "src/check.ts",
      "src/demo/dsl.ts",
      "src/demo/gallery.ts",
      "src/doctor/cli.ts",
      "src/daemon/acquire.ts",
    ],
    message: "A daemon is handed its paths: take the value you are given.",
  },
  ...Object.fromEntries(
    ["socketPath", "handlerSocketPath"].map((name) => [
      name,
      {
        group: PATHS,
        owners: [
          "src/frames-cli.ts",
          "src/bar-pane/index.ts",
          "src/doctor/handler-probe.ts",
          "src/daemon/client-transport.ts",
          "src/daemon/acquire.ts",
          "src/daemon/server.ts",
        ],
        message:
          "Only a client of the daemon, or the shell that binds it, derives its socket.",
      },
    ]),
  ),
  ...Object.fromEntries(
    ["spawnLockPath", "spawnCooldownPath", "spawnBackoffPath"].map((name) => [
      name,
      {
        group: PATHS,
        owners: ["src/daemon/acquire.ts"],
        message: "Only the client that spawns a daemon reads these.",
      },
    ]),
  ),
  // The usage store takes its cache directory as an input; the root derives it.
  cacheDir: {
    group: PATHS,
    owners: ["src/daemon/daemon.ts", "src/demo/dsl.ts"],
    message: "A daemon is handed its paths: take the value you are given.",
  },
  // The breaker's registry is the host's, not a home's: the daemon's shell
  // derives it and hands it in.
  daemonRegistryDir: {
    group: PATHS,
    owners: ["src/daemon/server.ts"],
    message: "A daemon is handed its paths: take the value you are given.",
  },
  ...Object.fromEntries(
    [
      "logPath",
      "leasePath",
      "sessionStatePath",
      "settingsHistoryPath",
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
const HOST_PROPERTIES = [
  { object: "process", property: "env", message: HOST_READ_MESSAGE },
  { object: "os", property: "homedir", message: HOST_READ_MESSAGE },
  { object: "os", property: "tmpdir", message: HOST_READ_MESSAGE },
];
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
      paths: [...CHILD_PROCESS_PATHS, ...CLOCK_IMPORT_PATHS],
      patterns: [
        ...Object.entries(OWNED_IMPORTS)
          .filter(([, { owners }]) => !owners.includes(file))
          .map(([name, { group, message }]) => ({
            group,
            importNames: [name],
            message: `${message} [LAW:single-enforcer]`,
          })),
        ...HOST_NAMED_IMPORTS,
        ...FAKE_IMPORTS,
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
      ignores: ["src/proc/**", CLOCK_FILE],
      rules: { "no-restricted-imports": restrictedImports(null) },
    },
    // src/proc/spawner.ts alone may import child_process, so the rest of
    // src/proc keeps it with the clock's paths, and the spawner only the clock's.
    {
      files: ["src/proc/**/*.{ts,mts}"],
      ignores: [SPAWNER_FILE],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [...CHILD_PROCESS_PATHS, ...CLOCK_IMPORT_PATHS],
            patterns: FAKE_IMPORTS,
          },
        ],
      },
    },
    {
      files: [SPAWNER_FILE],
      rules: {
        "no-restricted-imports": ["error", { paths: CLOCK_IMPORT_PATHS }],
      },
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
        DOMException: "readonly",
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
    ignores: [...HOST_READERS, CLOCK_FILE, ...KILL_OWNERS],
    rules: {
      "no-restricted-properties": [
        "error",
        ...HOST_PROPERTIES,
        ...CLOCK_PROPERTIES,
        KILL_PROPERTY,
      ],
    },
  },
  {
    files: KILL_OWNERS,
    rules: {
      "no-restricted-properties": [
        "error",
        ...HOST_PROPERTIES,
        ...CLOCK_PROPERTIES,
      ],
    },
  },
  {
    files: HOST_READERS,
    rules: {
      "no-restricted-properties": ["error", ...CLOCK_PROPERTIES, KILL_PROPERTY],
    },
  },
  {
    files: [CLOCK_FILE],
    rules: {
      "no-restricted-properties": ["error", ...HOST_PROPERTIES, KILL_PROPERTY],
    },
  },
  // Every file but the clock's: the timer globals, and `new Date()` with no
  // argument. The blocks after this one repeat CLOCK_SYNTAX and CLOCK_GLOBALS
  // beside their own, because a later block replaces the rule.
  {
    files: ["src/**/*.{ts,mts}"],
    ignores: [CLOCK_FILE],
    rules: {
      "no-restricted-globals": ["error", ...CLOCK_GLOBALS],
      "no-restricted-syntax": ["error", ...CLOCK_SYNTAX],
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
        ...CLOCK_SYNTAX,
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
        ...CLOCK_GLOBALS,
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
        ...CLOCK_SYNTAX,
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
        ...CLOCK_SYNTAX,
      ],
    },
  },
  // The disk rule is the core `no-restricted-syntax` under its own name, so it
  // is one block with one allowlist, and a block that sets its own
  // `no-restricted-syntax` above neither drops it nor has to repeat it.
  {
    files: ["src/**/*.{ts,mts}"],
    ignores: [FILESYSTEM_FILE, ...FS_READERS],
    plugins: {
      disk: { rules: { "no-fs": builtinRules.get("no-restricted-syntax") } },
    },
    rules: { "disk/no-fs": ["error", ...FS_SYNTAX] },
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
