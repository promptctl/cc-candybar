// [LAW:types-are-the-program] Whether a value crosses a process as it is:
// what JSON carries, and nothing it would lose or change on the way. A
// function, a Map or Set, a symbol or a bigint does not cross, nor
// `undefined` in a list, which JSON writes as null. A field that may be
// `undefined` crosses, because JSON leaves the key out and the far side reads
// the field as `undefined` again. A number crosses whatever it counts: a
// reading of one process's monotonic clock is a number too, so what an
// `Instant` stands for is the type's to say (src/utils/instant.ts). A number
// crosses only while finite: JSON writes Infinity and NaN as null, and no type
// tells them from a finite number, so a field that can hold one is spelled as
// what arrives (`WireFrame`, src/render/frame.ts) and parsed where it lands.
//
// `Crosses<T>` is `true` when every part of `T` crosses, and otherwise names
// each part that does not, so `const X: Crosses<T> = true` fails the build
// where it fails and says what.
//
// A recursive type (a layout tree, a JSON value) has no bottom, so the check
// reads DEPTH levels and takes what lies below as crossing: a tree repeats
// its node kinds level by level, so every kind it holds is read above that.

export interface CannotCross<Part> {
  readonly cannotCross: Part;
}

type Primitive = string | number | boolean | null;

// The levels left to read, counted down by dropping one element.
type DEPTH = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
type Deeper<D extends readonly unknown[]> = D extends readonly [
  unknown,
  ...infer Rest,
]
  ? Rest
  : [];

// `any` would pass every test below unread, so it is named as not crossing:
// only `0 extends 1 & T` tells it from the types it stands in for.
type Part<T, D extends readonly unknown[]> = D extends []
  ? true
  : 0 extends 1 & T
    ? CannotCross<T>
    : [T] extends [Primitive]
      ? true
      : [T] extends [(...args: never[]) => unknown]
        ? CannotCross<T>
        : [T] extends [ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>]
          ? CannotCross<T>
          : [T] extends [ReadonlyArray<infer E>]
            ? Each<E, Deeper<D>>
            : [T] extends [object]
              ? Fields<T, Deeper<D>>
              : CannotCross<T>;

// Each member of a union on its own, so one that cannot cross is named.
type Each<T, D extends readonly unknown[]> = T extends unknown
  ? Part<T, D>
  : never;

type Fields<T, D extends readonly unknown[]> = {
  [K in keyof T]-?: Each<Exclude<T[K], undefined>, D>;
}[keyof T];

export type Crosses<T> = [Exclude<Each<T, DEPTH>, true>] extends [never]
  ? true
  : Exclude<Each<T, DEPTH>, true>;
