import { MAX_CAPTURED_BYTES, type LaunchResult } from "../../src/proc/launch";
import { exits, floods, hangs, ignoring, runsFor, shell } from "../../src/proc/spawner-fake";
import { fakeLauncher } from "../helpers/fake-launcher";
import { heldClock } from "../helpers/held-clock";

// [LAW:behavior-not-structure] What a launch promises its caller, proved on the
// production launcher over a scripted OS and a held clock: no process starts, no
// time passes, and the cases that used to sleep for a timeout run at once.

// A stream finishes its work on the next-tick queue, which a chain of resolved
// promises never leaves room for, so each turn waits on that queue itself.
const turns = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
};

function rig() {
  const clock = heldClock(new Date(1_000_000));
  const fake = fakeLauncher(clock);
  const advance = async (ms: number) => {
    clock.advance(ms);
    await turns();
  };
  return { clock, advance, ...fake };
}

const sh = (command: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) => ({
  bin: "/bin/sh",
  args: ["-c", command],
  category: "user-shell" as const,
  ...extra,
});

// Lets a launch that was started settle, whatever it takes of the clock.
async function settled(
  r: ReturnType<typeof rig>,
  launch: Promise<LaunchResult>,
  step = 50,
): Promise<LaunchResult> {
  let result: LaunchResult | undefined;
  void launch.then((v) => (result = v));
  for (let i = 0; i < 200 && result === undefined; i++) await r.advance(step);
  if (result === undefined) throw new Error("the launch never settled");
  return result;
}

describe("a launch over a scripted OS", () => {
  test("a program that exits 0 gives its output", async () => {
    const r = rig();
    r.spawner.program(shell("echo hi"), exits(0, "hi\n", "warn"));
    expect(await settled(r, r.launcher.launch(sh("echo hi")))).toEqual({
      ok: true,
      stdout: "hi\n",
      stderr: "warn",
      exitCode: 0,
    });
  });

  test("a non-zero exit is its own reason, with the code", async () => {
    const r = rig();
    r.spawner.program(shell("false"), exits(3, "", "bad"));
    expect(await settled(r, r.launcher.launch(sh("false")))).toMatchObject({
      ok: false,
      reason: "non-zero",
      exitCode: 3,
      stderr: "bad",
    });
  });

  test("a program nobody scripted fails to start, as a missing binary does", async () => {
    const r = rig();
    const result = await settled(r, r.launcher.launch(sh("anything")));
    expect(result).toMatchObject({ ok: false, reason: "spawn-error" });
    expect((result as { error: string }).error).toMatch(/ENOENT/);
  });

  test("a program that outlives its timeout is ended and the reason is the timeout", async () => {
    const r = rig();
    r.spawner.program(shell("sleep 60"), hangs());
    const launch = r.launcher.launch(sh("sleep 60", { timeoutMs: 1000 }));
    await r.advance(999);
    let early = false;
    void launch.then(() => (early = true));
    await r.advance(0);
    expect(early).toBe(false);
    expect(await settled(r, launch)).toMatchObject({
      ok: false,
      reason: "timeout",
      signal: "SIGTERM",
    });
    expect(r.started()[0]!.signals).toEqual(["SIGTERM"]);
  });

  test("a program that ignores the timeout's signal is killed after the grace", async () => {
    const r = rig();
    r.spawner.program(shell("stubborn"), ignoring(["SIGTERM"], hangs()));
    const launch = r.launcher.launch(sh("stubborn", { timeoutMs: 100 }));
    expect(await settled(r, launch, 10)).toMatchObject({
      ok: false,
      reason: "timeout",
      signal: "SIGKILL",
    });
    expect(r.started()[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("the caller's signal ends a launch, and the reason is the abort", async () => {
    const r = rig();
    r.spawner.program(shell("sleep 60"), hangs());
    const stop = new AbortController();
    const launch = r.launcher.launch(sh("sleep 60", { signal: stop.signal }));
    await r.advance(10);
    stop.abort(new Error("no longer wanted"));
    expect(await settled(r, launch, 10)).toMatchObject({
      ok: false,
      reason: "aborted",
    });
  });

  test("a program that writes past the bound is ended, with the first bytes kept", async () => {
    const r = rig();
    r.spawner.program(shell("yes"), floods(MAX_CAPTURED_BYTES + 100_000));
    const result = await settled(r, r.launcher.launch(sh("yes")), 10);
    expect(result).toMatchObject({ ok: false, reason: "output-limit" });
    expect((result as { stdout: string }).stdout).toHaveLength(MAX_CAPTURED_BYTES);
  });

  test("a category's minimum interval refuses a second start without starting one", async () => {
    const r = rig();
    r.spawner.program(shell("pbcopy"), exits(0));
    const click = { bin: "/bin/sh", args: ["-c", "pbcopy"], category: "click.pbcopy" as const };
    expect(await settled(r, r.launcher.launch(click))).toMatchObject({ ok: true });
    expect(await r.launcher.launch(click)).toMatchObject({
      ok: false,
      reason: "rate-limited",
    });
    expect(r.started()).toHaveLength(1);
    await r.advance(1000);
    expect(await settled(r, r.launcher.launch(click))).toMatchObject({ ok: true });
  });

  test("a program that runs for a while is waited for, on the clock", async () => {
    const r = rig();
    r.spawner.program(shell("slow"), runsFor(400, exits(0, "done")));
    let result: LaunchResult | undefined;
    void r.launcher.launch(sh("slow")).then((v) => (result = v));
    await r.advance(399);
    expect(result).toBeUndefined();
    await r.advance(10);
    expect(result).toMatchObject({ ok: true, stdout: "done" });
  });
});

describe("an owner's launcher over a scripted OS", () => {
  test("closing the owner ends what is in flight and refuses what comes after", async () => {
    const clock = heldClock(new Date(1_000_000));
    const closing = new AbortController();
    const { launcher, spawner, started } = fakeLauncher(clock, { signal: closing.signal });
    spawner.program(shell("sleep 60"), hangs());
    const inFlight = launcher.launch(sh("sleep 60"));
    clock.advance(10);
    await turns();
    closing.abort(new Error("daemon closing"));
    clock.advance(1000);
    await turns();
    expect(await inFlight).toMatchObject({ ok: false, reason: "aborted" });
    expect(await launcher.launch(sh("sleep 60"))).toMatchObject({
      ok: false,
      reason: "aborted",
    });
    expect(started()).toHaveLength(1);
  });
});
