// node:child_process in the page. Every external program the daemon starts goes
// through src/proc/launch.ts; here a program is answered by the simulated
// machine's `programs` table, or fails to start as a missing binary would.
import { EventEmitter } from "events";

export interface ProgramRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
}
export type Program = (args: readonly string[], cwd: string | undefined) => ProgramRun;
export const programs = new Map<string, Program>();

const enoent = (cmd: string) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT", errno: -2, syscall: `spawn ${cmd}`, path: cmd });

class Stream extends EventEmitter {
  setEncoding() { return this; }
  pipe() { return this; }
  destroy() {}
  end() {}
  write() { return true; }
  resume() { return this; }
}

let nextPid = 5000;
export function spawn(cmd: string, args: readonly string[] = [], opts: { cwd?: string } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: nextPid++,
    stdout: new Stream(),
    stderr: new Stream(),
    stdin: new Stream(),
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    kill: () => true,
    unref: () => {},
    ref: () => {},
  });
  const program = programs.get(cmd.split("/").pop()!);
  setTimeout(() => {
    if (program === undefined) {
      child.emit("error", enoent(cmd));
      return;
    }
    const run = program(args, opts.cwd);
    if (run.stdout) child.stdout.emit("data", run.stdout);
    if (run.stderr) child.stderr.emit("data", run.stderr);
    child.exitCode = run.code;
    child.stdout.emit("end");
    child.stderr.emit("end");
    child.emit("exit", run.code, null);
    child.emit("close", run.code, null);
  }, 0);
  return child;
}

export function spawnSync(cmd: string, args: readonly string[] = [], opts: { cwd?: string } = {}) {
  const program = programs.get(cmd.split("/").pop()!);
  if (program === undefined) return { pid: 0, status: null, signal: null, stdout: "", stderr: "", output: [], error: enoent(cmd) };
  const run = program(args, opts.cwd);
  return { pid: nextPid++, status: run.code, signal: null, stdout: run.stdout, stderr: run.stderr ?? "", output: [null, run.stdout, run.stderr ?? ""] };
}

export const execFile = (cmd: string, args: readonly string[], opts: unknown, cb?: (e: Error | null, out: string, err: string) => void) => {
  const done = (typeof opts === "function" ? opts : cb) as typeof cb;
  const r = spawnSync(cmd, args);
  setTimeout(() => done?.(r.error ?? (r.status ? new Error(`exit ${r.status}`) : null), String(r.stdout), String(r.stderr)), 0);
};
export const execFileSync = (cmd: string, args: readonly string[]) => {
  const r = spawnSync(cmd, args);
  if (r.error) throw r.error;
  return r.stdout;
};
export default { spawn, spawnSync, execFile, execFileSync, programs };
