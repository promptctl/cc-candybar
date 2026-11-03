import type { ProcessProbe } from "../../src/daemon/process-fingerprint";

// What a test of a ProcessProbe needs from its subject: a probe, and processes
// of the states a case asks about.
export interface Subject {
  readonly probe: ProcessProbe;
  // A process that is running and can be read.
  readonly live: () => Promise<number>;
  // A pid that belonged to a process that has ended.
  readonly gone: () => Promise<number>;
}

// [LAW:one-source-of-truth] What a ProcessProbe promises, stated once. The fake
// (test/unit/process-probe-fake.test.ts) and the system probe
// (test/integration/system-probe.test.ts) both run it, so a decision that a unit
// test makes over the fake holds on the machine.
export function processProbeContract(name: string, make: () => Subject): void {
  describe(`${name} is a ProcessProbe`, () => {
    test("a running process is alive and an ended one is not", async () => {
      const { probe, live, gone } = make();
      expect(probe.alive(await live())).toBe(true);
      expect(probe.alive(await gone())).toBe(false);
    });

    test("a running process has a start time, the same on every read", async () => {
      const { probe, live } = make();
      const pid = await live();
      const first = await probe.startTime(pid);
      const second = await probe.startTime(pid);
      expect(first.kind).toBe("start");
      expect(second).toEqual(first);
    });

    test("an ended process has no start time, and says it is unavailable", async () => {
      const { probe, gone } = make();
      const read = await probe.startTime(await gone());
      expect(read.kind).toBe("unavailable");
    });
  });
}
