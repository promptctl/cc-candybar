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

function guard<F extends (...args: never[]) => unknown>(surface: Surface, name: string, real: F): F {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const call: Call = { surface, call: name, args };
    if (!allows(call, ROOT)) refuse(call);
    return Reflect.apply(real, this, args);
  } as unknown as F;
  return Object.assign(wrapped, real);
}

// A module becomes a copy whose named functions are guarded and whose
// everything else (classes, constants) is the real one.
function guardModule(
  surface: Surface,
  moduleName: string,
  real: Record<string, unknown>,
  names: (key: string) => boolean,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(real)) {
    const value = real[key];
    if (typeof value === "function" && names(key)) {
      copy[key] = guard(surface, `${moduleName}.${key}`, value as (...a: never[]) => unknown);
    } else if (key === "promises" && typeof value === "object" && value !== null) {
      copy[key] = guardModule("filesystem", "fs.promises", value as Record<string, unknown>, () => true);
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

const lowercase = (key: string) => /^[a-z]/.test(key);
const among = (...keys: string[]) => (key: string) => keys.includes(key);

const MODULES: Array<[Surface, string, (key: string) => boolean]> = [
  ["filesystem", "fs", lowercase],
  ["filesystem", "fs/promises", () => true],
  ["child process", "child_process", lowercase],
  ["socket", "net", among("createServer", "connect", "createConnection")],
  ["socket", "tls", among("createServer", "connect")],
  ["socket", "dgram", among("createSocket")],
  ["network", "http", among("createServer", "request", "get")],
  ["network", "https", among("createServer", "request", "get")],
  ["network", "http2", among("createServer", "createSecureServer", "connect")],
  ["network", "dns", (key) => /^(lookup|resolve|reverse)/.test(key)],
];

for (const [surface, name, which] of MODULES) {
  const real = jest.requireActual<Record<string, unknown>>(name);
  const mocked = guardModule(surface, name, real, which);
  jest.doMock(name, () => mocked);
  jest.doMock(`node:${name}`, () => mocked);
}

const g = globalThis as unknown as Record<string, unknown>;
const refusing = (surface: Surface, call: string) => () => refuse({ surface, call, args: [] });

g.fetch = refusing("network", "fetch");

for (const timer of ["setTimeout", "setInterval", "setImmediate"]) {
  g[timer] = refusing("clock", timer);
}

const RealDate = Date;
g.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    if (args.length === 0) refuse({ surface: "clock", call: "new Date", args });
    return Reflect.construct(target, args, newTarget);
  },
  apply: refusing("clock", "Date()"),
  get(target, key) {
    return key === "now" ? refusing("clock", "Date.now") : Reflect.get(target, key, target);
  },
});
g.performance = new Proxy(performance, {
  get(target, key) {
    return key === "now" ? refusing("clock", "performance.now") : Reflect.get(target, key, target);
  },
});
process.hrtime = Object.assign(refusing("clock", "process.hrtime"), {
  bigint: refusing("clock", "process.hrtime.bigint"),
}) as unknown as NodeJS.HRTime;
