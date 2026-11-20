import { reporting, told, type Timekeeper } from "../../src/time";
import { heldClock } from "../helpers/held-clock";

// A reporting clock over a held one, and what it reported, as `task: message`.
function rig() {
  const held = heldClock(new Date(1_000_000));
  const reported: string[] = [];
  const clock: Timekeeper = reporting(held, (task, thrown) =>
    reported.push(`${task}: ${(thrown as Error).message}`),
  );
  return { held, clock, reported };
}

const boom = (message: string) => () => {
  throw new Error(message);
};

test("a throw in each kind of task is reported under the task's name", () => {
  const { held, clock, reported } = rig();
  clock.after("one-shot", 10, boom("after broke"));
  clock.every("repeating", 10, boom("every broke"));
  clock.defer("deferred", boom("defer broke"));
  clock.detach("detached", boom("detach broke"));
  expect(reported).toEqual(["detached: detach broke"]);
  held.advance(10);
  expect(reported).toEqual([
    "detached: detach broke",
    "deferred: defer broke",
    "one-shot: after broke",
    "repeating: every broke",
  ]);
});

test("a task's rejection is reported once it settles", async () => {
  const { clock, reported } = rig();
  clock.detach("awaiting", () => Promise.reject(new Error("later broke")));
  expect(reported).toEqual([]);
  await Promise.resolve();
  await Promise.resolve();
  expect(reported).toEqual(["awaiting: later broke"]);
});

test("a repeating task that threw runs again at its next period", () => {
  const { held, clock, reported } = rig();
  clock.every("repeating", 10, boom("again"));
  held.advance(30);
  expect(reported).toEqual([
    "repeating: again",
    "repeating: again",
    "repeating: again",
  ]);
});

test("a task that ends well reports nothing, and a cancelled one never runs", async () => {
  const { held, clock, reported } = rig();
  let ran = 0;
  clock.detach("fine", () => Promise.resolve(ran++));
  const cancel = clock.after("cancelled", 10, boom("never"));
  cancel();
  held.advance(10);
  await Promise.resolve();
  expect(ran).toBe(1);
  expect(reported).toEqual([]);
});

test("what awaited work threw is told to the clock as a task of its own", () => {
  const { clock, reported } = rig();
  told(clock, "loop pass", new Error("pass broke"));
  expect(reported).toEqual(["loop pass: pass broke"]);
});
