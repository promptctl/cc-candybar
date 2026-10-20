// The newest of the daemon's post-mortems the user has filed as read
// (brandon-doctor-v62x.5mq): the doctor's daemon row fails on every breach
// newer than it, and its `[fix]` files the newest as read.
//
// [LAW:one-source-of-truth] A post-mortem's identity is `<ISO stamp>-<pid>`
// (src/daemon/limits.ts), so identities order by time as strings: the one
// identity filed here answers for every breach up to it.

import path from "node:path";
import { stateDir } from "../daemon/paths.js";
import type { Asked, PostMortemsRead } from "./checks.js";
import { stateFile, type StateFile } from "./state-file.js";

// [LAW:parse-dont-validate] The document as the identity filed read: every
// value the store can file reads back, `null` included.
export function parsePostMortemsRead(doc: unknown): Asked<PostMortemsRead> {
  const through = (doc as { through?: unknown } | null)?.through;
  return typeof through === "string" || through === null
    ? { kind: "ok", value: { through } }
    : { kind: "failed", reason: "names no post-mortem read" };
}

export const filePostMortemsRead = (
  file: string = path.join(stateDir(), "doctor-post-mortems-read.json"),
): StateFile<PostMortemsRead> =>
  stateFile(file, { through: null }, parsePostMortemsRead);
