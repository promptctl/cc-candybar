import { fakeProbe } from "../../src/daemon/process-probe-fake";
import { processProbeContract } from "../contract/process-probe.contract";

processProbeContract("the fake probe", () => {
  const probe = fakeProbe();
  probe.start(10, "Mon Jan  1 00:00:00 2024");
  probe.start(11, "Mon Jan  1 00:00:01 2024");
  probe.end(11);
  return { probe, live: async () => 10, gone: async () => 11 };
});

describe("the fake probe", () => {
  test("a process ps cannot read is alive to a signal and unavailable to a read", async () => {
    const probe = fakeProbe();
    probe.start(7, null);
    expect(probe.alive(7)).toBe(true);
    expect((await probe.startTime(7)).kind).toBe("unavailable");
  });

  test("a pid nobody started is neither alive nor readable", async () => {
    const probe = fakeProbe();
    expect(probe.alive(99)).toBe(false);
    expect((await probe.startTime(99)).kind).toBe("unavailable");
  });
});
