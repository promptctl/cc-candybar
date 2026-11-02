// [LAW:one-source-of-truth] The routes the unit project refuses, as data. The
// sandbox's setup installs a guard on each (test/unit-setup.ts), the fixtures
// try each from a test (test/helpers/unit-refusal-fixtures/routes.fixture.ts),
// and test/integration/unit-refusal.test.ts requires every route to fail at its
// call. A route is a row here and nothing else, so no guard exists without a
// case that reaches it, and a deleted guard turns its case red.
//
// A list of names is the right shape because a surface is a set of Node's
// entry points, and Node names them. A route not listed is a route not refused:
// adding one is a row here.

import type { Surface } from "./unit-refusal";

export interface Guarding {
  // The module's functions that reach the surface.
  readonly functions: (key: string) => boolean;
  // Classes that reach it once constructed. A subclass is refused at its super().
  readonly classes?: readonly string[];
}

const lowercase = (key: string) => /^[a-z]/.test(key);
const among = (...keys: string[]) => (key: string) => keys.includes(key);
const lookups = (key: string) => /^(lookup|resolve|reverse)/.test(key);
const timers = among("setTimeout", "setInterval", "setImmediate");

export const MODULES: ReadonlyArray<readonly [Surface, string, Guarding]> = [
  ["filesystem", "fs", { functions: lowercase, classes: ["ReadStream", "WriteStream", "FSWatcher"] }],
  ["filesystem", "fs/promises", { functions: () => true }],
  ["child process", "child_process", { functions: lowercase, classes: ["ChildProcess"] }],
  ["child process", "worker_threads", { functions: () => false, classes: ["Worker"] }],
  ["child process", "cluster", { functions: among("fork") }],
  ["socket", "net", { functions: among("createServer", "connect", "createConnection"), classes: ["Socket", "Server", "Stream"] }],
  ["socket", "tls", { functions: among("createServer", "connect"), classes: ["TLSSocket", "Server"] }],
  ["socket", "dgram", { functions: among("createSocket"), classes: ["Socket"] }],
  ["network", "http", { functions: among("createServer", "request", "get"), classes: ["Server", "ClientRequest"] }],
  ["network", "https", { functions: among("createServer", "request", "get"), classes: ["Server"] }],
  ["network", "http2", { functions: among("createServer", "createSecureServer", "connect") }],
  ["network", "dns", { functions: lookups, classes: ["Resolver"] }],
  ["network", "dns/promises", { functions: lookups, classes: ["Resolver"] }],
  ["clock", "os", { functions: among("uptime") }],
  // Jest's fake timers install on the sandbox's globals and leave these
  // modules on real time, so nothing here has a fake to defer to.
  ["clock", "timers", { functions: timers }],
  ["clock", "timers/promises", { functions: timers }],
];

export type RouteKind = "function" | "class";

export interface Route {
  // As the refusal prints it: fs.writeFileSync, new net.Socket.
  readonly call: string;
  readonly kind: RouteKind;
  // Where it sits in the module: ["writeFileSync"], ["promises", "readFile"].
  readonly path: readonly string[];
}

// The routes of a module, read off the module itself so the proof and the guard
// are cut from the same object. A module's `promises` object is walked as a
// module of the same surface, and timers/promises' scheduler is two routes.
export function routesIn(
  moduleName: string,
  real: Record<string, unknown>,
  { functions, classes = [] }: Guarding,
  path: readonly string[] = [],
): Route[] {
  return Object.getOwnPropertyNames(real).flatMap((key): Route[] => {
    const value = real[key];
    const call = `${moduleName}.${key}`;
    if (classes.includes(key)) return [{ call: `new ${call}`, kind: "class", path: [...path, key] }];
    if (typeof value === "function" && functions(key)) return [{ call, kind: "function", path: [...path, key] }];
    if (key === "promises" && typeof value === "object" && value !== null) {
      return routesIn(call, value as Record<string, unknown>, { functions, classes }, [...path, key]);
    }
    if (key === "scheduler" && moduleName === "timers/promises") {
      return ["wait", "yield"].map((name) => ({ call: `${call}.${name}`, kind: "function", path: [...path, key, name] }));
    }
    return [];
  });
}
