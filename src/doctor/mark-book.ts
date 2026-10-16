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
import { GLYPH_MARKS, type GlyphMark, type MarkBook } from "./checks.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// [LAW:parse-dont-validate] The file's text as a MarkBook — check name, then
// sighting id, then the mark. Only the doctor writes the file, so text that
// does not read is a fault to name, never an empty book.
export function parseMarkBook(text: string, file: string): MarkBook {
  const fault = (why: string): Error =>
    new Error(`doctor: the mark book ${file} ${why}`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw fault(`is not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(doc)) throw fault("is not an object");
  return Object.fromEntries(
    Object.entries(doc).map(([check, sightings]) => {
      if (!isRecord(sightings)) {
        throw fault(
          `holds ${JSON.stringify(check)} as something other than its sightings`,
        );
      }
      for (const [id, mark] of Object.entries(sightings)) {
        if (!(GLYPH_MARKS as readonly unknown[]).includes(mark)) {
          throw fault(
            `marks ${JSON.stringify(id)} ${JSON.stringify(mark)}, not ${GLYPH_MARKS.join(" or ")}`,
          );
        }
      }
      return [check, sightings as Readonly<Record<string, GlyphMark>>];
    }),
  );
}

// The book with one mark made: the latest mark on a sighting is its answer.
export function withMark(
  book: MarkBook,
  check: string,
  sighting: string,
  mark: GlyphMark,
): MarkBook {
  return { ...book, [check]: { ...book[check], [sighting]: mark } };
}

export interface MarkBookStore {
  readonly read: () => MarkBook;
  readonly record: (check: string, sighting: string, mark: GlyphMark) => void;
}

// The book as a file: absent is the empty book, anything else must read.
export function fileMarkBook(
  file: string = path.join(stateDir(), "doctor-marks.json"),
): MarkBookStore {
  const read = (): MarkBook => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    return parseMarkBook(text, file);
  };
  return {
    read,
    record: (check, sighting, mark) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(
        file,
        `${JSON.stringify(withMark(read(), check, sighting, mark), null, 2)}\n`,
      );
    },
  };
}
