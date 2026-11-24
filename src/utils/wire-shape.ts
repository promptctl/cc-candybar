// [LAW:parse-dont-validate] What a reader reads of a value another process
// wrote: a shape declared against the reader's own type, so `tsc` refuses one
// that leaves out a field, an arm of a union, a null the type admits or a
// member of a set of words. One interpreter reads a value against it and
// names each path at which the value is not what the type says; a value with
// none is that type. A field the reader does not declare is not read, so a
// later build's addition is no miss.

export interface Shape<T> {
  // The paths at or below `at` at which `value` is not what the type says.
  readonly misses: (value: unknown, at: string) => readonly string[];
  // [LAW:types-are-the-program] Invariant in T: a shape of `number` is no
  // shape of `number | null`, nor a set of words a shape of a wider one.
  readonly of?: (value: T) => T;
}

// What a value read against a shape is: the type, or where it is not.
export type Read<T> =
  | { readonly kind: "read"; readonly value: T }
  | { readonly kind: "missed"; readonly at: readonly string[] };

export function read<T>(shape: Shape<T>, value: unknown): Read<T> {
  const at = shape.misses(value, "");
  // [LAW:types-are-the-program] The one cast: a value no path of whose
  // shape misses is a T by the shape's declaration against T.
  return at.length === 0
    ? { kind: "read", value: value as T }
    : { kind: "missed", at };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const below = (at: string, key: string): string =>
  at === "" ? key : `${at}.${key}`;
const leaf = <T>(is: (value: unknown) => boolean): Shape<T> => ({
  misses: (value, at) => (is(value) ? [] : [at]),
});

export const number: Shape<number> = leaf(
  (value) => typeof value === "number" && Number.isFinite(value),
);
export const text: Shape<string> = leaf((value) => typeof value === "string");
export const flag: Shape<boolean> = leaf((value) => typeof value === "boolean");

// One of a set of words, each named once: `tsc` refuses a set that leaves one
// out, and a word another build added is a miss.
export const word = <T extends string>(
  members: Readonly<Record<T, true>>,
): Shape<T> =>
  leaf((value) => typeof value === "string" && Object.hasOwn(members, value));

// One of the words a list holds, the list the type is read from.
export const oneOf = <const A extends readonly string[]>(
  members: A,
): Shape<A[number]> =>
  leaf(
    (value) =>
      typeof value === "string" &&
      (members as readonly string[]).includes(value),
  );

// A string its own parse admits: a branded one.
export const parsedText = <T extends string>(
  parse: (raw: string) => T | null,
): Shape<T> =>
  leaf((value) => typeof value === "string" && parse(value) !== null);

export const nullable = <T>(of: Shape<T>): Shape<T | null> => ({
  misses: (value, at) => (value === null ? [] : of.misses(value, at)),
});

export const list = <T>(of: Shape<T>): Shape<T[]> & Shape<readonly T[]> => ({
  misses: (value, at) =>
    Array.isArray(value)
      ? value.flatMap((item, i) => of.misses(item, `${at}[${i}]`))
      : [at],
});

// A record of any keys the key's shape admits, each value of one shape.
export const entries = <T extends Readonly<Record<string, unknown>>>(
  key: Shape<keyof T & string>,
  of: Shape<NonNullable<T[keyof T]>>,
): Shape<T> => ({
  misses: (value, at) =>
    isRecord(value)
      ? Object.entries(value).flatMap(([k, v]) => [
          ...key.misses(k, below(at, k)),
          ...of.misses(v, below(at, k)),
        ])
      : [at],
});

// Every field of an object type, each its own shape.
export type Fields<T> = { readonly [K in keyof T]-?: Shape<T[K]> };

interface AnyShape {
  readonly misses: Shape<unknown>["misses"];
}

function fieldMisses(
  fields: Readonly<Record<string, AnyShape>>,
  value: Readonly<Record<string, unknown>>,
  at: string,
): string[] {
  return Object.entries(fields).flatMap(([key, shape]) =>
    shape.misses(value[key], below(at, key)),
  );
}

export const object = <T>(fields: Fields<T>): Shape<T> => ({
  misses: (value, at) =>
    isRecord(value)
      ? fieldMisses(fields as Readonly<Record<string, AnyShape>>, value, at)
      : [at],
});

// [LAW:types-are-the-program] A union tagged by `kind`: an arm for each tag,
// each every field but the tag. A tag no arm names is a miss at the tag.
type Arms<T extends { readonly kind: string }> = {
  readonly [V in T["kind"]]: Fields<
    Omit<Extract<T, { readonly kind: V }>, "kind">
  >;
};

export const tagged = <T extends { readonly kind: string }>(
  arms: Arms<T>,
): Shape<T> => ({
  misses: (value, at) => {
    if (!isRecord(value)) return [at];
    const tag = value.kind;
    const arm =
      typeof tag === "string" && Object.hasOwn(arms, tag)
        ? (
            arms as Readonly<Record<string, Readonly<Record<string, AnyShape>>>>
          )[tag]
        : undefined;
    return arm === undefined
      ? [below(at, "kind")]
      : fieldMisses(arm, value, at);
  },
});
