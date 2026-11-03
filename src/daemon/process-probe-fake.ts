// [LAW:effects-at-boundaries] An in-memory `ProcessProbe`: the processes a test
// names, and nothing else. Only the fake assembly and tests import it; the
// contract in test/contract/process-probe.contract.ts is what lets a test trust
// it.

import type { ProcessProbe, StartTimeRead } from "./process-fingerprint";

export interface FakeProbe extends ProcessProbe {
  // A process is there. `startTime` null is one `ps` cannot read (a hardened
  // `/proc`, a permission refusal): alive to a signal, unavailable to a read.
  start(pid: number, startTime: string | null): void;
  // The process ended; its pid answers neither.
  end(pid: number): void;
}

export function fakeProbe(): FakeProbe {
  const table = new Map<number, string | null>();
  return {
    start: (pid, startTime) => void table.set(pid, startTime),
    end: (pid) => void table.delete(pid),
    alive: (pid) => table.has(pid),
    startTime: async (pid): Promise<StartTimeRead> => {
      const token = table.get(pid);
      return token === undefined || token === null
        ? {
            kind: "unavailable",
            detail: `fake probe: no start time for ${pid}`,
          }
        : { kind: "start", token };
    },
  };
}
