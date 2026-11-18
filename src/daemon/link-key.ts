// [LAW:effects-at-boundaries] The link key on disk: what the host opens every
// click with and hands each renderer it starts. The key is stable across
// restarts, so a link still in a terminal's scrollback verifies after the
// daemon that drew it is gone.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LINK_KEY_BYTES } from "../click/link-signer.js";
import type { Asked } from "../utils/outcome.js";
import { publishByLink } from "../utils/atomic-write.js";

export function linkKeyFile(dir: string): string {
  return path.join(dir, "link.key");
}

// [LAW:one-source-of-truth] The key in the file, read on first use and kept
// once a read succeeds: the host opens every click with what this returns and
// starts every renderer with it, so the two never hold different keys.
// Importing the daemon touches no disk for it, and a key that could not be
// read is read again at the next ask, so removing a broken file (its error's
// own remedy) recovers with no restart.
export function linkKeyFromFile(file: string): () => Asked<Buffer> {
  let key: Buffer | undefined;
  return () => {
    try {
      key ??= readOrCreate(file);
      return { kind: "ok", value: key };
    } catch (e) {
      return { kind: "failed", reason: (e as Error).message };
    }
  };
}

// The key on disk, made first when there is none: a state directory that
// cannot be written still serves the key it holds.
// [LAW:no-silent-failure] A key file of the wrong length is refused loudly,
// naming the file, never replaced: a replaced key silently voids every link
// already drawn.
function readOrCreate(file: string): Buffer {
  let key: Buffer;
  try {
    key = fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    create(file);
    key = fs.readFileSync(file);
  }
  if (key.length !== LINK_KEY_BYTES) {
    throw new Error(
      `link key ${file} holds ${key.length} bytes, not ${LINK_KEY_BYTES}: remove it and a new one is made (links drawn before then stop working)`,
    );
  }
  return key;
}

// [LAW:no-ambient-temporal-coupling] Published by link: a key lands whole or
// finds one already there, so a racer never reads a key half written, and
// every racer, published or taken, ends on the key that landed. Readable by
// this user alone: whoever holds it can forge a link that runs a program.
function create(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  publishByLink(file, randomBytes(LINK_KEY_BYTES), 0o600);
}
