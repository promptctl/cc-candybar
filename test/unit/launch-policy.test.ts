import { fixtureFakeLauncher } from "../helpers/scripted-launcher";
import {
  createOneShotLauncher,
  MAX_CAPTURED_BYTES,
} from "../../src/proc/launch";
import { EventEmitter } from "node:events";
import type { Spawner } from "../../src/proc/spawner";
import {
  OWNER_CONTEXT,
  type LaunchResult,
  type LaunchContext,
} from "../../src/proc/launcher.js";
import {
  exits,
  floods,
  hangs,
  ignoring,
  runsFor,
  shell,
} from "../../src/proc/spawner-fake";
import {
  fakeLauncher,
  turns,
} from "../../scripts/lib/draw-fixtures/fake-launcher";
import { heldClock } from "../helpers/held-clock";

// The compiler rejects both an omitted choice and an explicit undefined.
type ExplicitContext<T extends LaunchContext> = T;
// @ts-expect-error a directory also requires an environment
type NoEnvironment = ExplicitContext<{ cwd: string }>;
// @ts-expect-error an environment also requires a directory
type NoDirectory = ExplicitContext<{ environment: {} }>;
// @ts-expect-error undefined cannot stand for inheritance
type UndefinedDirectory = ExplicitContext<{ cwd: undefined; environment: {} }>;
// @ts-expect-error undefined cannot stand for inheritance
type UndefinedEnvironment = ExplicitContext<{
  cwd: string;
  environment: undefined;
}>;
type ExplicitOwner<T extends Parameters<typeof createOneShotLauncher>[0]> = T;
// @ts-expect-error a component must supply its lifetime
type NoLifetime = ExplicitOwner<{ inherited: {} }>;
type ScriptedOwner<T extends Parameters<typeof fakeLauncher>[1]> = T;
// @ts-expect-error a scripted OS has the same required lifetime
type NoScriptedLifetime = ScriptedOwner<{ inherited: {} }>;

type BoundTools<
  T extends import("../../src/proc/launcher").ContextualLauncher,
> = T;
type RawTools = Pick<import("../../src/proc/launcher").Launcher, "launch">;
// @ts-expect-error fixed desktop tools need a launcher bound to a context
type UnboundTools = BoundTools<RawTools>;

// [LAW:behavior-not-structure] What a launch promises its caller, proved on the
// production launcher over a scripted OS and a held clock: no process starts, no
// time passes, and the cases that used to sleep for a timeout run at once.

function rig() {
  const clock = heldClock(new Date(1_000_000));
  const fake = fixtureFakeLauncher(clock, {});
  const advance = async (ms: number) => {
    clock.advance(ms);
    await turns();
  };
  return { clock, advance, ...fake };
}

const sh = (
  command: string,
  extra: { timeoutMs?: number; signal?: AbortSignal } = {},
) => ({
  ...OWNER_CONTEXT,
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
  test.each(["EPIPE", "ECONNRESET"])(
    "blocking stdin %s leaves every observed child verdict intact",
    (errno) => {
      const r = rig();
      const error = Object.assign(new Error(`write ${errno}`), { code: errno });
      const raw = {
        pid: 42,
        output: [null, "out", "err"],
        stdout: "out",
        stderr: "err",
        error,
      };
      const run = (status: number | null, signal: NodeJS.Signals | null) => {
        const spawner: Spawner = {
          ...r.spawner,
          spawnSync: () => ({ ...raw, status, signal }),
        };
        const launcher = createOneShotLauncher(
          { inherited: {}, signal: r.ownerSignal },
          r.clock,
          spawner,
        );
        return launcher.launchSync({
          ...OWNER_CONTEXT,
          ...sh("closed reader"),
          stdinInput: "unread",
        });
      };
      const output = { stdout: "out", stderr: "err" };
      expect(run(0, null)).toEqual({ ...output, ok: true, exitCode: 0 });
      expect(run(3, null)).toEqual({
        ...output,
        ok: false,
        reason: "non-zero",
        exitCode: 3,
        signal: null,
      });
      expect(run(null, "SIGKILL")).toEqual({
        ...output,
        ok: false,
        reason: "signal",
        exitCode: null,
        signal: "SIGKILL",
      });
      // With no child outcome to prefer, the pipe error is the evidence.
      expect(run(null, null)).toEqual({
        ...output,
        ok: false,
        reason: "spawn-error",
        exitCode: null,
        signal: null,
        error: error.message,
      });
    },
  );

  test("settling on pipe close releases the deferred process-group check", async () => {
    const r = rig();
    r.spawner.program(shell("done"), exits(0));
    const launched = r.launcher.launch(sh("done"));
    await r.advance(0);
    expect(await launched).toMatchObject({ ok: true });
    // Give the exit continuation its turn without firing deferred clock work.
    await turns();
    expect(r.clock.pending()).toBe(0);
  });

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
    expect((result as { stdout: string }).stdout).toHaveLength(
      MAX_CAPTURED_BYTES,
    );
  });

  test("a category's minimum interval refuses a second start without starting one", async () => {
    const r = rig();
    r.spawner.program(shell("pbcopy"), exits(0));
    const click = {
      ...OWNER_CONTEXT,
      bin: "/bin/sh",
      args: ["-c", "pbcopy"],
      category: "click.pbcopy" as const,
    };
    expect(await settled(r, r.launcher.launch(click))).toMatchObject({
      ok: true,
    });
    expect(await r.launcher.launch(click)).toMatchObject({
      ok: false,
      reason: "rate-limited",
    });
    expect(r.started()).toHaveLength(1);
    await r.advance(1000);
    expect(await settled(r, r.launcher.launch(click))).toMatchObject({
      ok: true,
    });
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
  test("a job whose native spawn cannot allocate stdio returns a failure and consumes the native error", async () => {
    const r = rig();
    const spawner: Spawner = {
      ...r.spawner,
      spawn(bin, args, options) {
        const child = r.spawner.spawn(bin, args, options);
        // The unscripted fake emits its native spawn error on the next turn.
        return Object.assign(child, { stdin: null });
      },
    };
    const launcher = createOneShotLauncher(
      { inherited: {}, signal: r.ownerSignal },
      r.clock,
      spawner,
    );
    const result = launcher.launchJobSync(sh("unused"), {
      stdout: "unused.out",
      stderr: "unused.err",
      status: "unused.status",
    });
    expect(result).toMatchObject({ ok: false, reason: "spawn-error" });
    await r.advance(1);
    expect(await launcher.settled()).toEqual({ unreaped: [] });
  });

  test.each([false, true])(
    "retires a terminated group while a pipe is still held (member outlives leader: %s)",
    async (memberSurvives) => {
      const r = rig();
      const command = "held descriptor";
      r.spawner.program(shell(command), hangs());
      let group: number | undefined;
      let member = memberSurvives;
      const signals: NodeJS.Signals[] = [];
      const spawner: Spawner = {
        ...r.spawner,
        spawn(bin, args, options) {
          const child = r.spawner.spawn(bin, args, options);
          if (!shell(command)(bin, args)) return child;
          group = child.pid;
          // A process outside the group holds a pipe. Leader exit is
          // delivered, but a child close is unavailable to the launcher.
          const events = new EventEmitter();
          child.once("exit", (code, signal) =>
            events.emit("exit", code, signal),
          );
          return Object.assign(Object.create(child) as typeof child, {
            on: events.on.bind(events),
            once: events.once.bind(events),
            off: events.off.bind(events),
          });
        },
        groupGone: (pid) =>
          (pid !== group || !member) && r.spawner.groupGone(pid),
        signalGroup(pid, signal) {
          if (pid === group) signals.push(signal);
          r.spawner.signalGroup(pid, signal);
        },
      };
      const launcher = createOneShotLauncher(
        { inherited: {}, signal: r.ownerSignal },
        r.clock,
        spawner,
      );
      const stop = new AbortController();
      let result: LaunchResult | undefined;
      void launcher
        .launch(sh(command, { signal: stop.signal }))
        .then((value) => {
          result = value;
        });
      stop.abort();
      await r.advance(0);
      if (memberSurvives) expect(result).toBeUndefined();
      member = false;
      await r.advance(100);
      expect(result).toMatchObject({ ok: false, reason: "aborted" });
      // Once absence is observed even a later positive group lookup
      // cannot renew the launch's authority over that numeric id.
      member = true;
      await r.advance(1_000);
      expect(signals).toEqual(["SIGTERM"]);
    },
  );

  test("closing the owner ends what is in flight and refuses what comes after", async () => {
    const clock = heldClock(new Date(1_000_000));
    const closing = new AbortController();
    const { launcher, spawner, started } = fakeLauncher(clock, {
      inherited: {},
      signal: closing.signal,
    });
    spawner.program(shell("sleep 60"), hangs());
    const inFlight = launcher.launch(sh("sleep 60"));
    clock.advance(10);
    await turns();
    closing.abort(new Error("daemon closing"));
    clock.advance(1000);
    await turns();
    expect(await inFlight).toMatchObject({ ok: false, reason: "aborted" });
    const group = started()[0]!.pid;
    const lifeline = spawner.spawned.find(({ bin }) => bin === "awk");
    expect(lifeline?.stdin.trimEnd().split("\n").at(-1)).toBe(`- ${group}`);
    expect(await launcher.launch(sh("sleep 60"))).toMatchObject({
      ok: false,
      reason: "aborted",
    });
    expect(started()).toHaveLength(1);
  });
});

test("closing a scripted fixture reaps its TERM-ignoring child and lifeline while another fixture remains usable", async () => {
  const first = rig();
  first.spawner.program(shell("work"), ignoring(["SIGTERM"], hangs()));
  const work = first.launcher.launch(sh("work"));
  await turns();
  await first.close();
  expect(await work).toMatchObject({ reason: "aborted", signal: "SIGKILL" });
  expect(first.spawner.spawned.every((child) => child.ended !== null)).toBe(
    true,
  );
  const second = rig();
  second.spawner.program(shell("work"), exits(0, "next"));
  expect(
    await settled(second, second.launcher.launch(sh("work"))),
  ).toMatchObject({ ok: true, stdout: "next" });
});
