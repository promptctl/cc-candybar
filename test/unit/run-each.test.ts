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

test("deep, shared and uninspectable values preserve all aggregate members", () => {
  let deep: unknown = "deep";
  for (let i=0;i<10000;i++) deep = { left: deep, right: deep };
  const unsafe = Object.defineProperty(new Error(), "message", { get() { throw new Error("getter"); } });
  const errors = [deep, unsafe, { unsafe }, Proxy.revocable({}, {}).proxy];
  let aggregate: unknown;
  try { runEach(errors.map(value => () => { throw value; })); } catch (e) { aggregate = e; }
  expect(aggregate).toBeInstanceOf(AggregateError);
  expect((aggregate as AggregateError).message.length).toBeLessThan(4200);
  (aggregate as AggregateError).errors.forEach((value, index) => expect(value).toBe(errors[index]));
});
