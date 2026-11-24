// Installs the unit project's refusal (test/helpers/unit-refusal.ts) on the
// sandbox only: jest.doMock covers the modules a test and the code under test
// require, while jest's own runtime keeps the real ones. The routes it guards
// are test/helpers/unit-refusal-routes.ts, and nothing here names one.

import path from "node:path";

import { IGNORED_ENV } from "./helpers/package-files";
import { MODULES, routesIn, type Guarding, type Route } from "./helpers/unit-refusal-routes";
import { allows, refusal, type Call, type PackageFiles, type Surface } from "./helpers/unit-refusal";

// [LAW:no-silent-failure] Without the answer, every ignored path would read as
// the package's own, so a run that lost it stops here.
const ignoredPaths = process.env[IGNORED_ENV];
if (ignoredPaths === undefined) {
  throw new Error(`${IGNORED_ENV} is unset: the unit project runs through jest.unit.config.js, whose global setup sets it`);
}
const FILES: PackageFiles = { root: path.resolve(__dirname, ".."), ignored: JSON.parse(ignoredPaths) as string[] };

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

// `made` maps each real function met on the way to its guard, because a carried
// property can point back at the function that holds it (the promisified form of
// fs.exists carries itself as its own promisify.custom).
function guard(surface: Surface, name: string, real: AnyFn, made = new Map<AnyFn, AnyFn>()): AnyFn {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const call: Call = { surface, call: name, args };
    if (!allows(call, FILES)) refuse(call);
    return Reflect.apply(real, this, args);
  } as unknown as AnyFn;
  made.set(real, wrapped);
  // Own properties are carried whole, symbols and non-enumerable ones included:
  // fs.exists, fs.read and fs.readv carry util.promisify.custom, and without it
  // promisify returns a different shape than production. A carried function is
  // guarded in turn, so the promisified and `.native` forms refuse like the plain one.
  for (const key of Reflect.ownKeys(real)) {
    if (Object.hasOwn(wrapped, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(real, key) as PropertyDescriptor;
    if (typeof descriptor.value === "function") {
      const carried = descriptor.value as AnyFn;
      descriptor.value = made.get(carried) ?? guard(surface, name, carried, made);
    }
    Object.defineProperty(wrapped, key, descriptor);
  }
  return wrapped;
}

function at(root: Record<string, unknown>, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);
}

// A module becomes a copy whose routes are guarded and whose everything else
// (constants, pure helpers) is the real one. Objects on the way to a route are
// copied, never written to, because the real ones are shared with jest.
function guardModule(surface: Surface, moduleName: string, real: Record<string, unknown>, guarding: Guarding) {
  const copy: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(real)) copy[key] = real[key];
  for (const route of routesIn(moduleName, real, guarding)) install(copy, real, route, surface);
  return copy;
}

function install(copy: Record<string, unknown>, real: Record<string, unknown>, route: Route, surface: Surface): void {
  const parents = route.path.slice(0, -1);
  const last = route.path[route.path.length - 1] as string;
  const holder = parents.reduce<Record<string, unknown>>((node, key) => {
    node[key] = Object.assign(Object.create(Object.getPrototypeOf(node[key])), node[key]);
    return node[key] as Record<string, unknown>;
  }, copy);
  const value = at(real, route.path);
  holder[last] =
    route.kind === "class"
      ? new Proxy(value as object, { construct: () => refuse({ surface, call: route.call, args: [] }) })
      : isScheduler(route)
        ? refusing(surface, route.call)
        : guard(surface, route.call, value as AnyFn);
}

const isScheduler = (route: Route) => route.path[0] === "scheduler";

for (const [surface, name, guarding] of MODULES) {
  const mocked = guardModule(surface, name, jest.requireActual<Record<string, unknown>>(name), guarding);
  jest.doMock(name, () => mocked);
  jest.doMock(`node:${name}`, () => mocked);
}
// What the setup files loaded before this one is bound to the real modules, and
// the registry would hand that copy to the file under test. Empty it, so every
// require from here on is evaluated against the guards.
jest.resetModules();

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
if (g.WebSocket !== undefined) g.WebSocket = new Proxy(g.WebSocket as object, { construct: () => refuse({ surface: "network", call: "new WebSocket", args: [] }) });

for (const timer of ["setTimeout", "setInterval", "setImmediate"]) {
  guardGlobal(timer, refusing("clock", timer));
}

// Date, performance and AbortSignal are shared with jest, so a guard is never
// written into them: a proxy shows the guard where the native clock member is.
// A value the test sets (jest.spyOn(Date, "now"), fake timers) is its own and
// shows as itself; setting the guard back, as a restore does, puts the native
// member back under the guard.
function guardMember<T extends object>(target: T, key: string, guard: unknown, handler: ProxyHandler<T> = {}): T {
  const native = Reflect.get(target, key, target);
  return new Proxy(target, {
    ...handler,
    get(t, k) {
      const value = Reflect.get(t, k, t);
      return k === key && value === native ? guard : value;
    },
    set: (t, k, value) => Reflect.set(t, k, value === guard ? native : value),
  });
}

guardGlobal(
  "Date",
  guardMember(Date, "now", refusing("clock", "Date.now"), {
    construct(target, args, newTarget) {
      if (args.length === 0) refuse({ surface: "clock", call: "new Date", args });
      return Reflect.construct(target, args, newTarget);
    },
    apply: refusing("clock", "Date"),
  }),
);

g.performance = guardMember(performance, "now", refusing("clock", "performance.now"));
g.AbortSignal = guardMember(AbortSignal, "timeout", refusing("clock", "AbortSignal.timeout"));

process.uptime = refusing("clock", "process.uptime") as typeof process.uptime;
process.hrtime = Object.assign(refusing("clock", "process.hrtime"), {
  bigint: refusing("clock", "process.hrtime.bigint"),
}) as unknown as NodeJS.HRTime;
