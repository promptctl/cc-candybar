// Every step runs whatever one before it threw (src/utils/run-each.ts), and
// what they threw comes out once they all have: a lone throw as it was.

import { runEach } from "../../src/utils/run-each";

test("every step runs, and a lone throw comes out as it was thrown", () => {
  const ran: number[] = [];
  const broke = new TypeError("two broke");
  let caught: unknown;
  try {
    runEach([
      () => ran.push(1),
      () => {
        throw broke;
      },
      () => ran.push(3),
    ]);
  } catch (error) {
    caught = error;
  }
  expect(ran).toEqual([1, 3]);
  expect(caught).toBe(broke);
});

test("several throws come out together, in the order the steps ran", () => {
  const thrown = (message: string) => () => {
    throw new Error(message);
  };
  let caught: unknown;
  try {
    runEach([thrown("a"), thrown("b")]);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect(
    (caught as AggregateError).errors.map((e: Error) => e.message),
  ).toEqual(["a", "b"]);
});

test("steps that all run cleanly throw nothing", () => {
  expect(() => runEach([() => {}, () => {}])).not.toThrow();
});
