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
  test("a pid the kernel refuses to signal is not ours", () => {
    const denied = jest.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    try {
      expect(probe.alive(123)).toBe(false);
      expect(denied).toHaveBeenCalledWith(123, 0);
    } finally {
      denied.mockRestore();
    }
  });
});
