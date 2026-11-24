import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import fs from "node:fs";
import path from "node:path";
import { JEST_GLOBALS, mayImport, mayLoadRendererModule, NO_ZONE, packageZoneOf, TEST_ROOTS, withoutExtension, ZONE_IMPORTS, zoneOf } from "./scripts/import-zones.mjs";

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
// it for a launch's groups and the ProcessProbe for a pid. The three files
// below are exceptions, each owned by the ticket that gives its program a port;
// the list may shrink and no other file joins it.
//   src/utils/cache.ts       pricing's lock holder (candybar-testing-ihvy.89p)
//   src/daemon/lane-edge.ts  SIGTERM to Claude Code (candybar-testing-ihvy.dcv)
//   src/daemon/server.ts     the daemon's own SIGKILL (the Lifetime piece)
const KILL_EXCEPTIONS = [
  "src/utils/cache.ts",
  "src/daemon/lane-edge.ts",
  "src/daemon/server.ts",
];
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

// [LAW:single-enforcer] A fake exists to be scripted by a test; no src file
// names one, so a stand-in cannot reach a daemon that runs for a person.
const FAKE_IMPORTS = [
  {
    group: [
      "**/spawner-fake",
      "**/spawner-fake.js",
      "**/process-probe-fake",
      "**/process-probe-fake.js",
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
  // The machine's bare timers, which report nothing a task throws: the process
  // world builds its one clock over them, and everything else is handed it.
  systemTimers: {
    group: ["**/time", "**/time.js"],
    owners: ["src/host.ts"],
    message: "The process world (src/host.ts) builds its clock over src/time.ts's machine timers: take the clock you are given.",
  },
  // The real adapters a daemon is handed.
  productionClaudeInputEdge: {
    group: ["**/claude-input/edge", "**/claude-input/edge.js"],
    owners: ["src/daemon/production-adapters.ts"],
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
    owners: ["src/daemon/production-adapters.ts"],
    message: "A daemon is handed its link signer (production-adapters.ts).",
  },
  // Where files are, read from the environment by a process's entry point and
  // handed down. The daemon process reads it once, in server.ts.
  daemonPaths: {
    group: PATHS,
    owners: [
      "src/daemon/server.ts",
      "src/renderer-process.ts",
    ],
    message: "A daemon is handed its paths: take the value you are given.",
  },
  stateDir: {
    group: PATHS,
    owners: [],
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

// [LAW:one-source-of-truth] Why an edge is refused, by what it reaches: what
// the zone it imports holds decides it, whichever zone imports it.
const REFUSAL = {
  renderer: "The renderer is reached only through its start (src/renderer/main.ts).",
  start: "Renderer construction is the host's and the renderer process's: shared code loads in both and imports neither side.",
  "renderer-process": "The renderer process is an entry of its own, which only the CLI starts.",
  rest: "Host code stays out of the renderer and shared code, which consume the shared contract.",
  root: "The CLI's entry dispatches to every process, and nothing imports it.",
  lib: "scripts/lib is what the tools and the tests share, and the app imports nothing from it.",
  tools: "A tool runs by hand: the app and scripts/lib import nothing from one, and what it shares lives in scripts/lib.",
  test: "The test suite runs under Jest: code that runs outside it imports nothing from test/ or from Jest, and what a tool and a test share lives in scripts/lib.",
  [NO_ZONE]: "A path no row of scripts/import-zones.mjs names is in no zone: give its root a row there, saying which side of Jest it runs on.",
  "outside the repo": "A module outside the repo is in no zone.",
};
// [LAW:no-silent-failure] Every zone an edge can be refused into has its
// reason, or the config refuses to load.
const unexplained = [...Object.keys(ZONE_IMPORTS), NO_ZONE, "outside the repo"].filter(
  (to) =>
    Object.values(ZONE_IMPORTS).some((allowed) => !allowed.includes(to)) &&
    !(to in REFUSAL),
);
if (unexplained.length > 0)
  throw new Error(`eslint.config.mjs: no refusal message for imports of ${unexplained.join(", ")}`);

// A module's key is its repo-relative path without its extension, so
// `../time.js`, `./time` and `src/time.ts` are one module, and a directory's
// import (`../verbs`) is its index's. Relative to this file, not ESLint's cwd,
// so an editor or runner started in a subdirectory keys the same modules.
const REPO_ROOT = fs.realpathSync(import.meta.dirname);
const moduleKey = (abs) => withoutExtension(path.relative(REPO_ROOT, abs));
// A directory's real path, through its nearest ancestor on disk, so an unsaved
// buffer in a directory not yet made keys like its saved self.
const realDir = (dir) =>
  fs.existsSync(dir)
    ? fs.realpathSync(dir)
    : path.join(realDir(path.dirname(dir)), path.basename(dir));

const CLOCK_KEY = withoutExtension(CLOCK_FILE);
// Whether an import brings in types alone, which carry no clock.
const typeOnly = (node) =>
  node.type === "TSImportType" ||
  node.importKind === "type" ||
  node.exportKind === "type" ||
  (node.specifiers?.length > 0 &&
    node.specifiers.every(
      (s) => s.importKind === "type" || s.exportKind === "type",
    ));

const importDirection = {
  meta: { type: "problem", schema: [] },
  create(context) {
    // Through the real path of the file's directory, so a file reached by a
    // symlinked path keys as the module it is.
    const dir = realDir(path.resolve(path.dirname(context.filename)));
    const from = moduleKey(path.join(dir, path.basename(context.filename)));
    // [LAW:no-silent-failure] A key outside the repo is in no zone, so the rule
    // refuses it rather than calling it rest and passing every edge.
    const outside = (key) => key.startsWith("..") || path.isAbsolute(key);
    if (outside(from)) {
      return {
        Program: (node) =>
          context.report({
            node,
            message: `${context.filename} is outside ${REPO_ROOT}, so it is in no zone. [LAW:one-way-deps]`,
          }),
      };
    }
    const fromZone = zoneOf(from);
    if (fromZone === NO_ZONE) {
      return {
        Program: (node) =>
          context.report({ node, message: `${from}: ${REFUSAL[NO_ZONE]} [LAW:one-way-deps]` }),
      };
    }
    const rendering = fromZone === "renderer" || fromZone === "start" || fromZone === "renderer-process";
    const check = (node, source) => {
      if (source === null) {
        context.report({
          node,
          message: `An import whose source is computed is in no zone. [LAW:one-way-deps]`,
        });
        return;
      }
      if (!source.startsWith(".") && !path.isAbsolute(source)) {
        // [LAW:one-way-deps] A package's zone is its row's, judged as a
        // path's is: Jest's are the test zone's.
        const toZone = packageZoneOf(source);
        if (!mayImport(fromZone, toZone)) {
          context.report({
            node,
            message: `${fromZone} ${from} imports ${toZone} ${source}. ${REFUSAL[toZone]} [LAW:one-way-deps]`,
          });
        }
        if (rendering && !typeOnly(node) && !mayLoadRendererModule(source, fromZone === "renderer-process")) {
          context.report({
            node,
            message: `The renderer cannot load ${source} from ${from}. [LAW:one-way-deps]`,
          });
        }
        return;
      }
      const to = moduleKey(path.resolve(dir, source));
      const toZone = outside(to) ? "outside the repo" : zoneOf(to);
      if (!mayImport(fromZone, toZone)) {
        context.report({
          node,
          message: `${fromZone} ${from} imports ${toZone} ${to}. ${REFUSAL[toZone]} [LAW:one-way-deps]`,
        });
      }
      // [LAW:effects-at-boundaries] The renderer reads no clock and sets no
      // timer: its time is the readings each input carries, and what it holds
      // for later waits for a `due`. It may name the clock's types.
      if (rendering && to === CLOCK_KEY && !typeOnly(node)) {
        context.report({
          node,
          message: `${from} imports the clock. The renderer's time is its turn's (src/renderer/turn-time.ts). [LAW:effects-at-boundaries]`,
        });
      }
    };
    // A source is a string literal or a template with nothing interpolated;
    // anything else is computed.
    const sourceOf = (node) =>
      node.type === "Literal" && typeof node.value === "string"
        ? node.value
        : node.type === "TemplateLiteral" && node.expressions.length === 0
          ? node.quasis[0].value.cooked
          : null;
    // The spellings of an edge it reads: `import`, `export … from`,
    // `import()`, the type `import("…").T`, `import x = require("…")` and a
    // call of `require` itself. A load made through another function
    // (`createRequire`, `module.require`) is not seen.
    const fromSource = (node) =>
      node.source && check(node, sourceOf(node.source));
    return {
      ImportDeclaration: fromSource,
      ExportNamedDeclaration: fromSource,
      ExportAllDeclaration: fromSource,
      ImportExpression: fromSource,
      TSImportType: (node) => check(node, sourceOf(node.source)),
      TSExternalModuleReference: (node) =>
        check(node, sourceOf(node.expression)),
      "CallExpression[callee.type='Identifier'][callee.name='require']": (
        node,
      ) => check(node, node.arguments[0] ? sourceOf(node.arguments[0]) : null),
    };
  },
};

// The one import-direction rule: src's config runs it, and so does the tools'
// (eslint.tools.config.mjs). [LAW:single-enforcer]
export const zonesPlugin = { rules: { "import-direction": importDirection } };

// [LAW:effects-at-boundaries] The renderer opens no file: every fact it reads
// arrives in its inputs, so a renderer that opened one would read a disk its
// host never chose and no snapshot recorded.
const RENDERER_GLOB = "src/renderer/**/*.{ts,mts}";
const RENDERER_FS_PATHS = [
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
].map((name) => ({
  name,
  message:
    "The renderer opens no file: what it reads is handed in (config snapshots, world state). [LAW:effects-at-boundaries]",
}));
const zonePathsOf = (file) =>
  file.startsWith("src/renderer/") ? RENDERER_FS_PATHS : [];

const ownedPattern = (name) => ({
  group: OWNED_IMPORTS[name].group,
  importNames: [name],
  message: `${OWNED_IMPORTS[name].message} [LAW:single-enforcer]`,
});

// A file's whole rule: flat config replaces a rule per file rather than merging
// it, so each block carries the child_process paths and every name but its own.
// `patterns`, not `paths`: a path matches only the literal import string, and
// these are imported by relative spellings that differ file to file. A
// renderer file's block carries the disk's paths beside them.
function restrictedImports(file, zonePaths = []) {
  return [
    "error",
    {
      paths: [...CHILD_PROCESS_PATHS, ...CLOCK_IMPORT_PATHS, ...zonePaths],
      patterns: [
        ...Object.keys(OWNED_IMPORTS)
          .filter((name) => !OWNED_IMPORTS[name].owners.includes(file))
          .map(ownedPattern),
        ...HOST_NAMED_IMPORTS,
        ...FAKE_IMPORTS,
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
    {
      files: [RENDERER_GLOB],
      rules: {
        "no-restricted-imports": restrictedImports(null, RENDERER_FS_PATHS),
      },
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
            patterns: [...FAKE_IMPORTS, ownedPattern("systemTimers")],
          },
        ],
      },
    },
    {
      files: [SPAWNER_FILE],
      rules: {
        "no-restricted-imports": [
          "error",
          { paths: CLOCK_IMPORT_PATHS, patterns: [ownedPattern("systemTimers")] },
        ],
      },
    },
    ...owners.map((file) => ({
      files: [file],
      rules: {
        "no-restricted-imports": restrictedImports(file, zonePathsOf(file)),
      },
    })),
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
      // tsc refuses a name declared twice, and this rule reads each overload
      // signature of a function as one.
      "no-redeclare": "off",
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
  // [LAW:one-way-deps] Jest's globals are the test zone's: an editor linting a
  // test with this config knows them, and in the app each is undefined.
  {
    files: TEST_ROOTS.map((root) => `${root}**/*.{ts,mts}`),
    languageOptions: {
      globals: Object.fromEntries(JEST_GLOBALS.map((name) => [name, "readonly"])),
    },
  },
  prettierConfig,
  ...ownedImportBlocks(),
  // [LAW:no-silent-failure] A promise nobody awaits is a task: the clock's
  // `detach` runs it and reports what it throws, so `void` is no way out, and
  // a promise handed where a callback's return is dropped is refused too.
  {
    files: ["src/**/*.{ts,mts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["src/**/*.{ts,mts,js,mjs,cjs}"],
    plugins: { zones: zonesPlugin },
    rules: { "zones/import-direction": "error" },
  },
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
      "src/renderer/**/*.ts",
      "src/claude-input/**/*.ts",
      "src/segments/**/*.ts",
      "src/var-system/**/*.ts",
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
        {
          selector: "ImportDeclaration[source.value=/^(node:)?fs$/]",
          message: "Take the disk from the daemon's inputs.",
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
