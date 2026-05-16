import {
  launch,
  launchDetachedSync,
  launchSync,
  setLaunchStats,
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
});

describe("launch (async)", () => {
  it("captures stdout from a zero-exit binary", async () => {
    const r = await launch({ bin: "/bin/echo", args: ["hi"], category: "tmux" });
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
    const r = await launch({ bin: "/nonexistent/binary-x9k7", category: "tmux" });
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
    const r = launchSync({ bin: "/bin/echo", args: ["sync"], category: "terminal-width" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stdout.trim()).toBe("sync");
    }
  });

  it("reports non-zero exits as data", () => {
    const r = launchSync({ bin: "/bin/sh", args: ["-c", "exit 3"], category: "terminal-width" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(3);
    }
  });

  it("meters via the stats handle", () => {
    const { handle, starts, ends } = makeSpyHandle();
    setLaunchStats(handle);
    launchSync({ bin: "/bin/echo", args: ["m"], category: "terminal-width" });
    expect(starts).toEqual(["terminal-width"]);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.category).toBe("terminal-width");
  });
});

describe("launchDetachedSync", () => {
  it("returns ok synchronously and does not wait for the child", () => {
    const r = launchDetachedSync({
      bin: "/bin/sh",
      args: ["-c", "sleep 5"],
      detached: true,
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
      detached: true,
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
      detached: true,
      category: "daemon-spawn",
    });
    expect(starts).toEqual(["daemon-spawn"]);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.category).toBe("daemon-spawn");
  });
});
