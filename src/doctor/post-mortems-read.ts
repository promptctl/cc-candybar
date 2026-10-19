// The newest of the daemon's post-mortems the user has filed as read
// (brandon-doctor-v62x.5mq): the doctor's daemon row fails on every breach
// newer than it, and its `[fix]` files the newest as read.
//
// [LAW:one-source-of-truth] A post-mortem's identity is `<ISO stamp>-<pid>`
// (src/daemon/limits.ts), so identities order by time as strings: the one
// identity filed here answers for every breach up to it.
//
// [LAW:effects-at-boundaries] `parsePostMortemsRead` is pure; the file is read
// and written only by `filePostMortemsRead`, which the doctor edge carries
// (src/doctor/edge.ts).

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../daemon/paths.js";
import { writeAtomic } from "../utils/atomic-write.js";
import type { Asked } from "./checks.js";

// [LAW:parse-dont-validate] The file's text as the identity filed read. Only
// the doctor writes the file, so text that does not read is a failure naming
// the file, never "none read".
export function parsePostMortemsRead(
  text: string,
  file: string,
): Asked<string | null> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return {
      kind: "failed",
      reason: `${file} is not JSON: ${(e as Error).message}`,
    };
  }
  const through = (doc as { through?: unknown } | null)?.through;
  return typeof through === "string"
    ? { kind: "ok", value: through }
    : { kind: "failed", reason: `${file} names no post-mortem read` };
}

export interface PostMortemsReadStore {
  readonly read: () => Asked<string | null>;
  readonly record: (through: string) => void;
}

// The record as a file: absent is none read.
export function filePostMortemsRead(
  file: string = path.join(stateDir(), "doctor-post-mortems-read.json"),
): PostMortemsReadStore {
  return {
    read: () => {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "ok", value: null };
        }
        return { kind: "failed", reason: `${file}: ${(e as Error).message}` };
      }
      return parsePostMortemsRead(text, file);
    },
    record: (through) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(file, `${JSON.stringify({ through }, null, 2)}\n`);
    },
  };
}
