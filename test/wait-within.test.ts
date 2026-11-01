import { afterRealTime, waitWithin } from "../src/utils/reading";

const after = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const unexpected = (e: unknown): void => {
  throw new Error(`no late failure was expected: ${String(e)}`);
};

test("work that ends inside the time answers, and its signal is aborted once the wait ends", async () => {
  let seen: AbortSignal | undefined;
  const end = await waitWithin(
    async (signal) => {
      seen = signal;
      await after(10);
    },
    1000,
    unexpected,
    afterRealTime,
  );
  expect(end).toBe("answered");
  expect(seen?.aborted).toBe(true);
});

test("work still out at the deadline ends the wait there, and its signal aborts", async () => {
  let seen: AbortSignal | undefined;
  const end = await waitWithin(
    (signal) => {
      seen = signal;
      return after(1000);
    },
    20,
    unexpected,
    afterRealTime,
  );
  expect(end).toBe("deadline");
  expect(seen?.aborted).toBe(true);
});

test("a wait ends when its time does, and not before", async () => {
  jest.useFakeTimers();
  try {
    let end: string | undefined;
    void waitWithin(
      () => new Promise(() => {}),
      110,
      unexpected,
      afterRealTime,
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
      () => Promise.reject(new Error("bug")),
      1000,
      unexpected,
      afterRealTime,
    ),
  ).rejects.toThrow("bug");
});

test("a rejection after the deadline goes to its owner's report, never dropped", async () => {
  const late: unknown[] = [];
  const end = await waitWithin(
    async () => {
      await after(30);
      throw new Error("late bug");
    },
    5,
    (e) => late.push(e),
    afterRealTime,
  );
  expect(end).toBe("deadline");
  await after(60);
  expect(late).toEqual([new Error("late bug")]);
});
