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
// launch or a log line ownerless cannot be reached for by accident. Daemon work
// holds its daemon's launcher and log: an owner's close is what refuses the one
// and stamps the other, and neither reaches work that went around them.
const OWNED_IMPORTS = {
  // A process with no daemon, or a daemon's shell before it has one.
  processLauncher: {
    group: ["**/proc/launch", "**/proc/launch.js"],
    owners: [
      "src/bar-pane/index.ts",
      "src/check.ts",
      "src/daemon/acquire.ts",
      "src/daemon/fork-bomb-breaker.ts",
      "src/daemon/server.ts",
      "src/demo/dsl.ts",
      "src/doctor/cli.ts",
      "src/index.ts",
      "src/plugin-install.ts",
    ],
    message: "Daemon work launches through its daemon's Launcher.",
  },
  // The composition root of the one owner that is not the process.
  createLauncher: {
    group: ["**/proc/launch", "**/proc/launch.js"],
    owners: ["src/daemon/daemon.ts"],
    message: "A Launcher is an owner's: take the one you are handed.",
  },
  // The process's lines, and the daemon's log built over them.
  dlog: {
    group: ["**/log", "**/log.js"],
    owners: ["src/daemon/daemon.ts", "src/daemon/server.ts"],
    message: "Daemon work logs through its daemon's log.",
  },
};

// A file's whole rule: flat config replaces a rule per file rather than merging
// it, so each block carries the child_process paths and every name but its own.
// `patterns`, not `paths`: a path matches only the literal import string, and
// these are imported by relative spellings that differ file to file.
function restrictedImports(file) {
  return [
    "error",
    {
      paths: CHILD_PROCESS_PATHS,
      patterns: Object.entries(OWNED_IMPORTS)
        .filter(([, { owners }]) => !owners.includes(file))
        .map(([name, { group, message }]) => ({
          group,
          importNames: [name],
          message: `${message} [LAW:single-enforcer]`,
        })),
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
  // [LAW:verifiable-goals] A click-rooted path holds the daemon's loop if it
  // launches synchronously, so these cannot name the way to. Goes with the
  // launchSync half when `Launcher` drops it (candybar-launch-q7o7.4em).
  {
    files: [
      "src/daemon/verbs/**/*.ts",
      "src/daemon/reply.ts",
      "src/daemon/lane-edge.ts",
      "src/daemon/lane-setup.ts",
      "src/claude-input/**/*.ts",
      "src/doctor/edge.ts",
      "src/doctor/font-edge.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='launchSync']",
          message: "A click-rooted path awaits `launch`.",
        },
        {
          selector: "Identifier[name='runTmux']",
          message: "A click-rooted path awaits `runTmuxAsync`.",
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
