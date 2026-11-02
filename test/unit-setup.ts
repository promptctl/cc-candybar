// Installs the unit project's refusal (test/helpers/unit-refusal.ts) on the
// sandbox only: jest.doMock covers the modules a test and the code under test
// require, while jest's own runtime keeps the real ones.

import path from "node:path";

import { allows, refusal, type Call, type Surface } from "./helpers/unit-refusal";

const ROOT = path.resolve(__dirname, "..");

// [LAW:no-silent-failure] Every refusal is kept until the test ends, because
// code under test that catches the thrown error would otherwise pass a test
// that reached the disk.
const refused: string[] = [];

function refuse(call: Call): never {
  const message = refusal(call, expect.getState().currentTestName);
  refused.push(message);
  throw new Error(message);
}

function failOnRefusals(): void {
  const seen = refused.splice(0);
  if (seen.length > 0) {
    throw new Error(`${seen.length} call(s) refused in this test, whether or not the code caught them. First: ${seen[0]}`);
  }
}

afterEach(failOnRefusals);
afterAll(failOnRefusals);

const refusing = (surface: Surface, call: string) => () => refuse({ surface, call, args: [] });

type AnyFn = (...args: never[]) => unknown;

function guard(surface: Surface, name: string, real: AnyFn): AnyFn {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const call: Call = { surface, call: name, args };
    if (!allows(call, ROOT)) refuse(call);
    return Reflect.apply(real, this, args);
  } as unknown as AnyFn;
  return Object.assign(wrapped, real);
}

interface Guarding {
  // The module's functions that reach the surface.
  readonly functions: (key: string) => boolean;
  // Classes that reach it once constructed. A subclass is refused at its super().
  readonly classes?: readonly string[];
}

// A module becomes a copy whose named functions and classes are guarded and
// whose everything else (constants, pure helpers) is the real one.
function guardModule(
  surface: Surface,
  moduleName: string,
  real: Record<string, unknown>,
  { functions, classes = [] }: Guarding,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(real)) {
    const value = real[key];
    const name = `${moduleName}.${key}`;
    if (classes.includes(key)) {
      copy[key] = new Proxy(value as object, { construct: () => refuse({ surface, call: `new ${name}`, args: [] }) });
    } else if (typeof value === "function" && functions(key)) {
      copy[key] = guard(surface, name, value as AnyFn);
    } else if (key === "promises" && typeof value === "object" && value !== null) {
      copy[key] = guardModule("filesystem", "fs.promises", value as Record<string, unknown>, { functions: () => true });
    } else if (key === "scheduler" && moduleName === "timers/promises") {
      copy[key] = { wait: refusing(surface, `${name}.wait`), yield: refusing(surface, `${name}.yield`) };
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

const lowercase = (key: string) => /^[a-z]/.test(key);
const among = (...keys: string[]) => (key: string) => keys.includes(key);
const lookups = (key: string) => /^(lookup|resolve|reverse)/.test(key);
const timers = among("setTimeout", "setInterval", "setImmediate");

const MODULES: Array<[Surface, string, Guarding]> = [
  ["filesystem", "fs", { functions: lowercase, classes: ["WriteStream", "FSWatcher"] }],
  ["filesystem", "fs/promises", { functions: () => true }],
  ["child process", "child_process", { functions: lowercase, classes: ["ChildProcess"] }],
  ["socket", "net", { functions: among("createServer", "connect", "createConnection"), classes: ["Socket", "Server"] }],
  ["socket", "tls", { functions: among("createServer", "connect"), classes: ["TLSSocket", "Server"] }],
  ["socket", "dgram", { functions: among("createSocket"), classes: ["Socket"] }],
  ["network", "http", { functions: among("createServer", "request", "get"), classes: ["Server"] }],
  ["network", "https", { functions: among("createServer", "request", "get"), classes: ["Server"] }],
  ["network", "http2", { functions: among("createServer", "createSecureServer", "connect") }],
  ["network", "dns", { functions: lookups }],
  ["network", "dns/promises", { functions: lookups }],
  // Jest's fake timers install on the sandbox's globals and leave these
  // modules on real time, so nothing here has a fake to defer to.
  ["clock", "timers", { functions: timers }],
  ["clock", "timers/promises", { functions: timers }],
];

for (const [surface, name, guarding] of MODULES) {
  const mocked = guardModule(surface, name, jest.requireActual<Record<string, unknown>>(name), guarding);
  jest.doMock(name, () => mocked);
  jest.doMock(`node:${name}`, () => mocked);
}

// The clock's globals. Fake timers assign over them and, on useRealTimers,
// assign back what they read at install, which is the native function and not
// the guard. A property that turns the native value back into the guard keeps
// the refusal for the rest of the file; any other value is the test's own fake.
const g = globalThis as unknown as Record<string, unknown>;

function guardGlobal(key: string, guard: unknown): void {
  const native = g[key];
  let slot = guard;
  Object.defineProperty(globalThis, key, {
    configurable: true,
    enumerable: true,
    get: () => slot,
    set: (value) => {
      slot = value === native ? guard : value;
    },
  });
}

g.fetch = refusing("network", "fetch");

for (const timer of ["setTimeout", "setInterval", "setImmediate"]) {
  guardGlobal(timer, refusing("clock", timer));
}

const RealDate = Date;
guardGlobal(
  "Date",
  new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) refuse({ surface: "clock", call: "new Date", args });
      return Reflect.construct(target, args, newTarget);
    },
    apply: refusing("clock", "Date()"),
    get(target, key) {
      return key === "now" ? refusing("clock", "Date.now") : Reflect.get(target, key, target);
    },
  }),
);

// performance is a shared object, so a guard must never be written into it:
// fake timers read `now` through the proxy, get the guard, and write it back.
const nativeNow = performance.now;
const guardedNow = refusing("clock", "performance.now");
g.performance = new Proxy(performance, {
  get(target, key) {
    const value = Reflect.get(target, key, target);
    return key === "now" && value === nativeNow ? guardedNow : value;
  },
  set: (target, key, value) => Reflect.set(target, key, value === guardedNow ? nativeNow : value),
});

process.hrtime = Object.assign(refusing("clock", "process.hrtime"), {
  bigint: refusing("clock", "process.hrtime.bigint"),
}) as unknown as NodeJS.HRTime;
