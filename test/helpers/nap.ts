// A `sleep` a case starts as a shell's child: the shell writes the sleep's pid
// before it waits on it, so the case asks the kernel about that one process.
// A search of the machine's process table by command line (pgrep, pkill)
// answers for, and kills, whatever else matches, and another worktree's run of
// this suite starts the same `sleep`.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { shellWord } from "../../src/shell-word";
import { until } from "../../scripts/lib/until";

export interface Nap {
  // A shell command that starts the sleep in the shell's own process group,
  // records its pid, and waits on it. A signal to that group reaches it.
  readonly command: string;
  // The sleep's pid, once the shell has written it whole.
  started(): Promise<number>;
  // Ends the sleep a failed case may have left running, and nothing else. A
  // shell that never started it left nothing to end.
  end(): void;
}

export function nap(dir: string, seconds: number): Nap {
  const file = path.join(dir, `nap-${crypto.randomUUID()}.pid`);
  // A whole line: the shell's redirect makes the file before it writes the pid.
  const written = (): number | null => {
    const line = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const pid = /^(\d+)\n$/.exec(line)?.[1];
    return pid === undefined ? null : Number(pid);
  };
  return {
    command: `sleep ${seconds} & echo $! > ${shellWord(file)}; wait`,
    started: async () => {
      await until(() => written() !== null, `sleep ${seconds} started`);
      return written()!;
    },
    end: () => {
      const pid = written();
      if (pid !== null) signalled(pid, "SIGKILL");
    },
  };
}

// Whether the process was there to take the signal.
// [LAW:no-silent-failure] Only ESRCH is "gone"; any other refusal is a fault.
function signalled(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

// Signal 0 asks the kernel whether the process exists and delivers nothing.
export const running = (pid: number): boolean => signalled(pid, 0);
