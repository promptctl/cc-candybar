import { createHash } from "node:crypto";

// [LAW:types-are-the-program] A value JSON writes as itself: primitives,
// arrays, and objects whose fields are plain, optional fields included. A Set,
// a Map, a Date, a function or a symbol anywhere inside is `never`, because
// `JSON.stringify` writes the first three as `{}` and drops the last two, so a
// digest of one would miss whatever it held; a bigint it refuses to write. So
// is a field typed `unknown` or `any`: it admits any of them.
export type Plain<T> = unknown extends T
  ? never
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends
          | ReadonlySet<unknown>
          | ReadonlyMap<unknown, unknown>
          | Date
          | ((...args: never[]) => unknown)
          | symbol
          | bigint
      ? never
      : T extends ReadonlyArray<infer E>
        ? ReadonlyArray<Plain<E>>
        : { readonly [K in keyof T]: Plain<T[K]> };

// [LAW:types-are-the-program] An object written as the projection of a `T`:
// every key of `T`, optional ones included, and no other. Used with
// `satisfies`, so a field added to `T` fails to compile until its projection
// names it.
export type Projection<T> = { readonly [K in keyof T]-?: unknown };

// The identity of a plain value. Written `T & Plain<T>` because a constraint
// `T extends Plain<T>` is circular (TS2313).
export function digestOf<T>(value: T & Plain<T>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
