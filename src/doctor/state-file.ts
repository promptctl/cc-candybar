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
import { writeAtomic } from "../utils/atomic-write.js";
import type { Asked } from "./checks.js";

export interface StateFile<T> {
  readonly read: () => Asked<T>;
  // The file with `next` of what it holds, and what it holds now — or, when
  // the file does not read, that failure, with nothing filed: a document's
  // other contents are never lost to a filing. A `next` that returns what it
  // was given writes nothing. Only a write that fails throws.
  readonly update: (next: (current: T) => T) => Asked<T>;
}

// `parse` reads the parsed document; its failure reason is told after the
// file's name ("<file> is not a list of terminals"). Only the doctor writes
// these files, so text that does not read is that failure, never the empty
// value.
export function stateFile<T>(
  file: string,
  empty: T,
  parse: (doc: unknown) => Asked<T>,
): StateFile<T> {
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
  return {
    read,
    update: (next) => {
      const current = read();
      if (current.kind === "failed") return current;
      const value = next(current.value);
      if (value !== current.value) {
        writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
      }
      return { kind: "ok", value };
    },
  };
}
