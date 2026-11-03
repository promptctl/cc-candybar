// [LAW:effects-at-boundaries] An in-memory `Spawner`: the children a test
// scripts, on the clock it hands in. Launch decisions (timeout, abort, output
// bound, rate limit, scope refusal) live in launch.ts and run unchanged over it,
// so a test of one holds a clock and advances it instead of waiting for a
// process. Only the fake assembly and tests import this; the contract in
// test/contract/spawner.contract.ts is what lets a test trust it.
//
// A program is registered by what it does, as data (`Behaviour`), not by how a
// shell would do it. A program nobody registered does not exist: the spawn fails
// as a missing binary does, so a test cannot launch something it did not script.

import { EventEmitter } from "node:events";
import { PassThrough, Writable, type Readable } from "node:stream";
import type { Timekeeper } from "../time";
import type { SpawnedChild, Spawner } from "./spawner";

// Read off the port, so this file names nothing of the OS's module.
type SpawnOptions = Parameters<Spawner["spawn"]>[2];
type SpawnSyncReturns = ReturnType<Spawner["spawnSync"]>;

// What a program does once started.
export interface Behaviour {
  readonly stdout?: string;
  readonly stderr?: string;
  // Writes this many bytes of stdout, past any bound a launch keeps.
  readonly floods?: number;
  // Runs this long, then exits with `exitCode`. Infinity never exits on its own.
  readonly runsFor: number;
  readonly exitCode: number;
  // Signals that do not end it: the program ignores them.
  readonly ignores?: readonly NodeJS.Signals[];
  // What reading its stdin does: `echo` writes it to stdout and exits 0 when it
  // ends; `until-end` exits 0 when it ends, writing nothing. Absent, stdin is
  // never read.
  readonly stdin?: "echo" | "until-end";
}

export const exits = (exitCode = 0, stdout = "", stderr = ""): Behaviour => ({
  stdout,
  stderr,
  runsFor: 0,
  exitCode,
});
export const runsFor = (ms: number, behaviour: Behaviour): Behaviour => ({
  ...behaviour,
  runsFor: ms,
});
export const hangs = (): Behaviour => ({
  runsFor: Infinity,
  exitCode: 0,
});
export const floods = (bytes: number): Behaviour => ({
  ...hangs(),
  floods: bytes,
});
export const ignoring = (
  signals: readonly NodeJS.Signals[],
  behaviour: Behaviour,
): Behaviour => ({ ...behaviour, ignores: signals });
export const readsStdin = (
  mode: NonNullable<Behaviour["stdin"]>,
): Behaviour => ({ ...hangs(), stdin: mode });

export type Match = (bin: string, args: readonly string[]) => boolean;
// Any invocation of this program.
export const program =
  (name: string): Match =>
  (bin) =>
    bin === name;
// `/bin/sh -c <command>`: the form every shell source launches.
export const shell =
  (command: string): Match =>
  (bin, args) =>
    bin === "/bin/sh" && args[0] === "-c" && args[1] === command;

// One start, as the test can inspect it.
export interface Spawn {
  readonly bin: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  // Undefined for a program that could not start, as for a real one.
  readonly pid: number | undefined;
  // Everything written to its stdin.
  stdin: string;
  readonly signals: NodeJS.Signals[];
  // How it ended; null while it runs.
  ended: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  } | null;
}

export interface FakeSpawner extends Spawner {
  // The most recent registration that matches a start serves it.
  program(match: Match, behaviour: Behaviour): void;
  readonly spawned: readonly Spawn[];
  // A group no spawned child leads: a pid the test names, as a recycled or
  // foreign one. `refuses` is a group whose members changed their uid, which
  // answers EPERM to every signal.
  seedGroup(pid: number, options?: { refuses?: boolean }): { end(): void };
}

interface Group {
  readonly refuses: boolean;
  ended(): boolean;
  deliver(sig: NodeJS.Signals): void;
}

const errno = (code: string, syscall: string, bin: string): Error =>
  Object.assign(new Error(`${syscall} ${bin} ${code}`), {
    code,
    syscall: `${syscall} ${bin}`,
  });

// Sockets have these; a launch calls them on the pipes it leaves open.
const pipe = (): PassThrough =>
  Object.assign(new PassThrough(), { ref() {}, unref() {} });

const whenClosed = (stream: Readable | Writable, then: () => void): void =>
  stream.closed ? then() : void stream.once("close", then);

const CHUNK = 64 * 1024;

export function fakeSpawner(clock: Timekeeper): FakeSpawner {
  const registered: Array<{ match: Match; behaviour: Behaviour }> = [];
  const spawned: Spawn[] = [];
  const groups = new Map<number, Group>();
  let nextPid = 40_000;

  const behaviourOf = (bin: string, args: readonly string[]) =>
    [...registered].reverse().find((r) => r.match(bin, args))?.behaviour;

  const stdioPiped = (options: SpawnOptions, index: number): boolean => {
    const { stdio } = options;
    const entry = Array.isArray(stdio) ? stdio[index] : stdio;
    return entry === undefined || entry === "pipe";
  };

  function start(
    bin: string,
    args: readonly string[],
    options: SpawnOptions,
  ): SpawnedChild {
    const behaviour = behaviourOf(bin, args);
    const events = new EventEmitter();
    const out = stdioPiped(options, 1) ? pipe() : null;
    const err = stdioPiped(options, 2) ? pipe() : null;
    const stdinText: Buffer[] = [];
    const inn = stdioPiped(options, 0)
      ? Object.assign(
          new Writable({
            write(chunk: Buffer, _enc, done) {
              stdinText.push(chunk);
              // Decoded whole, so a character split across chunks is not.
              record.stdin = Buffer.concat(stdinText).toString();
              done();
            },
          }),
          // As the pipes' sockets have them.
          { ref() {}, unref() {} },
        )
      : null;
    const child = Object.assign(events, {
      pid: undefined as number | undefined,
      stdin: inn,
      stdout: out,
      stderr: err,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      ref: () => child,
      unref: () => child,
    });
    const record: Spawn = {
      bin,
      args,
      options,
      pid: undefined,
      stdin: "",
      signals: [],
      ended: null,
    };

    if (behaviour === undefined) {
      // [LAW:no-silent-failure] Nothing registered it: it fails as a missing
      // binary does, never as a program that quietly succeeded.
      spawned.push(record);
      clock.after(0, () => {
        events.emit("error", errno("ENOENT", "spawn", bin));
        out?.end();
        err?.end();
        out?.resume();
        err?.resume();
        record.ended = { code: -2, signal: null };
        events.emit("close", -2, null);
      });
      return child as unknown as SpawnedChild;
    }

    const pid = nextPid++;
    child.pid = pid;
    (record as { pid: number }).pid = pid;
    spawned.push(record);
    const timers: Array<() => void> = [];
    let done = false;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      timers.forEach((clear) => clear());
      child.exitCode = code;
      child.signalCode = signal;
      record.ended = { code, signal };
      for (const s of [out, err]) {
        if (s !== null && s.listenerCount("data") === 0) s.resume();
        s?.end();
      }
      events.emit("exit", code, signal);
      // [LAW:no-ambient-temporal-coupling] `close` follows the streams', as a
      // process's does, so a reader has seen every byte by then.
      let open = [out, err].filter((s) => s !== null).length;
      const closed = () => {
        if (--open <= 0) events.emit("close", code, signal);
      };
      if (open === 0) closed();
      else for (const s of [out, err]) if (s !== null) whenClosed(s, closed);
    };
    const ending = (code: number) => clock.after(0, () => finish(code, null));

    groups.set(pid, {
      refuses: false,
      ended: () => done,
      deliver: (sig) => {
        record.signals.push(sig);
        if (done || behaviour.ignores?.includes(sig)) return;
        clock.after(0, () => finish(null, sig));
      },
    });

    timers.push(
      clock.after(0, () => {
        if (behaviour.stdout) out?.write(behaviour.stdout);
        if (behaviour.stderr) err?.write(behaviour.stderr);
        for (let left = behaviour.floods ?? 0; left > 0; left -= CHUNK) {
          out?.write(Buffer.alloc(Math.min(left, CHUNK), "x"));
        }
        if (Number.isFinite(behaviour.runsFor)) {
          timers.push(
            clock.after(behaviour.runsFor, () =>
              finish(behaviour.exitCode, null),
            ),
          );
        }
      }),
    );
    if (behaviour.stdin !== undefined && inn !== null) {
      inn.once("finish", () => {
        if (behaviour.stdin === "echo") {
          out?.write(Buffer.concat(stdinText));
        }
        timers.push(ending(0));
      });
    }
    return child as unknown as SpawnedChild;
  }

  return {
    program: (match, behaviour) => void registered.push({ match, behaviour }),
    spawned,
    seedGroup: (pid, options) => {
      let over = false;
      groups.set(pid, {
        refuses: options?.refuses ?? false,
        ended: () => over,
        deliver: () => {},
      });
      return { end: () => void (over = true) };
    },
    spawn: start,
    spawnSync: (bin, args, options): SpawnSyncReturns => {
      const behaviour = behaviourOf(bin, args);
      const none = { pid: 0, output: [null, "", ""], stdout: "", stderr: "" };
      if (behaviour === undefined) {
        return {
          ...none,
          status: null,
          signal: null,
          error: errno("ENOENT", "spawnSync", bin),
        };
      }
      if (
        !Number.isFinite(behaviour.runsFor) ||
        (options.timeout !== undefined && behaviour.runsFor > options.timeout)
      ) {
        // A blocking launch cannot wait on a clock: one that never ends has
        // only its own timeout to end it.
        if (options.timeout === undefined) {
          throw new Error(
            `spawnSync(${bin}): the program never exits and the call has no timeout, so it would block for good`,
          );
        }
        return {
          ...none,
          status: null,
          signal: "SIGTERM",
          error: errno("ETIMEDOUT", "spawnSync", bin),
        };
      }
      const input = options.input === undefined ? "" : String(options.input);
      const stdout = `${behaviour.stdout ?? ""}${behaviour.stdin === "echo" ? input : ""}`;
      const stderr = behaviour.stderr ?? "";
      return {
        pid: 0,
        output: [null, stdout, stderr],
        stdout,
        stderr,
        status: behaviour.exitCode,
        signal: null,
      };
    },
    signalGroup: (pid, sig) => {
      const group = groups.get(pid);
      if (group === undefined || group.ended()) return;
      if (group.refuses) throw errno("EPERM", "kill", String(-pid));
      group.deliver(sig);
    },
    groupGone: (pid) => groups.get(pid)?.ended() ?? true,
    signalJob: (pid, sig) => {
      const group = groups.get(pid);
      if (group === undefined || group.ended() || group.refuses) return false;
      if (sig !== 0) group.deliver(sig);
      return true;
    },
  };
}
