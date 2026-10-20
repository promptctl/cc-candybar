// The terminals a doctor click has come back from, kept for good.
//
// [LAW:one-source-of-truth] A doctor click is a link its terminal drew and the
// user clicked, so it settles for good that the terminal draws links — a fact
// about the machine, like a mark, but one the daemon files itself on every
// click rather than one the user makes. So it is its own file beside the mark
// book (src/doctor/mark-book.ts), which holds only the user's word: the bar's
// doctor files a terminal here, and `cc-candybar doctor`, which cannot click,
// reads it.

import path from "node:path";
import { stateDir } from "../daemon/paths.js";
import type { Asked } from "./checks.js";
import { stateFile, type StateFile } from "./state-file.js";

// [LAW:parse-dont-validate] The document as the terminals clicked from — each
// its sighting (`sightingOf`, src/doctor/terminal.ts).
export const parseClickedTerminals = (
  doc: unknown,
): Asked<readonly string[]> =>
  Array.isArray(doc) && doc.every((t) => typeof t === "string")
    ? { kind: "ok", value: doc }
    : { kind: "failed", reason: "is not a list of terminals" };

// The list with `sighting` filed — the same list when it already is, so an
// update writes nothing.
export const withClicked = (
  clicked: readonly string[],
  sighting: string,
): readonly string[] =>
  clicked.includes(sighting) ? clicked : [...clicked, sighting];

export const fileClickedTerminals = (
  file: string = path.join(stateDir(), "doctor-clicked-terminals.json"),
): StateFile<readonly string[]> => stateFile(file, [], parseClickedTerminals);
