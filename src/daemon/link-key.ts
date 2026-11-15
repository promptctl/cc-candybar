// [LAW:effects-at-boundaries] The link key on disk: what the host opens every
// click with and hands each renderer it starts. The key is stable across
// restarts, so a link still in a terminal's scrollback verifies after the
// daemon that drew it is gone.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  LINK_KEY_BYTES,
  linkSigner,
  type LinkSigner,
} from "../click/link-signer.js";
import type { Asked } from "../utils/outcome.js";

export function linkKeyFile(dir: string): string {
  return path.join(dir, "link.key");
}

// The signer over the key file, read on first use and kept once a read
// succeeds: importing the daemon touches no disk for it, and a key that could
// not be read is read again at the next use, so removing a broken file (its
// error's own remedy) recovers with no restart.
// [LAW:no-silent-failure] A key it cannot have refuses the click that needed
// it, with the reason; it never throws past the click.
export function linkSignerFromKeyFile(file: string): LinkSigner {
  let signer: LinkSigner | undefined;
  const loaded = (): LinkSigner => (signer ??= linkSigner(readOrCreate(file)));
  return {
    sign: (fields) => loaded().sign(fields),
    verify: (fields, mac) => loaded().verify(fields, mac),
    signLink: (link) => loaded().signLink(link),
    openLink: (signed) => {
      let opener: LinkSigner;
      try {
        opener = loaded();
      } catch (e) {
        return { kind: "failed", reason: (e as Error).message };
      }
      return opener.openLink(signed);
    },
  };
}

// The key a renderer's start hands it, read afresh for each start, in base64
// so it crosses as a line: a start whose key cannot be read refuses its boot
// with the reason, and the next start reads again.
export function readLinkKey(file: string): Asked<string> {
  try {
    return { kind: "ok", value: readOrCreate(file).toString("base64") };
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message };
  }
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

// [LAW:no-ambient-temporal-coupling] The key is written whole to a file of the
// maker's own, then linked into place: a link lands whole or fails because a
// key already did, so a racer never reads a key half written, and a crash
// mid-write leaves only its own temporary file. Every racer ends on the key
// that landed. Readable by this user alone: whoever holds it can forge a link
// that runs a program.
function create(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const written = `${file}.${process.pid}.${randomBytes(6).toString("hex")}`;
  fs.writeFileSync(written, randomBytes(LINK_KEY_BYTES), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    fs.linkSync(written, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    fs.unlinkSync(written);
  }
}
