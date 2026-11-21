// What every clock promises its owner: a task that throws or rejects is
// reported once, under its name, at the wall reading when it was caught, and
// the clock goes on. The held clock is built over its timers as the process's
// is over the machine's (src/time.ts), so this is the process's clock.

import { clockOver, rethrowing, type ReportThrow } from "../../src/time";
import { heldClock } from "../helpers/held-clock";

const START = new Date("2026-01-01T00:00:00Z");

function rig() {
  const reported: Array<{ task: string; thrown: unknown; at: number }> = [];
  const report: ReportThrow = (task, thrown, at) =>
    reported.push({ task, thrown, at });
  return {
    clock: heldClock(START, (source) => clockOver(source, report)),
    reported,
  };
}

const broke = new Error("it broke");

// A rejection is caught a few microtasks after the task returns; the unit
// tier takes no turn of the real loop, so the case drains them.
const drained = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

test("a timer's throw is reported once with its name and the moment it was caught", () => {
  const { clock, reported } = rig();
  clock.after("menu close", 250, () => {
    throw broke;
  });
  clock.advance(1_000);
  expect(reported).toEqual([
    { task: "menu close", thrown: broke, at: START.getTime() + 250 },
  ]);
});

test("a timer's rejection is reported once with its name", async () => {
  const { clock, reported } = rig();
  clock.after("git refresh /repo", 10, () => Promise.reject(broke));
  clock.advance(10);
  await drained();
  expect(reported).toEqual([
    { task: "git refresh /repo", thrown: broke, at: START.getTime() + 10 },
  ]);
});

test("a repeating task that throws runs again on its next period", () => {
  const { clock, reported } = rig();
  let runs = 0;
  clock.every("session sweep", 100, () => {
    runs++;
    throw broke;
  });
  clock.advance(300);
  expect(runs).toBe(3);
  expect(reported.map(({ task }) => task)).toEqual([
    "session sweep",
    "session sweep",
    "session sweep",
  ]);
});

test("a deferred task's throw is reported on the turn it runs", () => {
  const { clock, reported } = rig();
  clock.defer("frame stream reopen", () => {
    throw broke;
  });
  expect(reported).toEqual([]);
  clock.advance(0);
  expect(reported).toEqual([
    { task: "frame stream reopen", thrown: broke, at: START.getTime() },
  ]);
});

test("a detached task runs now; its throw and its later rejection are reported, and neither reaches its starter", async () => {
  const { clock, reported } = rig();
  let ran = false;
  expect(() =>
    clock.detach("daemon log flush", () => {
      ran = true;
      throw broke;
    }),
  ).not.toThrow();
  expect(ran).toBe(true);
  clock.detach("url click landing", () => Promise.reject(broke));
  await drained();
  expect(reported.map(({ task }) => task)).toEqual([
    "daemon log flush",
    "url click landing",
  ]);
});

test("a task's rejecting thenable is reported as a promise's rejection is", async () => {
  const { clock, reported } = rig();
  const thenable: PromiseLike<never> = {
    then: (_ok, fail) => {
      fail?.(broke);
      return thenable;
    },
  };
  clock.detach("forge lookup", () => thenable);
  await drained();
  expect(reported).toEqual([
    { task: "forge lookup", thrown: broke, at: START.getTime() },
  ]);
});

test("a command's clock ends on a task's throw, naming the task, with the throw as its cause", () => {
  const clock = heldClock(START, (source) => clockOver(source, rethrowing));
  clock.after("install currency", 10, () => {
    throw broke;
  });
  expect(() => clock.advance(10)).toThrow(
    expect.objectContaining({ message: "install currency threw", cause: broke }),
  );
});

test("a task that settles cleanly reports nothing, whatever it returns", async () => {
  const { clock, reported } = rig();
  clock.after("a", 0, () => 42);
  clock.detach("b", () => Promise.resolve("done"));
  clock.advance(0);
  await drained();
  expect(reported).toEqual([]);
});
