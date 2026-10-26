import { execFileSync } from "child_process";
import path from "path";
import { waitWithin } from "../src/utils/reading";

const after = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("work that ends inside the time answers, and its signal is aborted once the wait ends", async () => {
  let seen: AbortSignal | undefined;
  const end = await waitWithin(async (signal) => {
    seen = signal;
    await after(10);
  }, 1000);
  expect(end).toBe("answered");
  expect(seen?.aborted).toBe(true);
});

test("work still out at the deadline ends the wait there, and its signal aborts", async () => {
  let seen: AbortSignal | undefined;
  const end = await waitWithin((signal) => {
    seen = signal;
    return after(1000);
  }, 20);
  expect(end).toBe("deadline");
  expect(seen?.aborted).toBe(true);
});

test("a rejection inside the time is the wait's", async () => {
  await expect(
    waitWithin(() => Promise.reject(new Error("bug")), 1000),
  ).rejects.toThrow("bug");
});

// In its own process: the test runner takes an unhandled rejection as its
// own failure before a listener here could see it.
test("a rejection after the deadline is thrown on, unhandled, never dropped", () => {
  const printed = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `import { waitWithin } from ${JSON.stringify(path.resolve("src/utils/reading.ts"))};` +
        `process.on("unhandledRejection", (e) => console.log("unhandled:" + e.message));` +
        `const end = await waitWithin(async () => { await new Promise((r) => setTimeout(r, 30)); throw new Error("late bug"); }, 5);` +
        `console.log("end:" + end); await new Promise((r) => setTimeout(r, 60));`,
    ],
    { encoding: "utf8" },
  );
  expect(printed.trim().split("\n")).toEqual(["end:deadline", "unhandled:late bug"]);
});
