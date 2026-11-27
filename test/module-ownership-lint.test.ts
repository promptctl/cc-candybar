// Exercise the normal owner and caller configurations at the same paths the
// application and test commands lint. The caller's alias never grants access.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "../scripts/lib/repo.cjs";
import { lintCases, missingOwnedExports } from "./helpers/lint-cases";

const host = "src/daemon/acquire.ts";
const processOwner =
  "Launch through a Launcher from src/proc/launch instead. [LAW:single-enforcer] (kz8.2)";
const systemClock =
  "The process world (src/host.ts) builds its clock over src/time.ts's machine timers: take the clock you are given. [LAW:single-enforcer]";
const hostRead =
  "Take the Host you are handed: src/host.ts reads the process once. [LAW:effects-at-boundaries]";
const fakeLauncher =
  "Script the program on a fake launcher (scripts/lib/draw-fixtures/fake-launcher.ts), or test the adapter under test/integration. [LAW:effects-at-boundaries]";
const src = (code: string, file = host) => ({ code, file });

const application = {
  ...Object.fromEntries(
    Object.entries({
      esm: 'import { spawn } from "node:child_process";',
      cjs: 'const cp = require("child_process");',
      destructure:
        'const { spawn: run } = module["require"]("node:child_process");',
      dynamic:
        'async function load() { return (await import("child_process")).spawn; }',
      qualified: 'type X = import("child_process").ChildProcess;',
      equals: 'import cp = require("node:child_process"); export { cp };',
      types: '/// <reference types="node:child_process" />',
      factory:
        'import { createRequire as make } from "node:module"; const load = make(import.meta.url); load("child_process").spawn;',
      namedBuiltin:
        "import {getBuiltinModule as grab} from 'node:process'; export const run=grab('node:child_process').spawn;",
      quotedMaker:
        "import {'createRequire' as grab} from 'node:module'; export const run=grab(import.meta.url)('child_process').spawn;",
      namespaceBuiltin:
        "import * as p from 'process'; const other=p; export const run=other.getBuiltinModule('child_process').spawn;",
      builtin:
        'const {getBuiltinModule: load} = process; load("child_process").spawn;',
    }).map(([name, code]) => [name, [src(code), processOwner] as const]),
  ),
  spawner: [
    src('export * from "node:child_process";', "src/proc/spawner.ts"),
    null,
  ],
  siblingSpawner: [
    src('export * from "node:child_process";', "src/proc/launch.ts"),
    processOwner,
  ],
  typeName: [
    src('type T = typeof import("../time").systemTimers;'),
    systemClock,
  ],
  typeSibling: [src('type T = import("../time").Timekeeper;'), null],
  clockOwner: [
    src('export const now = require("./time.js").systemTimers;', "src/host.ts"),
    null,
  ],
  sideEffect: [src('require("../time"); void import("../time");'), null],
  socketOwner: [src('export { socketPath } from "./paths";'), null],
  socketCaller: [
    src('const {socketPath} = require("./paths");', "src/daemon/limits.ts"),
    "Only a client of the daemon reads its socket from the environment. [LAW:single-enforcer]",
  ],
  computedAllowed: [
    src('import p from "node:process"; export const a = p[`pid`];'),
    null,
  ],
  sourceRoot: [
    src('export const t = require("../../src/time.js")["systemTimers"];'),
    systemClock,
  ],
  absolute: [
    src(
      `export {systemTimers} from ${JSON.stringify(path.join(REPO, "src/time.ts"))};`,
    ),
    systemClock,
  ],
  qualifiedEsm: [
    src(
      'export async function read(){return (await import("../time.ts?source")).systemTimers;}',
    ),
    systemClock,
  ],
  encodedEsm: [
    src('export {systemTimers} from "../%74ime.ts#copy";'),
    systemClock,
  ],
  fileURL: [
    src(
      `export {systemTimers} from ${JSON.stringify(pathToFileURL(path.join(REPO, "src/time.ts")).href + "?source#copy")};`,
    ),
    systemClock,
  ],
  importURLObject: [
    src(
      "export async function read(){ return (await import(new URL('../time.ts?source',import.meta.url))).systemTimers; }",
    ),
    systemClock,
  ],
  commonJsQuestionMark: [
    src('export const t=require("../time.ts?source").systemTimers;'),
    null,
  ],
  commonJsFileURL: [
    src(
      `export const t=require(${JSON.stringify(pathToFileURL(path.join(REPO, "src/time.ts")).href)}).systemTimers;`,
    ),
    null,
  ],
  dataMethod: [
    src(
      "const tools={getBuiltinModule: (name:string)=>({version:name})}; export const v=tools.getBuiltinModule('child_process').version;",
    ),
    null,
  ],
  dataDestructure: [
    src(
      "const tools={createRequire: (name:string)=>name}; const {createRequire}=tools; export const v=createRequire('child_process');",
    ),
    null,
  ],
  shadowedProcess: [
    src(
      "function main(process:{getBuiltinModule:(name:string)=>unknown}) { return process.getBuiltinModule('child_process'); }",
    ),
    null,
  ],
  builtinOnly: [
    src('export const absent=process.getBuiltinModule("../time.ts");'),
    null,
  ],
  unrelatedBasename: [
    src('export const t = require("./not-our/time.js").systemTimers;'),
    null,
  ],
  star: [src('export * from "../time";'), systemClock],
  unknownKey: [
    src(
      'const data = require("../time"); function get(key: string) { return data[key]; }',
    ),
    systemClock,
  ],
  qualifiedNamespace: [
    src('import * as clock from "../time"; type T = clock.Timekeeper;'),
    null,
  ],
  exportedNamespace: [
    src('export const clock = require("../time"); void clock.clockOver;'),
    systemClock,
  ],
  aliasedSelection: [
    src(
      'const p = require("../time"); const other = p; export const {clockOver: makeClock} = other;',
    ),
    null,
  ],
  localBinding: [
    src(
      'function run(require: (x: string) => string) { return require("node:child_process"); }',
    ),
    null,
  ],
  rest: [
    src('const {clockOver, ...others} = require("../time");'),
    systemClock,
  ],
  awaitAllowed: [
    src(
      'async function f() { const { clockOver } = await import("../time"); return clockOver; }',
    ),
    null,
  ],
  promiseEscapes: [
    src('const p = import("../time"); p.then(use);'),
    systemClock,
  ],
  disk: [
    src(
      'export const read = require("fs/promises").readFile;',
      "src/renderer/draw-bar.ts",
    ),
    "The renderer opens no file: what it reads is handed in (config snapshots, world state). [LAW:effects-at-boundaries]",
  ],
  daemonDisk: [
    src(
      'export const read = require("node:fs").readFile;',
      "src/daemon/daemon.ts",
    ),
    "Take the disk from the daemon's inputs.",
  ],
  clockTypeAtRenderer: [
    src('type T = import("../time").Timekeeper;', "src/renderer/draw-bar.ts"),
    null,
  ],
  nativeAlias: [
    src(
      'import p from "process"; const alias = p; export const e = alias["env"];',
    ),
    hostRead,
  ],
  permittedProcess: [
    src('import p from "node:process"; export const log = p.stdout;'),
    null,
  ],
  defaultProjection: [
    src(
      'const {default: os} = await import("node:os"); export const x = os.userInfo;',
    ),
    null,
  ],
  reexportedDefaultBinding: [
    src('export const { default: p } = await import("process"); void p.pid;'),
    hostRead,
  ],
  defaultEscape: [src('export {default} from "node:os";'), hostRead],
  hostMayRead: [src('import {homedir} from "os";', "src/host.ts"), null],
  fake: [
    src('type X = typeof import("../proc/spawner-fake");'),
    "A fake is a test's: src never imports one. [LAW:single-enforcer]",
  ],
  adapter: [
    src(
      'export {realLimitsDeps} from "./limits";',
      "src/daemon/production-adapters.ts",
    ),
    null,
  ],
  indexedAllowed: [
    src('type A = (typeof import("../time"))["clockOver"];'),
    null,
  ],
  indexedDenied: [
    src('type A = (typeof import("../time"))["systemTimers"];'),
    systemClock,
  ],
  rendererTypeEquals: [
    src(
      'import type t = require("../time"); export type C = t.Timekeeper;',
      "src/renderer/draw-bar.ts",
    ),
    null,
  ],
  realPaneAdapter: [
    src("export {productionBarPaneEdge} from './lane-edge.js';"),
    "A daemon is handed its adapters (production-adapters.ts).",
  ],
  actualLinkKey: [
    src("export {linkKeyFromFile} from './link-key.js';"),
    "A daemon is handed its link signer (production-adapters.ts).",
  ],
  adapterOwner: [
    src(
      "export {productionBarPaneEdge} from './lane-edge.js'; export {linkKeyFromFile} from './link-key.js';",
      "src/daemon/production-adapters.ts",
    ),
    null,
  ],
  derivedLease: [
    src("export {leasePathFor} from './paths.js';", "src/daemon/server.ts"),
    null,
  ],
  restrictedAdapter: [
    src('export {realLimitsDeps} from "./limits";'),
    "A daemon is handed its adapters (production-adapters.ts). [LAW:single-enforcer]",
  ],
} satisfies Record<string, readonly [ReturnType<typeof src>, string | null]>;

const testFile = (code: string, file = "test/clock-lint-rule.test.ts") => ({
  file,
  code,
});
const suite = {
  esm: [
    testFile('import {fixtureLauncher} from "./helpers/host";'),
    fakeLauncher,
  ],
  cjs: [
    testFile('const {fixtureLauncher} = require("./helpers/host.js");'),
    fakeLauncher,
  ],
  namespaced: [testFile('export * from "./helpers/host";'), fakeLauncher],
  native: [
    testFile('const x = (await import("../src/proc/spawner")).systemSpawner;'),
    fakeLauncher,
  ],
  type: [
    testFile('type X = typeof import("./helpers/host").fixtureLauncher;'),
    fakeLauncher,
  ],
  allowed: [testFile('const x = require("./helpers/host").hostOf;'), null],
  urlBase: [
    testFile(
      "import {createRequire as make} from 'node:module'; const load=make(new URL(import.meta.url)); export const effect=load('../src/proc/system-launcher').systemLauncher;",
    ),
    fakeLauncher,
  ],
  relativeURLBase: [
    testFile(
      "import {createRequire} from 'node:module'; const load=createRequire(new URL('../src/daemon/some.js',import.meta.url)); export const effect=load('../proc/system-launcher').systemLauncher;",
    ),
    fakeLauncher,
  ],
  absoluteURLBase: [
    testFile(
      `import {createRequire} from 'node:module'; const load=createRequire(${JSON.stringify(pathToFileURL(path.join(REPO, "test/file.js")).href)}); export const effect=load('../src/proc/system-launcher').systemLauncher;`,
    ),
    fakeLauncher,
  ],
  relocatedBase: [
    testFile(
      "import {createRequire} from 'node:module'; const load=createRequire(new URL('../src/proc/',import.meta.url)); export const other=load('../src/proc/system-launcher').systemLauncher;",
    ),
    null,
  ],
  scoped: [
    testFile(
      'const x = require("../helpers/host").fixtureLauncher;',
      "test/integration/unit-refusal.test.ts",
    ),
    null,
  ],
  sameName: [testFile('const x = require("./host").fixtureLauncher;'), null],
  sharedTools: [
    testFile(
      'export {systemLauncher} from "../../src/proc/system-launcher";',
      "scripts/lib/until.ts",
    ),
    fakeLauncher,
  ],
} satisfies Record<string, readonly [ReturnType<typeof src>, string | null]>;

function verify(
  cases: Record<string, readonly [ReturnType<typeof src>, string | null]>,
  options: object,
) {
  const messages = lintCases(
    Object.fromEntries(
      Object.entries(cases).map(([name, [input]]) => [name, input]),
    ),
    options,
  );
  for (const [name, [, reason]] of Object.entries(cases)) {
    expect({
      [name]: messages[name]!.filter((m) => m.ruleId === null),
    }).toEqual({ [name]: [] });
    const owned = messages[name]!.filter(
      (m) =>
        m.ruleId === "zones/import-direction" &&
        !m.message.includes("[LAW:one-way-deps]"),
    );
    expect({ [name]: owned.map((m) => m.message) }).toEqual({
      [name]: reason ? [expect.stringContaining(reason)] : [],
    });
  }
}

test("every named owner protects an export its module actually supplies", () => {
  expect(missingOwnedExports()).toEqual([]);
});

test("the resolved module and its selected exports identify the owner", () =>
  verify(application, {}));
test("suite ownership follows the same edges with its own native adapters", () =>
  verify(suite, { overrideConfigFile: "eslint.tests.config.mjs" }));

test("a tool can use its own launcher outside the application and suite", () => {
  verify(
    {
      tool: [
        src(
          'export const spawn = require("node:child_process").spawn;',
          "scripts/drive-bar.ts",
        ),
        null,
      ],
    },
    { overrideConfigFile: "eslint.tools.config.mjs" },
  );
});

test("the native adapter still cannot mutate the worker environment", () => {
  const cases = {
    adapter: testFile(
      'process.env.UNSAFE = "changed";',
      "test/integration/unit-refusal.test.ts",
    ),
  };
  const messages = lintCases(cases, {
    overrideConfigFile: "eslint.tests.config.mjs",
  });
  expect(messages.adapter).toContainEqual(
    expect.objectContaining({
      ruleId: "no-restricted-syntax",
      message: expect.stringContaining("Hand src a Host"),
    }),
  );
});

test("a suite's recognized relative loader with unknown base has no accountable owner", () => {
  const messages = lintCases(
    {
      unknown: testFile(
        "import {createRequire} from 'node:module'; const load=createRequire(process.cwd()); export const x=load('./system-launcher').systemLauncher;",
      ),
      shadow: testFile(
        "import {createRequire} from 'node:module'; export function f(URL:typeof globalThis.URL){return createRequire(new URL(import.meta.url))('./system-launcher').systemLauncher;}",
      ),
      absolute: testFile(
        `import {createRequire} from 'node:module'; export const x=createRequire(process.cwd())(${JSON.stringify(path.join(REPO, "src/proc/system-launcher"))}).systemLauncher;`,
      ),
    },
    { overrideConfigFile: "eslint.tests.config.mjs" },
  );
  for (const name of ["unknown", "shadow"] as const)
    expect(
      messages[name]
        ?.filter((m) => m.ruleId === "zones/import-direction")
        .map((m) => m.message),
    ).toEqual([expect.stringContaining("A loader whose base is computed")]);
  expect(
    messages.absolute
      ?.filter((m) => m.ruleId === "zones/import-direction")
      .map((m) => m.message),
  ).toEqual([expect.stringContaining(fakeLauncher)]);
});
