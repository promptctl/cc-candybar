import { waitWithin } from "../../src/utils/reading";
import { clockOver } from "../../src/time";
import { heldClock } from "../helpers/held-clock";

function reportingClock() {
  const reported: Array<{ task: string; thrown: unknown }> = [];
  const clock = heldClock(new Date(0), (source) =>
    clockOver(source, (task, thrown) => reported.push({ task, thrown })),
  );
  return { clock, reported };
}

// The owner of a wait that never closes.
const OPEN = new AbortController().signal;

test("work that ends inside the time answers, and its signal is aborted once the wait ends", async () => {
  let seen: AbortSignal | undefined;
  const end = await waitWithin(
    "test wait",
    (signal) => {
      seen = signal;
      return Promise.resolve("ready");
    },
    1000,
    heldClock(new Date(0)),
    OPEN,
  );
  expect(end).toEqual({ end: "answered", value: "ready" });
  expect(seen?.aborted).toBe(true);
});

test("work still out at the deadline ends the wait there, and its signal aborts", async () => {
  let seen: AbortSignal | undefined;
  const clock = heldClock(new Date(0));
  const waiting = waitWithin(
    "test wait",
    (signal) => {
      seen = signal;
      return new Promise(() => {});
    },
    20,
    clock,
    OPEN,
  );
  clock.advance(20);
  expect((await waiting).end).toBe("deadline");
  expect(seen?.aborted).toBe(true);
});

test("a wait ends when its time does, and not before", async () => {
  const clock = heldClock(new Date(0));
  let signal: AbortSignal | undefined;
  const waiting = waitWithin(
    "test wait",
    (workSignal) => {
      signal = workSignal;
      return new Promise(() => {});
    },
    110,
    clock,
    OPEN,
  );
  clock.advance(109);
  expect(signal?.aborted).toBe(false);
  clock.advance(1);
  expect(signal?.aborted).toBe(true);
  expect((await waiting).end).toBe("deadline");
});

test("a rejection inside the time is the wait's", async () => {
  await expect(
    waitWithin(
      "test wait",
      () => Promise.reject(new Error("bug")),
      1000,
      heldClock(new Date(0)),
      OPEN,
    ),
  ).rejects.toThrow("bug");
});

test("a rejection after the deadline is the clock's, as the wait's task after its wait, never dropped", async () => {
  const { clock, reported } = reportingClock();
  const work = Promise.withResolvers<void>();
  const waiting = waitWithin(
    "test wait",
    () => work.promise,
    5,
    clock,
    OPEN,
  );
  clock.advance(5);
  expect((await waiting).end).toBe("deadline");
  work.reject(new Error("late bug"));
  await expect(work.promise).rejects.toThrow("late bug");
  expect(reported).toEqual([
    { task: "test wait after its wait", thrown: new Error("late bug") },
  ]);
});

test("work that stops at its signal, rejecting with its reason, ends with the wait and is no failure", async () => {
  const { clock, reported } = reportingClock();
  const waiting = waitWithin(
    "test wait",
    (signal) =>
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
    5,
    clock,
    OPEN,
  );
  clock.advance(5);
  expect((await waiting).end).toBe("deadline");
  expect(reported).toEqual([]);
});

test("work that throws before it returns, in a wait begun closed, is the clock's", async () => {
  const closed = new AbortController();
  closed.abort();
  const { clock, reported } = reportingClock();
  const broke = new Error("bad input");
  const end = await waitWithin(
    "test wait",
    () => {
      throw broke;
    },
    60_000,
    clock,
    closed.signal,
  );
  expect(end.end).toBe("closed");
  expect(reported).toEqual([
    { task: "test wait after its wait", thrown: broke },
  ]);
});

test("work that throws before it returns fails the wait at once", async () => {
  const broke = new Error("bad input");
  await expect(
    waitWithin(
      "test wait",
      () => {
        throw broke;
      },
      60_000,
      heldClock(new Date(0)),
      OPEN,
    ),
  ).rejects.toBe(broke);
});

test("its owner closing ends the wait there, with its timer cleared and its work's signal aborted", async () => {
  const owner = new AbortController();
  let seen: AbortSignal | undefined;
  const clock = heldClock(new Date(0));
  const waiting = waitWithin(
    "test wait",
    (signal) => {
      seen = signal;
      return new Promise(() => {});
    },
    60_000,
    clock,
    owner.signal,
  );
  expect(clock.pending()).toBe(1);
  owner.abort();
  expect((await waiting).end).toBe("closed");
  expect(seen?.aborted).toBe(true);
  expect(clock.pending()).toBe(0);
});

test("a wait begun after its owner closed ends at once", async () => {
  const owner = new AbortController();
  owner.abort();
  expect(
    await waitWithin(
      "test wait",
      () => new Promise(() => {}),
      60_000,
      heldClock(new Date(0)),
      owner.signal,
    ),
  ).toEqual({ end: "closed" });
});
