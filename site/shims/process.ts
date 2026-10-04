// The daemon's `process` in the page: the simulated machine's environment and
// identity, and the event surface it listens on. Injected as the global
// `process` and served as node:process.
import { EventEmitter } from "events";
import { HOME } from "./os";

const started = performance.now();
const emitter = new EventEmitter();
const proc = Object.assign(emitter, {
  env: {
    HOME,
    USER: "demo",
    XDG_STATE_HOME: `${HOME}/.local/state`,
    XDG_CONFIG_HOME: `${HOME}/.config`,
    XDG_DATA_HOME: `${HOME}/.local/share`,
    PATH: "/usr/bin:/bin",
    TERM: "xterm-256color",
  } as Record<string, string | undefined>,
  argv: ["node", "cc-candybar"],
  execArgv: [] as string[],
  execPath: "/usr/bin/node",
  platform: "linux",
  arch: "x64",
  pid: 4242,
  ppid: 1,
  version: "v26.0.0",
  versions: { node: "26.0.0" },
  release: { name: "node" },
  exitCode: undefined as number | undefined,
  cwd: () => HOME,
  chdir: () => {},
  getuid: () => 1000,
  getgid: () => 1000,
  umask: () => 0o22,
  uptime: () => (performance.now() - started) / 1000,
  hrtime: Object.assign(
    (prev?: [number, number]): [number, number] => {
      const t = performance.now() * 1e6;
      const now: [number, number] = [Math.floor(t / 1e9), Math.floor(t % 1e9)];
      return prev ? [now[0] - prev[0], now[1] - prev[1]] : now;
    },
    { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
  ),
  memoryUsage: Object.assign(() => ({ rss: 64e6, heapTotal: 32e6, heapUsed: 24e6, external: 0, arrayBuffers: 0 }), { rss: () => 64e6 }),
  cpuUsage: () => ({ user: 0, system: 0 }),
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  emitWarning: (w: unknown) => console.warn(w),
  kill: (pid: number, signal?: string | number) => {
    if (signal === 0 && pid === 4242) return true;
    const e = Object.assign(new Error(`kill ESRCH`), { code: "ESRCH" });
    throw e;
  },
  exit: (code?: number) => {
    throw new Error(`process.exit(${code ?? 0}) in the page`);
  },
  stdout: { write: (s: string) => (console.log(s), true), isTTY: false, columns: 120 },
  stderr: { write: (s: string) => (console.error(s), true), isTTY: false },
});
export default proc;
export const { env, argv, platform, pid, cwd, hrtime, nextTick, memoryUsage, kill, exit, stdout, stderr } = proc;
export const on = proc.on.bind(proc);
