// A stored JSON document with a read and a guarded update.
// [LAW:one-type-per-behavior] Every such file holds to one policy — absent is
// the store's empty value, anything else must read, and nothing is written
// over a file that does not — so the policy is this one store, and each file
// supplies its locations, empty value and parser.
//
// [LAW:effects-at-boundaries] The parsers are pure; the file is read and
// planned here and published by the shared file writer.

import fs from "node:fs";
import path from "node:path";
import { asError, linkChain } from "../utils/atomic-write.js";
import { writeRevisions, type FileRewrite } from "./file-rewrites.js";
import { ok, type Asked } from "../utils/outcome.js";
import { readTextIfPresent } from "../utils/regular-text.js";

export interface StateObservation<T> {
  readonly result: Asked<T>;
  readonly paths: readonly string[];
  // The location supplying the result, or null when neither file exists.
  readonly source: string | null;
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
  // The observed bytes and the changes an explicit update would publish.
  readonly plan: (next: (current: T) => T) => Asked<Planned<T>>;
}

export interface Planned<T> {
  readonly rewrite: FileRewrite | null;
  readonly retire: string | null;
  readonly value: T;
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
  const observe = () => {
    const paths: string[] = [];
    for (const candidate of candidates) {
      paths.push(candidate);
      let text: string | null;
      try {
        text = readText(candidate);
      } catch (e) {
        const result: Asked<T> = {
          kind: "failed",
          reason: asError(e).message,
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
    const { result: current, source, text } = observe();
    if (current.kind === "failed") return current;
    const value = next(current.value);
    const promote = source !== null && source !== file;
    const rewrite =
      promote || value !== current.value
        ? { file, was: source === file ? text : null, will: textOf(value) }
        : null;
    return {
      kind: "ok",
      value: {
        rewrite,
        retire: previousName(file, previous, source),
        value,
      },
    };
  };
  return {
    observe,
    read: () => observe().result,
    plan,
    update: (next) => {
      const planned = plan(next);
      if (planned.kind === "failed") return planned;
      const { rewrite, retire, value } = planned.value;
      writeRevisions(rewrite === null ? [] : [rewrite], retire);
      return ok(value);
    },
  };
}

// An explicit update also retires a leftover copy from older installers.
// A name the current book resolves through is still its backing file.
// Compare directory entries without following a final symlink at that entry.
function previousName(
  file: string,
  previous: string | undefined,
  source: string | null,
): string | null {
  if (previous === undefined || source === null) return null;
  if (source === previous) return previous;
  const old = fs.lstatSync(previous, { throwIfNoEntry: false });
  if (!old?.isFile() && !old?.isSymbolicLink()) return null;
  const entry = (at: string): string =>
    path.join(fs.realpathSync.native(path.dirname(at)), path.basename(at));
  const oldEntry = entry(previous);
  return linkChain(file).some((hop) => entry(hop) === oldEntry)
    ? null
    : previous;
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
