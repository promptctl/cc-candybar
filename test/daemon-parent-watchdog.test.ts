import { spawn } from "node:child_process";

import {
  anchorFromEnv,
  armParentWatchdog,
  pidAlive,
  PARENT_PID_ENV,
} from "../src/daemon/parent-watchdog";

// [LAW:verifiable-goals] The contract under test is the leak's negation: a
// daemon spawned by a transient process MUST die when that process dies, even
// though nothing ran its teardown — which is exactly what a SIGKILLed Jest
// leaves behind. The unit tests pin the mechanism deterministically; the
// integration test proves it end-to-end on a real daemon process.

describe("anchorFromEnv", () => {
  test("absent variable → outlives nobody (the production daemon)", () => {
    expect(anchorFromEnv({})).toEqual({ kind: "outlives-nobody" });
  });

  test("positive integer pid → anchored to it", () => {
    expect(anchorFromEnv({ [PARENT_PID_ENV]: "12345" })).toEqual({
      kind: "anchored",
      pid: 12345,
    });
  });

  test.each(["", "abc", "0", "-3"])(
    "malformed value %p throws loudly rather than silently re-opening the leak",
    (raw) => {
      expect(() => anchorFromEnv({ [PARENT_PID_ENV]: raw })).toThrow(
        PARENT_PID_ENV,
      );
    },
  );
});

describe("armParentWatchdog", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("outlives-nobody never trips and arms no timer", () => {
    const onOrphaned = jest.fn();
    const handle = armParentWatchdog({
      anchor: { kind: "outlives-nobody" },
      isAlive: () => false,
      onOrphaned,
    });
    jest.advanceTimersByTime(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
    expect(() => handle.disarm()).not.toThrow();
  });

  test("anchored + spawner alive never trips", () => {
    const onOrphaned = jest.fn();
    armParentWatchdog({
      anchor: { kind: "anchored", pid: 999 },
      isAlive: () => true,
      onOrphaned,
      intervalMs: 100,
    });
    jest.advanceTimersByTime(1_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  test("anchored + spawner gone trips with the spawner pid in the reason", () => {
    const onOrphaned = jest.fn();
    armParentWatchdog({
      anchor: { kind: "anchored", pid: 4242 },
      isAlive: () => false,
      onOrphaned,
      intervalMs: 100,
    });
    jest.advanceTimersByTime(100);
    expect(onOrphaned).toHaveBeenCalledWith(expect.stringContaining("4242"));
  });

  test("disarm stops further polling", () => {
    const onOrphaned = jest.fn();
    const handle = armParentWatchdog({
      anchor: { kind: "anchored", pid: 4242 },
      isAlive: () => false,
      onOrphaned,
      intervalMs: 100,
    });
    handle.disarm();
    jest.advanceTimersByTime(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });
});

describe("pidAlive", () => {
  test("this process is alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("an exited process is not alive", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(pidAlive(child.pid!)).toBe(false);
  });

  // [LAW:behavior-not-structure] Covers the EPERM branch (a live pid we may
  // not signal counts as alive — a reused pid must never read "dead" just
  // because it now belongs to another user). pid 1 is root-owned, so
  // kill(1,0) is EPERM for the non-root user this suite's CI runs as; either
  // way (EPERM or, running as root, a genuine successful signal) the pid IS
  // alive, so the assertion holds regardless — the behavior under test, not
  // which syscall path produced it.
  test("a live pid we may not signal (EPERM) counts as alive", () => {
    expect(pidAlive(1)).toBe(true);
  });
});
