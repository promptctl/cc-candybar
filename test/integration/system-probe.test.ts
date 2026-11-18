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
  // [LAW:behavior-not-structure] Covers the EPERM branch: a pid another user
  // owns is no process of ours, since everything that names one of ours lives
  // under a directory only we can read. pid 1 is root's, so kill(1,0) is EPERM
  // for the non-root user this suite runs as; run as root, it is ours.
  test("a pid another user owns (EPERM) is not ours", () => {
    expect(probe.alive(1)).toBe(process.getuid?.() === 0);
  });
});
