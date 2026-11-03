import { compareStructural } from "mobx";
import type { Instant } from "../utils/instant";
import {
  pendingOf,
  type FailedAt,
  type Outcome,
  type Pending,
  type PendingWhy,
  type Reading,
} from "../utils/outcome";
import { isJsonValue, type JsonValue } from "../var-system/types";

// [LAW:types-are-the-program] One answer to one question, as a facts document
// carries it: not answered yet, or what the read found and when this answer
// first differed from the one before it. The arms are a `Reading` of
// src/utils/outcome.ts with an instant on each answered arm, so a fact is the
// owners' stored value plus a time and nothing else. `at` is the instant of
// the change, not of the read: a read that found the same thing moves nothing.
// `failedAt` is the phase that failed; `at` is when.
export type Answered<T> = Outcome<T> & { readonly at: Instant };
export type Fact<T> = Pending | Answered<T>;

// [LAW:types-are-the-program] What survives `JSON.stringify` and `JSON.parse`
// as itself. A value type that cannot (a Map becomes `{}`, a Promise `{}`, a
// Date a string) maps to `never`, so `AssertWire` refuses it at compile time
// instead of a test finding it later.
type Unwireable =
  | ((...args: never[]) => unknown)
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | PromiseLike<unknown>
  | Date;

export type Wire<T> = T extends string | number | boolean | null
  ? T
  : T extends Unwireable
    ? never
    : T extends ReadonlyArray<infer U>
      ? ReadonlyArray<Wire<U>>
      : T extends object
        ? { readonly [K in keyof T]: Wire<T[K]> }
        : never;

// `true` when T is its own wire form, `never` when it is not: a constant typed
// `AssertWire<T>` and set to `true` is the compile error that names the type.
export type AssertWire<T> = [T] extends [Wire<T>] ? true : never;

// [LAW:single-enforcer] The one definition of `at`: the instant this answer
// first differed from the one before it. An equal outcome (by structure, `at`
// excluded) keeps the prior fact whole, instant included; anything else takes
// `at`. The facts document's assembly calls it once per field against the
// document it replaces, so no owner stores a time and an equal rescan wakes
// nobody. A pending reading comes out as the plain `Pending`, never carrying
// the landing a waiter holds.
export function restamp<T>(
  prior: Fact<T> | undefined,
  next: Reading<T>,
  at: Instant,
): Fact<T> {
  if (next.kind === "pending") return pendingOf(next.why);
  if (prior !== undefined && prior.kind !== "pending") {
    const { at: _at, ...held } = prior;
    if (compareStructural(held, next)) return prior;
  }
  return { ...next, at };
}

// [LAW:parse-dont-validate] The one place a fact arrives from outside: a
// document read off a wire or a recording. It returns a typed `Fact` or throws
// naming where the document is wrong, so nothing downstream tests the shape
// again and a pending that crossed as JSON is a pending, not a value.
export class FactParseError extends Error {
  constructor(where: string, problem: string) {
    super(`${where}: ${problem}`);
    this.name = "FactParseError";
  }
}

const PENDING_WHYS: ReadonlySet<unknown> = new Set<PendingWhy>([
  "unread",
  "superseded",
]);
const FAILED_ATS: ReadonlySet<unknown> = new Set<FailedAt>(["read", "parse"]);

export function parseFact(json: unknown, where: string): Fact<JsonValue> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new FactParseError(where, "is not an object");
  }
  const o = json as Record<string, unknown>;
  const instant = (): Instant => {
    if (typeof o.at !== "number" || !Number.isFinite(o.at)) {
      throw new FactParseError(where, "has no finite `at`");
    }
    return o.at as Instant;
  };
  switch (o.kind) {
    case "pending":
      if (!PENDING_WHYS.has(o.why)) {
        throw new FactParseError(where, `pending for ${String(o.why)}`);
      }
      return pendingOf(o.why as PendingWhy);
    case "ok":
      if (!isJsonValue(o.value)) {
        throw new FactParseError(where, "ok with a value that is not JSON");
      }
      return { kind: "ok", value: o.value, at: instant() };
    case "absent":
      return { kind: "absent", at: instant() };
    case "failed":
      if (typeof o.reason !== "string") {
        throw new FactParseError(where, "failed with no reason");
      }
      if (!FAILED_ATS.has(o.failedAt)) {
        throw new FactParseError(where, `failed at ${String(o.failedAt)}`);
      }
      return {
        kind: "failed",
        reason: o.reason,
        failedAt: o.failedAt as FailedAt,
        at: instant(),
      };
    default:
      throw new FactParseError(where, `has kind ${String(o.kind)}`);
  }
}
