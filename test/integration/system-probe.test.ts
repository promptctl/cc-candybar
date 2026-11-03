import { spawn } from "node:child_process";
import { processLauncher } from "../helpers/host";
import { systemProbe } from "../../src/daemon/process-fingerprint";
import { processProbeContract } from "../contract/process-probe.contract";

const probe = systemProbe(processLauncher);

processProbeContract("the system probe", () => ({
  probe,
  live: async () => process.pid,
  gone: async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return child.pid!;
  },
}));

describe("the system probe", () => {
  // [LAW:behavior-not-structure] Covers the EPERM branch (a live pid we may
  // not signal counts as alive — a reused pid must never read "dead" just
  // because it now belongs to another user). pid 1 is root-owned, so
  // kill(1,0) is EPERM for the non-root user this suite's CI runs as; either
  // way (EPERM or, running as root, a genuine successful signal) the pid IS
  // alive, so the assertion holds regardless — the behavior under test, not
  // which syscall path produced it.
  test("a live pid we may not signal (EPERM) counts as alive", () => {
    expect(probe.alive(1)).toBe(true);
  });
});
