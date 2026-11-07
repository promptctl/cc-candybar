// A JSON document kept under the daemon's state directory: the answers for
// repositories, the doctor's mark book, the terminals clicked from, the
// post-mortems filed read.
//
// [LAW:one-type-per-behavior] Every such file holds to one policy — absent is
// the store's empty value, anything else must read, and nothing is written
// over a file that does not — so the policy is this one store, and each file
// differs only in its name, its empty value and its parser.
//
// [LAW:effects-at-boundaries] The parsers are pure; the file is read and
// written only here, through the disk its owner holds.

import path from "node:path";
import type { Filesystem, FilesystemReads } from "./filesystem.js";
import { writeAtomicOn } from "../utils/atomic-write.js";
import type { Asked } from "../utils/outcome.js";

export interface StateFile<T> {
  readonly read: () => Asked<T>;
  // The file with `next` of what it holds, and what it holds now — or, when
  // the file does not read, that failure, with nothing filed: a document's
  // other contents are never lost to a filing. A `next` that returns what it
  // was given writes nothing. Only a write that fails throws.
  readonly update: (next: (current: T) => T) => Asked<T>;
}

// [LAW:types-are-the-program] The document at `file` as a reader finds it,
// over a disk that cannot write: how a config load reads the answers book.
// `parse` reads the parsed document; its failure reason is told after the
// file's name ("<file> is not a list of terminals"). Only cc-candybar writes
// these files, so text that does not read is that failure, never the empty
// value.
export function readStateFile<T>(
  reads: FilesystemReads,
  file: string,
  empty: T,
  parse: (doc: unknown) => Asked<T>,
): Asked<T> {
  let text: string;
  try {
    text = reads.readFileSync(file);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
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
}

// The store named `name` under the daemon's state directory.
// [LAW:one-source-of-truth] The directory is always given. `cc-candybar
// doctor` reads the stores in the daemon's answer
// (src/doctor/daemon-answer.ts), never at a path of its own guessing. The
// answers for repositories are read by every config load — the daemon's,
// `check`'s, the doctor's, the demo's — in its own state directory, as it
// reads the link key there.
export function stateFile<T>(
  disk: Filesystem,
  dir: string,
  name: string,
  empty: T,
  parse: (doc: unknown) => Asked<T>,
): StateFile<T> {
  const file = path.join(dir, name);
  const read = (): Asked<T> => readStateFile(disk, file, empty, parse);
  return {
    read,
    update: (next) => {
      const current = read();
      if (current.kind === "failed") return current;
      const value = next(current.value);
      if (value !== current.value) {
        writeAtomicOn(disk, file, `${JSON.stringify(value, null, 2)}\n`);
      }
      return { kind: "ok", value };
    },
  };
}
