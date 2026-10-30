import { digestOf, type Projection } from "../src/utils/plain";

// [LAW:types-are-the-program] What a load key covers is decided by the type
// checker: these cases are checked by typecheck, which covers test/, and an
// `@ts-expect-error` that stops erroring fails it.

interface WithOptional {
  readonly a?: string;
  readonly b: number;
}

test("a digest takes plain values, optional fields included, and names them by content", () => {
  const optional: WithOptional = { b: 1 };
  expect(digestOf(optional)).toBe(digestOf({ b: 1 }));
  expect(digestOf({ a: [1, "x", null], b: { c: true } })).toMatch(
    /^[0-9a-f]{64}$/,
  );
  expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
});

test("a value JSON would write as {} or drop is not a digest's input", () => {
  // @ts-expect-error a Set is written as {}
  digestOf({ held: new Set([1]) });
  // @ts-expect-error a Map is written as {}
  digestOf({ nested: [{ held: new Map([[1, 2]]) }] });
  // @ts-expect-error a function is dropped
  digestOf({ read: () => 1 });
  // @ts-expect-error a Date is written as a string it no longer is
  digestOf({ at: new Date() });
  // @ts-expect-error a symbol is dropped
  digestOf({ tag: Symbol("x") });
  // @ts-expect-error a bigint is refused at runtime
  expect(() => digestOf({ size: 1n })).toThrow(TypeError);
  const opaque: unknown = new Map([[1, 2]]);
  // @ts-expect-error a field typed `unknown` admits a Map
  digestOf({ held: opaque });
});

test("a projection names every field of what it projects, and no other", () => {
  const whole = { a: 1, b: null } satisfies Projection<WithOptional>;
  expect(whole).toEqual({ a: 1, b: null });
  // @ts-expect-error a field left out
  const missing = { b: 1 } satisfies Projection<WithOptional>;
  // @ts-expect-error a field the source does not have
  const extra = { a: 1, b: 1, c: 1 } satisfies Projection<WithOptional>;
  expect([missing, extra]).toHaveLength(2);
});
