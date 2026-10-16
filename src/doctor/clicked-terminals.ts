// The terminals a doctor click has come back from, kept for good.
//
// [LAW:one-source-of-truth] A doctor click is a link its terminal drew and the
// user clicked, so it settles for good that the terminal draws links — a fact
// about the machine, like a mark, but one the daemon files itself on every
// click rather than one the user makes. So it is its own file beside the mark
// book (src/doctor/mark-book.ts), which holds only the user's word: the bar's
// doctor files a terminal here, and `cc-candybar doctor`, which cannot click,
// reads it.
//
// [LAW:effects-at-boundaries] `parseClickedTerminals` is pure; the file is
// read and written only by `fileClickedTerminals`, which the doctor edge
// carries (src/doctor/edge.ts).

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../daemon/paths.js";
import { writeAtomic } from "../utils/atomic-write.js";
import type { Asked } from "./checks.js";

// [LAW:parse-dont-validate] The file's text as the terminals clicked from —
// each its sighting (`sightingOf`, src/doctor/terminal.ts). Only the doctor
// writes the file, so text that does not read is a failure naming the file,
// never an empty list.
export function parseClickedTerminals(
  text: string,
  file: string,
): Asked<readonly string[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return {
      kind: "failed",
      reason: `${file} is not JSON: ${(e as Error).message}`,
    };
  }
  return Array.isArray(doc) && doc.every((t) => typeof t === "string")
    ? { kind: "ok", value: doc }
    : { kind: "failed", reason: `${file} is not a list of terminals` };
}

export interface ClickedTerminalsStore {
  readonly read: () => Asked<readonly string[]>;
  // Throws when the file cannot be read: a terminal is never filed over a
  // list whose others would be lost. One already filed is not written again.
  readonly record: (sighting: string) => void;
}

// The list as a file: absent is the empty list, anything else must read.
export function fileClickedTerminals(
  file: string = path.join(stateDir(), "doctor-clicked-terminals.json"),
): ClickedTerminalsStore {
  const read = (): Asked<readonly string[]> => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "ok", value: [] };
      }
      return { kind: "failed", reason: `${file}: ${(e as Error).message}` };
    }
    return parseClickedTerminals(text, file);
  };
  return {
    read,
    record: (sighting) => {
      const clicked = read();
      if (clicked.kind === "failed") {
        throw new Error(
          `doctor: the clicked terminals could not be read: ${clicked.reason}`,
        );
      }
      if (clicked.value.includes(sighting)) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(
        file,
        `${JSON.stringify([...clicked.value, sighting], null, 2)}\n`,
      );
    },
  };
}
