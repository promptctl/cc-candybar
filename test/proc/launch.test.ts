import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createLauncher,
  type LaunchCategory,
  type LaunchScope,
  type Launcher,
  type TestableLauncher,
} from "../../src/proc/launch";
import type { LaunchStatsHandle } from "../../src/proc/stats-handle";
import { until } from "../helpers/until";

function makeSpyHandle(): {
  handle: LaunchStatsHandle;
  starts: LaunchCategory[];
  ends: Array<{ category: LaunchCategory; durationMs: number }>;
  refused: LaunchCategory[];
} {
  const starts: LaunchCategory[] = [];
  const ends: Array<{ category: LaunchCategory; durationMs: number }> = [];
  const refused: LaunchCategory[] = [];
  return {
    handle: {
      onStart: (c) => starts.push(c),
      onEnd: (c, d) => ends.push({ category: c, durationMs: d }),
      onRefused: (c) => refused.push(c),
    },
    starts,
    ends,
    refused,
  };
}

// The signals the launcher sends a child's process group, in the order it
// sends them. The launcher's OS seam is process.kill on the negated pid
// (signalGroup); the signal-refused test below stands at the same seam. A
// pass-through spy records the launcher's own promise — SIGTERM first, SIGKILL
// only after the grace — independent of which signal the scheduler let the
// child die of.
function recordGroupSignals(): { sent: string[]; restore(): void } {
  const sent: string[] = [];
  const realKill = process.kill.bind(process);
  const spy = jest.spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (typeof pid === "number" && pid < 0 && typeof sig === "string") {
      sent.push(sig);
    }
    return realKill(pid, sig);
  });
  return { sent, restore: () => spy.mockRestore() };
}

// A node child that ignores SIGTERM, provably: it writes `marker` only after
// its handler is installed, so a test that awaits the marker and THEN asks for
// termination cannot race the handler — the child can die of nothing but the
// escalation's SIGKILL.
function ignoringChild(marker: string): { bin: string; args: string[] } {
  return {
    bin: process.execPath,
    args: [
      "-e",
      "process.on('SIGTERM', () => {});" +
        ` require('fs').writeFileSync(${JSON.stringify(marker)}, '');` +
        " setInterval(() => {}, 1000);",
    ],
  };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-launch-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

// The launcher a case launches through. `ending` closes it, so no case leaves
// a lifeline behind it.
let launcher: TestableLauncher;
let ending: AbortController;
const scoped = (scope: Partial<LaunchScope>): void => {
  launcher = createLauncher({ signal: ending.signal, ...scope });
};
const launch: Launcher["launch"] = (opts) => launcher.launch(opts);
const launchSync: Launcher["launchSync"] = (opts) => launcher.launchSync(opts);
const launchDetachedSync: Launcher["launchDetachedSync"] = (opts) =>
  launcher.launchDetachedSync(opts);
const launchJobSync: Launcher["launchJobSync"] = (opts, files) =>
  launcher.launchJobSync(opts, files);
const lifelineWarnings = () => launcher.lifelineWarnings();
const lifeline = () => launcher.__lifelineForTest();

beforeEach(() => {
  ending = new AbortController();
  scoped({});
});

afterEach(() => {
  ending.abort();
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

  it("kills the child on timeout: the outcome is the timeout, and SIGTERM is sent first", async () => {
    // [LAW:behavior-not-structure] The signal that ended a child which dies on
    // SIGTERM is a fact about scheduler latency against the 250 ms grace, not
    // about the launcher: a runner that starves `sh` past the grace sees
    // SIGKILL, correctly (brandon-ci-flakes-630 saw exactly that). What the
    // launcher promises is the outcome — `timeout` — and the ORDER it signals
    // in, which the seam records whatever the latency.
    const { sent, restore } = recordGroupSignals();
    try {
      const r = await launch({
        bin: "/bin/sh",
        args: ["-c", "sleep 5"],
        timeoutMs: 50,
        category: "user-shell",
      });
      expect(r).toMatchObject({ ok: false, reason: "timeout" });
      expect(sent[0]).toBe("SIGTERM");
    } finally {
      restore();
    }
  });

  it("escalates to SIGKILL and waits for death when the child ignores SIGTERM", async () => {
    // A single process (no child to orphan) that ignores SIGTERM, so a bare
    // SIGTERM leaves it running and the launcher must escalate to SIGKILL. The
    // promise must still resolve (not hang) and only after the child is reaped
    // — proving termination upholds the "no helper outlives its frame"
    // invariant. [LAW:no-ambient-temporal-coupling] The termination is asked
    // for only once the marker proves the handler is installed, so the child
    // can die of nothing but the escalation — no timeout budget stands in for
    // "node has booted by now". The abort trigger is used because it is the
    // one the test can time; the timeout trigger reaches the same escalation
    // (one termination per child), and its own outcome is pinned above.
    const marker = path.join(scratch, "armed");
    const controller = new AbortController();
    const { sent, restore } = recordGroupSignals();
    try {
      const pending = launch({
        ...ignoringChild(marker),
        category: "user-shell",
        signal: controller.signal,
      });
      await until(() => fs.existsSync(marker), "the child's SIGTERM handler");
      controller.abort();
      const r = await pending;
      expect(r).toMatchObject({ ok: false, reason: "aborted", signal: "SIGKILL" });
      expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      restore();
    }
  });

  it("aborting the signal terminates the child's whole group and reports \"aborted\" once it is reaped", async () => {
    // `sh` stays the parent of a two-statement command, so the `sleep` is a
    // grandchild: only a process-group signal reaches it. The marker names
    // the sh; the per-run duration names the sleep (both computed here, so
    // no enclosing shell's argv can ever match them).
    const stamp = `${process.pid}${Date.now()}`;
    const marker = `ccb-launch-abort-${stamp}`;
    const nap = `sleep 5.${stamp}`;
    const alive = (pattern: string) =>
      spawnSync("pgrep", ["-f", pattern]).status === 0;
    const controller = new AbortController();
    const pending = launch({
      bin: "/bin/sh",
      args: ["-c", `${nap}; echo ${marker}`],
      category: "user-shell",
      signal: controller.signal,
    });
    expect(alive(marker)).toBe(true);
    expect(alive(nap)).toBe(true);
    controller.abort();
    const r = await pending;
    // The outcome, not the ending signal: see the timeout test above.
    expect(r).toMatchObject({ ok: false, reason: "aborted" });
    expect(alive(marker)).toBe(false);
    expect(alive(nap)).toBe(false);
  });

  it("with both triggers armed, the timeout that fired first owns the cause; a later abort is inert", async () => {
    // One termination per child: the reason stays "timeout". The abort is
    // issued once the seam has recorded the timeout's SIGTERM — the named
    // condition for "the timeout fired first" — not at a wall-clock offset
    // guessed to land inside the grace window.
    const controller = new AbortController();
    const { sent, restore } = recordGroupSignals();
    try {
      const pending = launch({
        bin: "/bin/sh",
        args: ["-c", "sleep 5"],
        timeoutMs: 50,
        category: "user-shell",
        signal: controller.signal,
      });
      await until(() => sent.includes("SIGTERM"), "the timeout's SIGTERM");
      controller.abort();
      expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
    } finally {
      restore();
    }
  });

  it("with both triggers armed, an abort under a longer timeout owns the cause and disarms the timer", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const t0 = Date.now();
    const r = await launch({
      bin: "/bin/sh",
      args: ["-c", "sleep 5"],
      timeoutMs: 5000,
      category: "user-shell",
      signal: controller.signal,
    });
    expect(r).toMatchObject({ ok: false, reason: "aborted" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a group the launcher cannot signal settles as signal-refused — nothing rejects or escapes a timer", async () => {
    // process.kill refuses the group and its leader (EPERM: a child that
    // changed its real uid). The child ends on its own soon after, so nothing
    // is orphaned.
    const spy = jest.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    try {
      const r = await launch({
        bin: "/bin/sh",
        args: ["-c", "sleep 0.4"],
        timeoutMs: 50,
        category: "user-shell",
      });
      expect(r).toMatchObject({
        ok: false,
        reason: "signal-refused",
        exitCode: null,
        error: "EPERM",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a group's EPERM its leader does not back is no refusal", async () => {
    // Darwin's answer for a group of only zombies, or members still exiting.
    const realKill = process.kill.bind(process);
    const spy = jest.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (typeof pid === "number" && pid < 0) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      return realKill(pid, sig);
    });
    try {
      const controller = new AbortController();
      const run = launch({
        bin: "/bin/sh",
        args: ["-c", "sleep 0.1"],
        category: "user-shell",
        signal: controller.signal,
      });
      controller.abort();
      await expect(run).resolves.toMatchObject({
        reason: "aborted",
        exitCode: 0,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("an already-aborted signal spawns nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { handle, starts } = makeSpyHandle();
    scoped({ stats: handle });
    const r = await launch({
      bin: "/bin/sh",
      args: ["-c", "echo ran"],
      category: "user-shell",
      signal: controller.signal,
    });
    expect(r).toMatchObject({ ok: false, reason: "aborted", stdout: "" });
    expect(starts).toEqual([]);
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
    scoped({ stats: handle });
    // A launcher's first launch also starts its lifeline, a spawn of its own.
    await launch({ bin: "/bin/echo", args: ["up"], category: "git" });
    starts.length = 0;
    ends.length = 0;
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
    scoped({ stats: handle });
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
    scoped({ stats: handle });
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
    scoped({ stats: handle });
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

// [LAW:types-are-the-program] A waited child cannot outlive the process that
// launched it. Cutting the lifeline's pipe is the EOF that process's death
// gives it, however the process died; the daemon e2e kills a real launcher.
describe("the lifeline", () => {
  // A `sleep` under `sh`, so the group holds a grandchild a signal to `sh`
  // alone would orphan, with a duration no other process on the host has.
  const grandchild = (seconds: string) => ({
    bin: "/bin/sh",
    args: ["-c", `sleep ${seconds}; echo late`],
    category: "user-shell" as const,
  });
  const running = (seconds: string) =>
    spawnSync("pgrep", ["-f", `^sleep ${seconds}$`]).status === 0;

  // Each fault the lifeline's observer hears; null is a lifeline running again.
  let heard: Array<string | null>;
  beforeEach(() => {
    heard = [];
    scoped({ observeLifeline: (fault) => heard.push(fault) });
  });

  it("ends every group in flight when the launcher's pipe closes", async () => {
    const pending = launch(grandchild("30.861"));
    await until(() => running("30.861"), "the launched sleep");
    lifeline().cut();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, reason: "signal", stdout: "" });
    await until(() => !running("30.861"), "the grandchild sleep ending");
  });

  it("a lost lifeline stands as a warning, and the next launch replaces it holding every group in flight", async () => {
    const first = launch(grandchild("30.862"));
    const { pid: lostPid } = lifeline();
    process.kill(lostPid!, "SIGKILL");
    await until(
      () => heard.includes("exited SIGKILL"),
      "the lost lifeline's fault",
    );
    expect(lifelineWarnings()).toEqual([
      {
        kind: "lifeline",
        message:
          "programs launched now would outlive their launcher if it died: its launch lifeline exited SIGKILL, and the next launch starts another",
      },
    ]);
    const second = launch(grandchild("30.863"));
    const replacement = lifeline();
    expect(replacement.pid).not.toBe(lostPid);
    await until(
      () => running("30.862") && running("30.863"),
      "both launched sleeps",
    );
    await until(
      () => lifelineWarnings().length === 0,
      "the replacement running",
    );
    expect(heard.at(-1)).toBe(null);
    replacement.cut();
    expect(await first).toMatchObject({ ok: false, reason: "signal" });
    expect(await second).toMatchObject({ ok: false, reason: "signal" });
    await until(
      () => !running("30.862") && !running("30.863"),
      "both grandchild sleeps ending",
    );
  });
});

// [LAW:single-enforcer] Every spawn crosses this module, so what a closed
// daemon left running is ended here, whichever owner's work it was.
describe("a launcher's scope", () => {
  const touching = (file: string) => ({
    bin: "/usr/bin/touch",
    args: [file],
    category: "user-shell" as const,
  });

  it("refuses every kind of launch once its signal has aborted, spawning nothing", async () => {
    const closing = new AbortController();
    scoped({ signal: closing.signal });
    closing.abort(new Error("the daemon closed"));
    const marker = path.join(scratch, "scope-refused");

    expect(await launch(touching(marker))).toMatchObject({
      ok: false,
      reason: "aborted",
    });
    expect(launchSync(touching(marker))).toMatchObject({
      ok: false,
      reason: "aborted",
    });
    expect(launchDetachedSync(touching(marker))).toMatchObject({
      ok: false,
      reason: "aborted",
    });
    expect(
      launchJobSync(touching(marker), {
        stdout: path.join(scratch, "job.out"),
        stderr: path.join(scratch, "job.err"),
        status: path.join(scratch, "job.status"),
      }),
    ).toEqual({ ok: false, error: "the daemon closed" });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("terminates a launch in flight that has no signal of its own", async () => {
    const closing = new AbortController();
    scoped({ signal: closing.signal });
    const marker = path.join(scratch, "scope-started");
    const pending = launch({
      bin: "/bin/sh",
      args: ["-c", `touch '${marker}'; exec sleep 30`],
      category: "user-shell",
    });
    await until(() => fs.existsSync(marker), "the child started");

    closing.abort();

    expect(await pending).toMatchObject({ ok: false, reason: "aborted" });
  });

  // [LAW:no-silent-failure] Its signal lives as long as the daemon, so the
  // launches in flight share one listener on it, however many there are.
  it("ends every launch in flight through one listener on its signal", async () => {
    const closing = new AbortController();
    scoped({ signal: closing.signal });
    const pending = Array.from({ length: 12 }, () =>
      launch({ bin: "/bin/sleep", args: ["30"], category: "user-shell" }),
    );
    expect(getEventListeners(closing.signal, "abort")).toHaveLength(1);

    closing.abort();

    for (const result of await Promise.all(pending))
      expect(result).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("a launch that outlasts its daemon's close reports to that daemon, not the next", async () => {
    const closing = new AbortController();
    const closed = makeSpyHandle();
    scoped({ stats: closed.handle, signal: closing.signal });
    const pending = launch({
      bin: "/bin/sleep",
      args: ["30"],
      category: "user-shell",
    });

    closing.abort();
    const next = new AbortController();
    const successor = makeSpyHandle();
    scoped({ stats: successor.handle, signal: next.signal });
    await pending;

    expect(closed.ends.map((end) => end.category)).toEqual([
      "lifeline",
      "user-shell",
    ]);
    expect(successor.ends).toEqual([]);
    next.abort();
  });

  it("a closed launcher stays closed while another launches", async () => {
    const closing = new AbortController();
    const closed = makeSpyHandle();
    const first = createLauncher({
      stats: closed.handle,
      signal: closing.signal,
    });
    closing.abort();
    const next = makeSpyHandle();
    scoped({ stats: next.handle });
    const echo = { bin: "/bin/echo", category: "user-shell" } as const;

    expect(await launch(echo)).toMatchObject({ ok: true });
    expect(await first.launch(echo)).toMatchObject({
      ok: false,
      reason: "aborted",
    });

    expect(closed.refused).toEqual(["user-shell"]);
    expect(closed.starts).toEqual([]);
    expect(next.refused).toEqual([]);
  });

  it("a launcher's rate limits are its own", () => {
    const once = { bin: "/bin/echo", category: "click.open" } as const;
    expect(launcher.launchSync(once)).toMatchObject({ ok: true });
    expect(launcher.launchSync(once)).toMatchObject({
      ok: false,
      reason: "rate-limited",
    });
    const next = createLauncher({ signal: ending.signal });
    expect(next.launchSync(once)).toMatchObject({ ok: true });
  });

  // [LAW:nothing-unseen] A launch that did nothing reads apart from one nobody
  // tried: each form says so to the owner's stats, and a started child is not
  // among them.
  it("every form meters its refusal, closed or rate-limited", async () => {
    const closing = new AbortController();
    const { handle, refused, starts } = makeSpyHandle();
    scoped({ stats: handle, signal: closing.signal });
    const once = { bin: "/bin/echo", category: "click.open" } as const;
    expect(launchSync(once)).toMatchObject({ ok: true });
    expect(launchSync(once)).toMatchObject({ reason: "rate-limited" });
    expect(refused).toEqual(["click.open"]);

    closing.abort();
    const marker = path.join(scratch, "metered");
    await launch(touching(marker));
    launchSync(touching(marker));
    launchDetachedSync(touching(marker));
    launchJobSync(touching(marker), {
      stdout: path.join(scratch, "metered.out"),
      stderr: path.join(scratch, "metered.err"),
      status: path.join(scratch, "metered.status"),
    });

    expect(refused.slice(1)).toEqual(Array(4).fill("user-shell"));
    expect(starts.filter((c) => c === "user-shell")).toEqual([]);
  });

  it("a launch its own caller aborted first is refused at the same gate, and metered", async () => {
    const { handle, refused, starts } = makeSpyHandle();
    scoped({ stats: handle });
    const marker = path.join(scratch, "caller-aborted");

    expect(
      await launch({
        ...touching(marker),
        signal: AbortSignal.abort(new Error("superseded")),
      }),
    ).toMatchObject({ ok: false, reason: "aborted", error: "superseded" });

    expect(refused).toEqual(["user-shell"]);
    expect(starts).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a refused job says what refused it", () => {
    scoped({});
    const once = { bin: "/bin/echo", category: "click.open" } as const;
    const files = {
      stdout: path.join(scratch, "limited.out"),
      stderr: path.join(scratch, "limited.err"),
      status: path.join(scratch, "limited.status"),
    };
    const first = launchJobSync(once, files);
    if (!first.ok) throw new Error(first.error);
    first.withdraw();

    expect(launchJobSync(once, files)).toEqual({
      ok: false,
      error: expect.stringContaining("rate-limited: click.open"),
    });
  });

  it("a retired lifeline records no fault, and nothing starts another while the scope refuses", async () => {
    const heard: Array<string | null> = [];
    const closing = new AbortController();
    scoped({
      signal: closing.signal,
      observeLifeline: (fault) => heard.push(fault),
    });
    await launch({ bin: "/bin/echo", category: "user-shell" });
    const { pid } = lifeline();
    expect(pid).toBeDefined();

    closing.abort();
    await launch({ bin: "/bin/echo", category: "user-shell" });

    expect(lifeline().pid).toBeUndefined();
    await until(() => spawnSync("kill", ["-0", String(pid)]).status !== 0, "the lifeline exiting");
    expect(heard.filter((fault) => fault !== null)).toEqual([]);
  });
});
