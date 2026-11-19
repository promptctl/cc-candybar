// [LAW:effects-at-boundaries] The host uses this key for clickable frame
// publication and admission. The key is stable across restarts, so a link
// still in scrollback verifies after the daemon that drew it is gone.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LINK_KEY_BYTES } from "../click/link-signer.js";
import type { Asked } from "../utils/outcome.js";
import { publishByLink } from "../utils/atomic-write.js";
import { quietLogger, type DaemonLogger } from "../utils/logger.js";

export function linkKeyFile(dir: string): string {
  return path.join(dir, "link.key");
}

// [LAW:one-source-of-truth] First use reads the file and retains its key
// for both host paths. An unsuccessful read is retried at the next use, so
// removing a broken file recovers without restarting the daemon.
export function linkKeyFromFile(
  file: string,
  log: DaemonLogger = quietLogger,
): () => Asked<Buffer> {
  let key: Buffer | undefined;
  return () => {
    try {
      key ??= readOrCreate(file, log);
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
function readOrCreate(file: string, log: DaemonLogger): Buffer {
  let key: Buffer;
  try {
    key = fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    create(file, log);
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
function create(file: string, log: DaemonLogger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { leftover } = publishByLink(file, randomBytes(LINK_KEY_BYTES), 0o600);
  if (leftover !== null) log("warn", `link key: ${leftover}`);
}
