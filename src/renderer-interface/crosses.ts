// [LAW:types-are-the-program] Whether a value crosses a process as it is:
// what JSON carries, and nothing it would lose or change on the way. A
// function, a Map or Set, a symbol or a bigint does not cross, nor
// `undefined` in a list, which JSON writes as null. A named field that may be
// `undefined` crosses, because JSON leaves the key out and the far side reads
// the field as `undefined` again. A record's value does not: there a key held
// at `undefined` says something its absence does not (an environment overlay
// unsets the variable), and JSON drops the key. A number crosses whatever it counts: a
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

// A key an empty object has is an index signature's (`string`, `number`, a
// template), so its `undefined` is a key JSON drops; a named key's is one it
// leaves out.
type Fields<T, D extends readonly unknown[]> = {
  [K in keyof T]-?: {} extends Record<K, 1>
    ? Each<T[K], D>
    : Each<Exclude<T[K], undefined>, D>;
}[keyof T];

export type Crosses<T> = [Exclude<Each<T, DEPTH>, true>] extends [never]
  ? true
  : Exclude<Each<T, DEPTH>, true>;

// A reach of one side into the other crosses when what it is handed does and
// it answers nothing, a notice, or a promise of what crosses, an awaited call.
// Its arguments are a list, so an `undefined` among them arrives as null.
export interface CannotReach<Reach> {
  readonly cannotReach: Reach;
}

// `any` passes for `void` unread, so it is named first, as `Part` names it.
type Answer<R> = 0 extends 1 & R
  ? CannotReach<R>
  : [R] extends [void]
    ? true
    : [R] extends [Promise<infer V>]
      ? 0 extends 1 & V
        ? CannotReach<R>
        : [V] extends [void]
          ? true
          : Crosses<V>
      : CannotReach<R>;

type Reach<T> = [T] extends [(...args: infer A) => infer R]
  ? [Exclude<Crosses<A> | Answer<R>, true>] extends [never]
    ? true
    : CannotReach<T>
  : [T] extends [object]
    ? { [K in keyof T]-?: Reach<T[K]> }[keyof T]
    : CannotReach<T>;

// `Reaches<T>` is `true` when every reach in `T`, a group of them included,
// crosses, and otherwise names each that does not.
export type Reaches<T> = [Exclude<Reach<T>, true>] extends [never]
  ? true
  : Exclude<Reach<T>, true>;
