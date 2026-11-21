import { waitWithin } from "../src/utils/reading";
import { clockOver, systemTimers } from "../src/time";
import { systemTimekeeper } from "./helpers/system-clock";

const after = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The owner of a wait that never closes.
const OPEN = new AbortController().signal;

test("work that ends inside the time answers, and its signal is aborted once the wait ends", async () => {
  let seen: AbortSignal | undefined;
  const end = await waitWithin(
    "test wait",
    async (signal) => {
      seen = signal;
      await after(10);
    },
    1000,
    systemTimekeeper,
    OPEN,
  );
  expect(end).toBe("answered");
  expect(seen?.aborted).toBe(true);
});

test("work still out at the deadline ends the wait there, and its signal aborts", async () => {
  let seen: AbortSignal | undefined;
  const end = await waitWithin(
    "test wait",
    (signal) => {
      seen = signal;
      return after(1000);
    },
    20,
    systemTimekeeper,
    OPEN,
  );
  expect(end).toBe("deadline");
  expect(seen?.aborted).toBe(true);
});

test("a wait ends when its time does, and not before", async () => {
  jest.useFakeTimers();
  try {
    let end: string | undefined;
    void waitWithin(
      "test wait",
      () => new Promise(() => {}),
      110,
      systemTimekeeper,
      OPEN,
    ).then((e) => {
      end = e;
    });
    await jest.advanceTimersByTimeAsync(109);
    expect(end).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(end).toBe("deadline");
  } finally {
    jest.useRealTimers();
  }
});

test("a rejection inside the time is the wait's", async () => {
  await expect(
    waitWithin(
      "test wait",
      () => Promise.reject(new Error("bug")),
      1000,
      systemTimekeeper,
      OPEN,
    ),
  ).rejects.toThrow("bug");
});

test("a rejection after the deadline is the clock's, as the wait's task after its wait, never dropped", async () => {
  const reported: Array<{ task: string; thrown: unknown }> = [];
  const clock = clockOver(systemTimers, (task, thrown) =>
    reported.push({ task, thrown }),
  );
  const end = await waitWithin(
    "test wait",
    async () => {
      await after(30);
      throw new Error("late bug");
    },
    5,
    clock,
    OPEN,
  );
  expect(end).toBe("deadline");
  await after(60);
  expect(reported).toEqual([
    { task: "test wait after its wait", thrown: new Error("late bug") },
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
      systemTimekeeper,
      OPEN,
    ),
  ).rejects.toBe(broke);
});

test("its owner closing ends the wait there, with its timer cleared and its work's signal aborted", async () => {
  const owner = new AbortController();
  let seen: AbortSignal | undefined;
  const cleared: string[] = [];
  const waiting = waitWithin(
    "test wait",
    (signal) => {
      seen = signal;
      return new Promise(() => {});
    },
    60_000,
    {
      ...systemTimekeeper,
      after: (task, ms, fire) => {
        const clear = systemTimekeeper.after(task, ms, fire);
        return () => {
          cleared.push("timer");
          clear();
        };
      },
    },
    owner.signal,
  );
  owner.abort();
  expect(await waiting).toBe("closed");
  expect(seen?.aborted).toBe(true);
  expect(cleared).toEqual(["timer"]);
});

test("a wait begun after its owner closed ends at once", async () => {
  const owner = new AbortController();
  owner.abort();
  expect(
    await waitWithin(
      "test wait",
      () => new Promise(() => {}),
      60_000,
      systemTimekeeper,
      owner.signal,
    ),
  ).toBe("closed");
});
