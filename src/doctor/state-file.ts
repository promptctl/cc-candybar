// A JSON document the doctor keeps under the daemon's state directory: the
// mark book, the terminals clicked from, the post-mortems filed read.
//
// [LAW:one-type-per-behavior] Every such file holds to one policy — absent is
// the store's empty value, anything else must read, and nothing is written
// over a file that does not — so the policy is this one store, and each file
// differs only in its name, its empty value and its parser.
//
// [LAW:effects-at-boundaries] The parsers are pure; the file is read and
// written only here, through the store the doctor edge carries
// (src/doctor/edge.ts).

import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "../utils/atomic-write.js";
import type { Asked } from "./checks.js";

export interface StateFile<T> {
  readonly read: () => Asked<T>;
  // The file with `next` of what it holds, and what it holds now — or, when
  // the file does not read, that failure, with nothing filed: a document's
  // other contents are never lost to a filing. A `next` that returns what it
  // was given writes nothing. Only a write that fails throws.
  readonly update: (next: (current: T) => T) => Asked<T>;
  // What `update` would write, unwritten: the file, its next text — null when
  // `next` returns what it was given — and the value, so a caller that lands
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

// The store named `name` under the daemon's state directory. `parse` reads
// the parsed document; its failure reason is told after the file's name
// ("<file> is not a list of terminals"). Only cc-candybar writes these files,
// so text that does not read is that failure, never the empty value.
// [LAW:one-source-of-truth] The directory is always given: the host's, which
// the daemon and `cc-candybar doctor` both name by the profile's paths, never
// a path of their own guessing. The answers for repositories are read by every config load — the daemon's,
// `check`'s, the doctor's — in its own state directory, as it
// reads the link key there.
export function stateFile<T>(
  dir: string,
  name: string,
  empty: T,
  parse: (doc: unknown) => Asked<T>,
): StateFile<T> {
  const file = path.join(dir, name);
  const read = (): Asked<T> => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "ok", value: empty };
      }
      return { kind: "failed", reason: `${file}: ${(e as Error).message}` };
    }
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
  };
  const plan = (next: (current: T) => T): Asked<Planned<T>> => {
    const current = read();
    if (current.kind === "failed") return current;
    const value = next(current.value);
    return {
      kind: "ok",
      value: {
        file,
        text: value === current.value ? null : textOf(value),
        value,
      },
    };
  };
  return { read, plan, update: (next) => written(plan(next)) };
}

// [LAW:single-enforcer] A plan written: its text, when it has any.
export function written<T>(planned: Asked<Planned<T>>): Asked<T> {
  if (planned.kind === "failed") return planned;
  const { file, text, value } = planned.value;
  if (text !== null) writeAtomic(file, text);
  return { kind: "ok", value };
}
