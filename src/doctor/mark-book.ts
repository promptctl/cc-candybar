// The marks the user has made on what the doctor showed them, kept for good.
//
// [LAW:one-source-of-truth] A mark answers for a sighting — a terminal, the
// font it was read to draw with, and the glyphs shown (Sighting.id) — which is
// a fact about the machine, not about the session that showed it. So the book
// is one file under the daemon's state directory, read by the bar's doctor
// and, in the daemon's answer, by `cc-candybar doctor` alike: a mark made in one session answers in the
// next, and in the CLI, which has no session to make one in.

import {
  GLYPH_MARKS,
  type Asked,
  type GlyphMark,
  type MarkBook,
} from "./checks.js";
import { stateFile, type StateFile } from "./state-file.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// [LAW:parse-dont-validate] The document as a MarkBook — check name, then
// sighting id, then the mark. A book that does not read fails only the check
// that reads marks, never the doctor's other checks.
export function parseMarkBook(doc: unknown): Asked<MarkBook> {
  const fault = (reason: string): Asked<MarkBook> => ({
    kind: "failed",
    reason,
  });
  if (!isRecord(doc)) return fault("is not an object");
  for (const [check, sightings] of Object.entries(doc)) {
    if (!isRecord(sightings)) {
      return fault(
        `holds ${JSON.stringify(check)} as something other than its sightings`,
      );
    }
    for (const [id, mark] of Object.entries(sightings)) {
      if (!(GLYPH_MARKS as readonly unknown[]).includes(mark)) {
        return fault(
          `marks ${JSON.stringify(id)} ${JSON.stringify(mark)}, not ${GLYPH_MARKS.join(" or ")}`,
        );
      }
    }
  }
  return { kind: "ok", value: doc as MarkBook };
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

export const fileMarkBook = (dir: string): StateFile<MarkBook> =>
  stateFile(dir, "doctor-marks.json", {}, parseMarkBook);
