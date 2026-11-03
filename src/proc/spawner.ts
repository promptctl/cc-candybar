// [LAW:single-enforcer] The operating system's side of a launch: starting a
// child and signalling the process group it leads. src/proc/launch.ts holds
// every decision about a launch (its timeout, its abort, its output bound, its
// owner's gate) and reaches the OS only through a `Spawner`, so a test can run
// that code over a child it scripts (src/proc/spawner-fake.ts) instead of a
// process it waits for. This file and the fake's contract
// (test/contract/spawner.contract.ts) are the only places that name the OS.
//
// [LAW:effects-at-boundaries] The adapter below is the code launch.ts used to
// hold, moved and unchanged.

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

// The part of a child that a launch reads. A narrow type, so a fake child is
// this and not a `ChildProcess` it would have to pretend to be.
export type SpawnedChild = Pick<
  ChildProcess,
  | "pid"
  | "stdin"
  | "stdout"
  | "stderr"
  | "exitCode"
  | "signalCode"
  | "once"
  | "on"
  | "off"
  | "ref"
  | "unref"
>;

export interface Spawner {
  spawn(
    bin: string,
    args: readonly string[],
    options: SpawnOptions,
  ): SpawnedChild;
  spawnSync(
    bin: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ): SpawnSyncReturns<string>;
  // Signals a waited child's whole process group (it leads its own).
  // [LAW:no-silent-failure] exception: ESRCH is the group already gone — the
  // state this call exists to reach; any other failure propagates, but for a
  // group's EPERM that its leader does not back.
  signalGroup(pid: number, sig: NodeJS.Signals): void;
  // Whether a group has no member left, zombies included. Unlike
  // `signalJob(pid, 0)`, EPERM is not an end here: it is also the answer for a
  // live member that changed its uid, whose pipes a launch must keep reading.
  // Signal 0 to a valid group has no other errors, so anything but ESRCH is
  // that "not gone".
  groupGone(pid: number): boolean;
  // Signals a job's process group; true when the group took it. A job runs as
  // its launcher's user, so a group the launcher may not signal (EPERM) is
  // someone else's under a recycled id, on darwin holds nothing left running,
  // or holds only a member that changed its uid, which no signal of ours could
  // reach. Signal 0 asks only whether anything of it is still running.
  // [LAW:no-silent-failure] exception: the false is the whole report. `endJob`
  // hands SIGTERM's to its caller; the SIGKILL's lands in a timer with no
  // caller, and the launcher has nothing further to try either way.
  signalJob(pid: number, sig: NodeJS.Signals | 0): boolean;
}

// Darwin answers EPERM for a group with nothing left to signal: its members
// are zombies, or still in their exit teardown. That is the same answer as a
// refusal, so the leader tells them apart: only one that changed its real uid
// refuses signal 0. An ended leader answers it as a zombie, or is gone.
function leaderRefuses(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const systemSpawner: Spawner = {
  spawn: (bin, args, options) => spawn(bin, args, options),
  spawnSync: (bin, args, options) => spawnSync(bin, args, options),
  signalGroup: (pid, sig) => {
    try {
      process.kill(-pid, sig);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && !(code === "EPERM" && !leaderRefuses(pid))) {
        throw err;
      }
    }
  },
  groupGone: (pid) => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  },
  signalJob: (pid, sig) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || code === "EPERM") return false;
      throw err;
    }
  },
};
