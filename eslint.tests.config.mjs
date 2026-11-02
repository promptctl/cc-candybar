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
];
