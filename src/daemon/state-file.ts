// A stored JSON document with a read and a guarded update.
// [LAW:one-type-per-behavior] Every such file holds to one policy — absent is
// the store's empty value, anything else must read, and nothing is written
// over a file that does not — so the policy is this one store, and each file
// differs only in its name, its empty value and its parser.
//
// [LAW:effects-at-boundaries] The parsers are pure; the file is read and
// written only here.

import { types } from "node:util";
import { writeAtomic } from "../utils/atomic-write.js";
import { ok, type Asked } from "../utils/outcome.js";
import { readTextIfPresent } from "../utils/regular-text.js";

export interface StateObservation<T> {
  readonly result: Asked<T>;
  readonly paths: readonly string[];
}

export interface StateFile<T> {
  readonly observe: () => StateObservation<T>;
  readonly read: () => Asked<T>;
  // The file with `next` of what it holds, and what it holds now — or, when
  // the file does not read, that failure, with nothing filed: a document's
  // other contents are never lost to a filing. A `next` that returns what it
  // was given writes only when promoting an older file. Only a write that
  // fails throws.
  readonly update: (next: (current: T) => T) => Asked<T>;
  // What `update` would write, unwritten: the file, its next text — null when
  // neither a change nor a promotion is needed — and the value, so a caller that lands
  // several files together writes this one with the rest.
  readonly plan: (next: (current: T) => T) => Asked<Planned<T>>;
}

export interface Planned<T> {
  readonly file: string;
  readonly text: string | null;
  readonly value: T;
}

// [LAW:one-source-of-truth] How every state file spells what it holds.
const textOf = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

// [LAW:one-source-of-truth] Only absence advances to an older location.
// The paths actually consulted are the watch dependencies of this result.
// Writes always use the current location and carry forward the old contents.
export function stateFile<T>(
  locations: readonly [string, ...string[]],
  empty: T,
  parse: (doc: unknown) => Asked<T>,
  readText: (file: string) => string | null = readTextIfPresent,
): StateFile<T> {
  const file = locations[0];
  const observe = () => {
    const paths: string[] = [];
    for (const candidate of locations) {
      paths.push(candidate);
      let text: string | null;
      try {
        text = readText(candidate);
      } catch (e) {
        const result: Asked<T> = {
          kind: "failed",
          reason: types.isNativeError(e) ? e.message : String(e),
        };
        return { result, paths, source: candidate };
      }
      if (text === null) continue;
      return {
        result: documentAt(candidate, text, parse),
        paths,
        source: candidate,
      };
    }
    return { result: ok(empty), paths, source: null };
  };
  const plan = (next: (current: T) => T): Asked<Planned<T>> => {
    const { result: current, source } = observe();
    if (current.kind === "failed") return current;
    const value = next(current.value);
    const promote = source !== null && source !== file;
    return {
      kind: "ok",
      value: {
        file,
        text: promote || value !== current.value ? textOf(value) : null,
        value,
      },
    };
  };
  return {
    observe,
    read: () => observe().result,
    plan,
    update: (next) => written(plan(next)),
  };
}

function documentAt<T>(
  file: string,
  text: string,
  parse: (doc: unknown) => Asked<T>,
): Asked<T> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return {
      kind: "failed",
      reason: `${file} is not JSON: ${(e as Error).message}`,
    };
  }
  const parsed = parse(doc);
  return parsed.kind === "ok"
    ? parsed
    : { kind: "failed", reason: `${file} ${parsed.reason}` };
}

// [LAW:single-enforcer] A plan written: its text, when it has any.
function written<T>(planned: Asked<Planned<T>>): Asked<T> {
  if (planned.kind === "failed") return planned;
  const { file, text, value } = planned.value;
  if (text !== null) writeAtomic(file, text);
  return { kind: "ok", value };
}
