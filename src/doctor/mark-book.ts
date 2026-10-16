// The marks the user has made on what the doctor showed them, kept for good.
//
// [LAW:one-source-of-truth] A mark answers for a sighting — a terminal, the
// font it was read to draw with, and the glyphs shown (Sighting.id) — which is
// a fact about the machine, not about the session that showed it. So the book
// is one file under the daemon's state directory, read by the bar's doctor
// and by `cc-candybar doctor` alike: a mark made in one session answers in the
// next, and in the CLI, which has no session to make one in.
//
// [LAW:effects-at-boundaries] `parseMarkBook` and `withMark` are pure; the
// file is read and written only by `fileMarkBook`, which the doctor edge
// carries (src/doctor/edge.ts).

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../daemon/paths.js";
import { writeAtomic } from "../utils/atomic-write.js";
import {
  MARKS,
  markOf,
  type Asked,
  type Mark,
  type MarkBook,
  type MarkedCheck,
} from "./checks.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// [LAW:parse-dont-validate] The file's text as a MarkBook — check name, then
// sighting id, then the mark. Only the doctor writes the file, so text that
// does not read is a failure naming the file, never an empty book; it fails
// only the check that reads marks, never the doctor's other checks.
export function parseMarkBook(text: string, file: string): Asked<MarkBook> {
  const fault = (why: string): Asked<MarkBook> => ({
    kind: "failed",
    reason: `${file} ${why}`,
  });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return fault(`is not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(doc)) return fault("is not an object");
  for (const [check, sightings] of Object.entries(doc)) {
    if (!isRecord(sightings)) {
      return fault(
        `holds ${JSON.stringify(check)} as something other than its sightings`,
      );
    }
    if (!Object.hasOwn(MARKS, check)) {
      return fault(
        `holds marks for ${JSON.stringify(check)}, which takes none`,
      );
    }
    for (const [id, mark] of Object.entries(sightings)) {
      if (typeof mark !== "string" || markOf(check, mark) === null) {
        return fault(
          `marks ${JSON.stringify(id)} ${JSON.stringify(mark)}, not ${MARKS[check as MarkedCheck].join(" or ")}`,
        );
      }
    }
  }
  return { kind: "ok", value: doc as MarkBook };
}

// The book with one mark made: the latest mark on a sighting is its answer.
export function withMark(
  book: MarkBook,
  { check, mark }: Mark,
  sighting: string,
): MarkBook {
  return { ...book, [check]: { ...book[check], [sighting]: mark } };
}

export interface MarkBookStore {
  readonly read: () => Asked<MarkBook>;
  // Throws when the book cannot be read: a mark is never filed over a book
  // whose other marks would be lost.
  readonly record: (mark: Mark, sighting: string) => void;
}

// The book as a file: absent is the empty book, anything else must read.
export function fileMarkBook(
  file: string = path.join(stateDir(), "doctor-marks.json"),
): MarkBookStore {
  const read = (): Asked<MarkBook> => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "ok", value: {} };
      }
      return { kind: "failed", reason: `${file}: ${(e as Error).message}` };
    }
    return parseMarkBook(text, file);
  };
  return {
    read,
    record: (mark, sighting) => {
      const book = read();
      if (book.kind === "failed") {
        throw new Error(
          `doctor: the mark book could not be read: ${book.reason}`,
        );
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(
        file,
        `${JSON.stringify(withMark(book.value, mark, sighting), null, 2)}\n`,
      );
    },
  };
}
