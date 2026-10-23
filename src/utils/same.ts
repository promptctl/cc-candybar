// [LAW:types-are-the-program] Whether two values are alike, field by field,
// spelled as a record the compiler holds total over the type's fields: a field
// added to the type is a compile error at every comparison of it until that
// comparison says how the field compares, so none can quietly miss a field
// that a reader of the value reads.

export type Same<T> = (a: T, b: T) => boolean;

export type Fields<T> = { readonly [K in keyof T]-?: Same<T[K]> };

export const is = <T>(a: T, b: T): boolean => a === b;

export function sameBy<T extends object>(fields: Fields<T>): Same<T> {
  const keys = Object.keys(fields) as Array<keyof T>;
  return (a, b) => keys.every((key) => fields[key](a[key], b[key]));
}

export const sameEach =
  <T>(same: Same<T>): Same<readonly T[]> =>
  (a, b) =>
    a.length === b.length && a.every((item, i) => same(item, b[i]!));
