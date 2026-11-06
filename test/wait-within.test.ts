import { waitWithin } from "../src/utils/reading";
import { systemTimekeeper } from "../src/time";

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
    systemTimekeeper.after,
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
    systemTimekeeper.after,
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
      systemTimekeeper.after,
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

// A timer due at once still takes a turn of the loop, and under a backlog that
// turn is every pending request's read and setup: the one failed render of the
// hundred-session gate lost 54 ms there with a budget already below zero.
// What a wait with no time left has ended as by the loop's next phase, and
// whether it armed a timer.
async function beforeTheLoopTurns(
  work: (signal: AbortSignal) => Promise<unknown>,
  ms: number,
): Promise<{ end: string; timers: number }> {
  let timers = 0;
  let end = "still waiting";
  void waitWithin(work, ms, unexpected, (wait, fn) => {
    timers++;
    return systemTimekeeper.after(wait, fn);
  }).then(
    (e) => {
      end = e;
    },
    (e: unknown) => {
      end = `rejected: ${(e as Error).message}`;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { end, timers };
}

test.each([0, -5])(
  "a wait with %d ms left arms no timer and ends before the loop turns, its work aborted",
  async (ms) => {
    let seen: AbortSignal | undefined;
    const ended = await beforeTheLoopTurns((signal) => {
      seen = signal;
      return new Promise(() => {});
    }, ms);
    expect(ended).toEqual({ end: "deadline", timers: 0 });
    expect(seen?.aborted).toBe(true);
  },
);

test("a wait with no time left answers when its work settles without the loop", async () => {
  const settled = async () => {
    for (let i = 0; i < 50; i++) await null;
  };
  expect(await beforeTheLoopTurns(settled, 0)).toEqual({
    end: "answered",
    timers: 0,
  });
});

test("a wait with no time left fails as its own when its work rejects without the loop", async () => {
  const broken = async () => {
    await null;
    throw new Error("bug");
  };
  expect(await beforeTheLoopTurns(broken, 0)).toEqual({
    end: "rejected: bug",
    timers: 0,
  });
});

test("a rejection inside the time is the wait's", async () => {
  await expect(
    waitWithin(
      () => Promise.reject(new Error("bug")),
      1000,
      unexpected,
      systemTimekeeper.after,
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
    systemTimekeeper.after,
  );
  expect(end).toBe("deadline");
  await after(60);
  expect(late).toEqual([new Error("late bug")]);
});
