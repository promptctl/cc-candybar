// [LAW:effects-at-boundaries] The link key on disk: what the daemon, `check`
// and the demo build their one LinkSigner from. The key is stable across
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
import { stateDir } from "./paths.js";

export function linkKeyFile(dir: string = stateDir()): string {
  return path.join(dir, "link.key");
}

// The signer over the key file, read on first use: importing the daemon, or
// running a CLI that never draws a `run` link, touches no disk for it. With no
// file named, the state directory's, resolved at that first use.
export function linkSignerFromKeyFile(file?: string): LinkSigner {
  let signer: LinkSigner | undefined;
  const loaded = (): LinkSigner =>
    (signer ??= readOrCreate(file ?? linkKeyFile()));
  return {
    sign: (fields) => loaded().sign(fields),
    verify: (fields, mac) => loaded().verify(fields, mac),
  };
}

// [LAW:no-ambient-temporal-coupling] The first process to need a key writes
// it whole to a file of its own, then links that file into place: a link lands
// whole or fails because a key already did, so a racer never reads a key half
// written, and a crash mid-write leaves only its own temporary file. Every
// racer ends on the key that landed. Readable by this user alone: whoever
// holds it can forge a link that runs a program.
// [LAW:no-silent-failure] A key file of the wrong length is refused loudly,
// naming the file, never replaced: a replaced key silently voids every link
// already drawn.
function readOrCreate(file: string): LinkSigner {
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
  const key = fs.readFileSync(file);
  if (key.length !== LINK_KEY_BYTES) {
    throw new Error(
      `link key ${file} holds ${key.length} bytes, not ${LINK_KEY_BYTES}: remove it and a new one is made (links drawn before then stop working)`,
    );
  }
  return linkSigner(key);
}
