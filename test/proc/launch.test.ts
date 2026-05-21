import {
  launch,
  launchDetachedSync,
  launchSync,
  setLaunchStats,
  __resetRateLimitsForTest,
} from "../../src/proc/launch";
import type { LaunchCategory } from "../../src/proc/launch";
import type { LaunchStatsHandle } from "../../src/proc/stats-handle";

function makeSpyHandle(): {
  handle: LaunchStatsHandle;
  starts: LaunchCategory[];
  ends: Array<{ category: LaunchCategory; durationMs: number }>;
} {
  const starts: LaunchCategory[] = [];
  const ends: Array<{ category: LaunchCategory; durationMs: number }> = [];
  return {
    handle: {
      onStart: (c) => starts.push(c),
      onEnd: (c, d) => ends.push({ category: c, durationMs: d }),
    },
    starts,
    ends,
  };
}

afterEach(() => {
  setLaunchStats(null);
  __resetRateLimitsForTest();
});

describe("launch (async)", () => {
  it("captures stdout from a zero-exit binary", async () => {
    const r = await launch({ bin: "/bin/echo", args: ["hi"], category: "user-shell" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stdout.trim()).toBe("hi");
      expect(r.exitCode).toBe(0);
    }
  });

  it("reports non-zero exits as data, not throws", async () => {
    const r = await launch({ bin: "/bin/sh", args: ["-c", "exit 7"], category: "user-shell" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("non-zero");
      expect(r.exitCode).toBe(7);
    }
  });

  it("reports spawn-error for a nonexistent binary", async () => {
    const r = await launch({ bin: "/nonexistent/binary-x9k7", category: "user-shell" });
    expect(r.ok).toBe(false);
  });

  it("kills the child on timeout", async () => {
    const r = await launch({
      bin: "/bin/sh",
      args: ["-c", "sleep 5"],
      timeoutMs: 50,
      category: "user-shell",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("timeout");
      expect(r.signal).toBe("SIGTERM");
    }
  });

  it("escalates to SIGKILL and waits for death when the child ignores SIGTERM", async () => {
    // The child traps SIGTERM, so a bare SIGTERM would leave it running past
    // the frame. The promise must still resolve (not hang) and only after the
    // child is actually reaped — proving the timeout path upholds the
    // "no helper outlives its frame" invariant.
    const r = await launch({
      bin: "/bin/sh",
      args: ["-c", "trap '' TERM; sleep 5"],
      timeoutMs: 50,
      category: "user-shell",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("timeout");
      expect(r.signal).toBe("SIGKILL");
    }
  });

  it("reports signal (not timeout) when external SIGTERM kills a no-timeout child", async () => {
    // Child kills itself with SIGTERM; no timeout was set, so the close
    // must surface as "signal", not "timeout".
    const r = await launch({
      bin: "/bin/sh",
      args: ["-c", "kill -TERM $$; sleep 1"],
      category: "user-shell",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("signal");
      expect(r.signal).toBe("SIGTERM");
    }
  });

  it("pipes stdinInput to the child", async () => {
    const r = await launch({
      bin: "/bin/cat",
      stdinInput: "via stdin",
      category: "user-shell",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stdout).toBe("via stdin");
    }
  });

  it("calls onStart/onEnd exactly once per launch with the category tag", async () => {
    const { handle, starts, ends } = makeSpyHandle();
    setLaunchStats(handle);
    await launch({ bin: "/bin/echo", args: ["x"], category: "git" });
    expect(starts).toEqual(["git"]);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.category).toBe("git");
    expect(ends[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("launchSync", () => {
  it("captures stdout from a zero-exit binary", () => {
    const r = launchSync({ bin: "/bin/echo", args: ["sync"], category: "user-shell" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stdout.trim()).toBe("sync");
    }
  });

  it("reports non-zero exits as data", () => {
    const r = launchSync({ bin: "/bin/sh", args: ["-c", "exit 3"], category: "user-shell" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(3);
    }
  });

  it("meters via the stats handle", () => {
    const { handle, starts, ends } = makeSpyHandle();
    setLaunchStats(handle);
    launchSync({ bin: "/bin/echo", args: ["m"], category: "user-shell" });
    expect(starts).toEqual(["user-shell"]);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.category).toBe("user-shell");
  });
});

describe("launchDetachedSync", () => {
  it("returns ok synchronously and does not wait for the child", () => {
    const r = launchDetachedSync({
      bin: "/bin/sh",
      args: ["-c", "sleep 5"],
      category: "daemon-spawn",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.exitCode).toBeNull();
    }
  });

  it("returns spawn-error synchronously when the binary does not exist", () => {
    const r = launchDetachedSync({
      bin: "/nonexistent/daemon-x9k7",
      category: "daemon-spawn",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("spawn-error");
    }
  });

  it("meters detached launches through the stats handle", () => {
    const { handle, starts, ends } = makeSpyHandle();
    setLaunchStats(handle);
    launchDetachedSync({
      bin: "/bin/sh",
      args: ["-c", "true"],
      category: "daemon-spawn",
    });
    expect(starts).toEqual(["daemon-spawn"]);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.category).toBe("daemon-spawn");
  });
});

// [LAW:single-enforcer] Per-category rate-limit lives at the launch primitive;
// these tests pin the behavior at that boundary so callers can rely on it.
// [LAW:dataflow-not-control-flow] Rejection is a typed LaunchResult variant,
// not an exception, so callers stay on the same code path as other failures.
describe("launch — per-category rate-limit", () => {
  it("rejects a second click.pbcopy spawn inside the min interval", () => {
    const first = launchSync({
      bin: "/bin/echo",
      args: ["x"],
      category: "click.pbcopy",
    });
    expect(first.ok).toBe(true);

    const second = launchSync({
      bin: "/bin/echo",
      args: ["y"],
      category: "click.pbcopy",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("rate-limited");
      expect(second.error ?? "").toContain("click.pbcopy");
    }
  });

  it("rate-limits click.open the same way", () => {
    const first = launchSync({
      bin: "/bin/echo",
      args: ["x"],
      category: "click.open",
    });
    expect(first.ok).toBe(true);

    const second = launchSync({
      bin: "/bin/echo",
      args: ["y"],
      category: "click.open",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("rate-limited");
  });

  it("does not rate-limit categories without a configured policy", () => {
    const first = launchSync({
      bin: "/bin/echo",
      args: ["x"],
      category: "user-shell",
    });
    const second = launchSync({
      bin: "/bin/echo",
      args: ["y"],
      category: "user-shell",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("rate-limit applies to async launch as well as sync", async () => {
    const first = await launch({
      bin: "/bin/echo",
      args: ["x"],
      category: "click.pbcopy",
    });
    expect(first.ok).toBe(true);
    const second = await launch({
      bin: "/bin/echo",
      args: ["y"],
      category: "click.pbcopy",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("rate-limited");
  });

  it("rate-limited rejection does NOT record stats (no spawn happened)", () => {
    const { handle, starts, ends } = makeSpyHandle();
    setLaunchStats(handle);
    launchSync({ bin: "/bin/echo", args: ["x"], category: "click.pbcopy" });
    launchSync({ bin: "/bin/echo", args: ["y"], category: "click.pbcopy" });
    // Only the first spawn went through onStart/onEnd. The second is data,
    // not a process, and must not pollute the histograms or per-category
    // counts.
    expect(starts).toEqual(["click.pbcopy"]);
    expect(ends).toHaveLength(1);
  });

  it("rate-limited rejection happens BEFORE the binary is invoked", () => {
    // First call against a missing binary records a normal spawn-error and
    // arms the rate-limit timer. Second call must short-circuit with
    // "rate-limited" — proving the gate runs before spawn-error attribution.
    const first = launchSync({
      bin: "/nonexistent/binary-rate-x9k7",
      category: "click.pbcopy",
    });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toBe("spawn-error");

    const second = launchSync({
      bin: "/nonexistent/binary-rate-x9k7",
      category: "click.pbcopy",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("rate-limited");
  });
});
