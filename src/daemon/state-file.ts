// A stored JSON document with a read and a guarded update.
// [LAW:one-type-per-behavior] Every such file holds to one policy — absent is
// the store's empty value, anything else must read, and nothing is written
// over a file that does not: a write planned from a read that failed sets the
// file aside beside itself first and starts from the empty value — so the
// policy is this one store, and each file supplies its locations, empty value
// and parser.
//
// [LAW:effects-at-boundaries] The parsers are pure; the file is read and
// planned here and published by the shared file writer.

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { asError, linkChain } from "../utils/atomic-write.js";
import type { FileRetirement, FileRewrite } from "./file-rewrites.js";
import { ok, type Asked, type Ok } from "../utils/outcome.js";
import { readTextIfPresent } from "../utils/regular-text.js";

// [LAW:types-are-the-program] A failure names the location that did not read,
// so a write planned from it knows what to set aside.
export interface Unread {
  readonly kind: "failed";
  readonly reason: string;
  readonly file: string;
}

export interface StateObservation<T> {
  readonly result: Ok<T> | Unread;
  readonly paths: readonly string[];
  // The location supplying the result, or null when neither file exists.
  readonly source: string | null;
}

export interface StateFile<T> {
  readonly observe: () => StateObservation<T>;
  readonly read: () => Asked<T>;
  // The observed bytes and the changes an explicit update would publish.
  readonly plan: (next: (current: T) => T) => Asked<Planned<T>>;
}

export interface Planned<T> {
  // A file that did not read, renamed aside before anything is written.
  readonly setAside: FileRetirement | null;
  readonly rewrite: FileRewrite | null;
  readonly retire: FileRetirement | null;
  readonly value: T;
}

// [LAW:single-enforcer] What any write planned from an observation starts
// from. A file that read, or none, is the value it holds. One that did not is
// renamed aside under a name no reader searches, and the write starts from
// empty, so no store ever writes over bytes it could not read, and none has
// to wait for a person to repair the file before it saves again.
export function writeBase<T>(
  observed: StateObservation<T>,
  empty: T,
): { readonly current: T; readonly setAside: SetAside | null } {
  const { result } = observed;
  return result.kind === "ok"
    ? { current: result.value, setAside: null }
    : {
        current: empty,
        setAside: {
          from: result.file,
          to: `${result.file}.unread-${randomUUID()}`,
          reason: result.reason,
        },
      };
}

// A file that did not read, the name it is kept under, and why it did not.
export interface SetAside extends FileRetirement {
  readonly reason: string;
}

// [LAW:one-source-of-truth] How every state file spells what it holds.
const textOf = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

// [LAW:one-source-of-truth] Only absence advances to an older location.
// The paths actually consulted are the watch dependencies of this result.
// Writes always use the current location and carry forward the old contents.
export function stateFile<T>(
  locations: readonly [current: string, previous?: string],
  empty: T,
  parse: (doc: unknown) => Asked<T>,
  readText: (file: string) => string | null = readTextIfPresent,
): StateFile<T> {
  const [file, previous] = locations;
  const candidates = previous === undefined ? [file] : [file, previous];
  // The observed bytes ride along for the plan's restore.
  const observe = (): StateObservation<T> & {
    readonly text: string | null;
  } => {
    const paths: string[] = [];
    for (const candidate of candidates) {
      paths.push(candidate);
      let text: string | null;
      try {
        text = readText(candidate);
      } catch (e) {
        const result: Unread = {
          kind: "failed",
          reason: asError(e).message,
          file: candidate,
        };
        return { result, paths, source: candidate, text: null };
      }
      if (text === null) continue;
      return {
        result: documentAt(candidate, text, parse),
        paths,
        source: candidate,
        text,
      };
    }
    return { result: ok(empty), paths, source: null, text: null };
  };
  const plan = (next: (current: T) => T): Asked<Planned<T>> => {
    const observed = observe();
    const { current, setAside } = writeBase(observed, empty);
    const { source } = observed;
    const text = observed.result.kind === "ok" ? observed.text : null;
    const value = next(current);
    // [LAW:one-source-of-truth] The same observation supplies both the
    // value and the precise bytes to restore if another write fails. A file
    // set aside is gone from its name before the write, so it restores as
    // absent there and the set-aside is undone after it.
    const promote = source !== null && source !== file;
    const rewrite =
      promote || setAside !== null || value !== current
        ? { file, was: source === file ? text : null, will: textOf(value) }
        : null;
    try {
      const old =
        setAside === null ? previousName(file, previous, source) : null;
      const retire =
        old === null
          ? null
          : { from: old, to: `${old}.migrated-${randomUUID()}` };
      return ok({ setAside, rewrite, retire, value });
    } catch (e) {
      return {
        kind: "failed",
        reason: `cannot inspect the former state file ${previous}: ${asError(e).message}`,
      };
    }
  };
  return {
    observe: () => {
      const { text: _bytes, ...observed } = observe();
      return observed;
    },
    read: () => observe().result,
    plan,
  };
}

// [LAW:single-enforcer] An explicit update retires a leftover legacy name.
// A name the current book resolves through is still its backing file.
// Compare directory entries without following a final symlink at that entry.
function previousName(
  file: string,
  previous: string | undefined,
  source: string | null,
): string | null {
  if (previous === undefined) return null;
  if (source === previous) return previous;
  const old = fs.lstatSync(previous, { throwIfNoEntry: false });
  if (!old?.isFile() && !old?.isSymbolicLink()) return null;
  const entry = (at: string): string | null => {
    try {
      return path.join(
        fs.realpathSync.native(path.dirname(at)),
        path.basename(at),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  };
  const oldEntry = entry(previous);
  return linkChain(file).some((hop) => entry(hop) === oldEntry)
    ? null
    : previous;
}

function documentAt<T>(
  file: string,
  text: string,
  parse: (doc: unknown) => Asked<T>,
): Ok<T> | Unread {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return {
      kind: "failed",
      reason: `${file} is not JSON: ${(e as Error).message}`,
      file,
    };
  }
  const parsed = parse(doc);
  return parsed.kind === "ok"
    ? parsed
    : { kind: "failed", reason: `${file} ${parsed.reason}`, file };
}
