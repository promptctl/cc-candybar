import { fakeSpawner, program, shell, exits, hangs } from "../../src/proc/spawner-fake";
import { heldClock } from "../helpers/held-clock";
import { spawnerContract, type Program } from "../contract/spawner.contract";

// Letting the stream events a fired timer caused run. A stream finishes its
// work on the next-tick queue, which a chain of resolved promises never leaves
// room for, so each turn waits on that queue itself.
const turns = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
};

spawnerContract("the fake spawner", () => {
  const clock = heldClock(new Date(1_000_000));
  const spawner = fakeSpawner(clock);
  let made = 0;
  return {
    spawner,
    realise: (behaviour): Program => {
      const bin = `fake-program-${made++}`;
      spawner.program(program(bin), behaviour);
      return { bin, args: [] };
    },
    missing: { bin: "fake-program-never-registered", args: [] },
    settle: async (ms) => {
      clock.advance(ms);
      await turns();
    },
  };
});

describe("the fake spawner", () => {
  test("the most recent registration that matches serves a start", () => {
    const spawner = fakeSpawner(heldClock(new Date(0)));
    spawner.program(shell("echo hi"), exits(1));
    spawner.program(shell("echo hi"), exits(0, "hi\n"));
    const r = spawner.spawnSync("/bin/sh", ["-c", "echo hi"], { encoding: "utf8" });
    expect(r.stdout).toBe("hi\n");
  });

  test("a start is on record with its arguments, its pid and the signals it was sent", async () => {
    const clock = heldClock(new Date(0));
    const spawner = fakeSpawner(clock);
    spawner.program(shell("sleep 60"), hangs());
    const child = spawner.spawn("/bin/sh", ["-c", "sleep 60"], {
      cwd: "/tmp",
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawner.signalGroup(child.pid!, "SIGTERM");
    clock.advance(0);
    await turns();
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.spawned[0]).toMatchObject({
      bin: "/bin/sh",
      args: ["-c", "sleep 60"],
      pid: child.pid,
      signals: ["SIGTERM"],
      ended: { code: null, signal: "SIGTERM" },
    });
  });

  test("a group whose members changed their uid refuses every signal", () => {
    const spawner = fakeSpawner(heldClock(new Date(0)));
    spawner.seedGroup(7, { refuses: true });
    expect(() => spawner.signalGroup(7, "SIGTERM")).toThrow(/EPERM/);
    expect(spawner.signalJob(7, "SIGTERM")).toBe(false);
    expect(spawner.groupGone(7)).toBe(false);
  });

  test("a group the test names is alive until the test ends it", () => {
    const spawner = fakeSpawner(heldClock(new Date(0)));
    const group = spawner.seedGroup(424242);
    expect(spawner.signalJob(424242, 0)).toBe(true);
    group.end();
    expect(spawner.signalJob(424242, 0)).toBe(false);
    expect(spawner.groupGone(424242)).toBe(true);
  });

  test("a blocking start of a program that never exits and has no timeout is refused loudly", () => {
    const spawner = fakeSpawner(heldClock(new Date(0)));
    spawner.program(program("stuck"), hangs());
    expect(() => spawner.spawnSync("stuck", [], { encoding: "utf8" })).toThrow(
      /would block for good/,
    );
  });
});
