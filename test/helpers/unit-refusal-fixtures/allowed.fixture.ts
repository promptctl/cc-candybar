import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// What a unit test may do, and must stay passing: read a file the package holds,
// build a date from a value, and run on fake time.

test("reads a file the package holds", () => {
  const read = fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8");
  expect(JSON.parse(read).name).toBeDefined();
});

test("builds a date from a value", () => {
  expect(new Date(0).toISOString()).toBe("1970-01-01T00:00:00.000Z");
});

test("waits on a fake timer", () => {
  jest.useFakeTimers();
  try {
    let fired = false;
    setTimeout(() => (fired = true), 10);
    jest.advanceTimersByTime(10);
    expect(fired).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test("fakes the clock with a spy of its own", () => {
  const spy = jest.spyOn(Date, "now").mockReturnValue(42);
  try {
    expect(Date.now()).toBe(42);
  } finally {
    spy.mockRestore();
  }
});

test("promisifies an exists of a file the package holds", async () => {
  await expect(promisify(fs.exists)(path.join(__dirname, "..", "..", "..", "package.json"))).resolves.toBe(true);
});
