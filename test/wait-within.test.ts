import { waitWithin } from "../src/utils/reading";
import { systemTimekeeper } from "./helpers/system-clock";

const after = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The owner of a wait that never closes.
const OPEN = new AbortController().signal;

const unexpected = (e: unknown): void => {
  throw new Error(`no late failure was expected: ${String(e)}`);
};

test("work that ends inside the time answers, and its signal is aborted once the wait ends", async () => {
  let seen: AbortSignal | undefined;
  const end = await waitWithin(
    "test wait",
    async (signal) => {
      seen = signal;
      await after(10);
    },
    1000,
    unexpected,
    systemTimekeeper.after,
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
    unexpected,
    systemTimekeeper.after,
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
      unexpected,
      systemTimekeeper.after,
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
      unexpected,
      systemTimekeeper.after,
      OPEN,
    ),
  ).rejects.toThrow("bug");
});

test("a rejection after the deadline goes to its owner's report, never dropped", async () => {
  const late: unknown[] = [];
  const end = await waitWithin(
    "test wait",
    async () => {
      await after(30);
      throw new Error("late bug");
    },
    5,
    (e, ended) => late.push([e, ended]),
    systemTimekeeper.after,
    OPEN,
  );
  expect(end).toBe("deadline");
  await after(60);
  expect(late).toEqual([[new Error("late bug"), "deadline"]]);
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
    unexpected,
    (task, ms, fire) => {
      const clear = systemTimekeeper.after(task, ms, fire);
      return () => {
        cleared.push("timer");
        clear();
      };
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
      unexpected,
      systemTimekeeper.after,
      owner.signal,
    ),
  ).toBe("closed");
});
