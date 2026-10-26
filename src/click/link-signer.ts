// [LAW:single-enforcer] The one signer of the links a draw makes that run
// something: the render signs what it evaluated, and the click verifies it
// before anything runs. Any web page can open a `cc-candybar://` link, so a
// link the daemon honours as a command must prove the daemon drew it.
//
// [LAW:effects-at-boundaries] Pure over its key: where the key comes from (the
// state directory's key file, a test's fixed bytes) is the caller's.

import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC-SHA256 takes a key of any length; the key file holds this many random
// bytes.
export const LINK_KEY_BYTES = 32;

// What a link signs: the session it runs for, the action it names, that
// action's declaration as the draw saw it, and the JSON of what the draw
// evaluated. The verb reads the session, name and evaluation back from the
// URL, and the declaration from the session's config.
export interface SignedFields {
  readonly sessionId: string;
  readonly action: string;
  readonly declaration: string;
  readonly evaluated: string;
}

// A SHA-256 mac in lowercase hex.
const MAC_SPELLING = /^[0-9a-f]{64}$/;

export interface LinkSigner {
  // The mac a link carries for `fields`.
  readonly sign: (fields: SignedFields) => string;
  // Whether `mac` is the one `sign` gives `fields`, compared in constant time.
  readonly verify: (fields: SignedFields, mac: string) => boolean;
}

// [LAW:types-are-the-program] The fields are joined as one JSON array, so no
// choice of field text makes two different sets sign alike.
function digest(key: Buffer, fields: SignedFields): Buffer {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        fields.sessionId,
        fields.action,
        fields.declaration,
        fields.evaluated,
      ]),
    )
    .digest();
}

export function linkSigner(key: Buffer): LinkSigner {
  if (key.length !== LINK_KEY_BYTES) {
    throw new Error(`a link key is ${LINK_KEY_BYTES} bytes, got ${key.length}`);
  }
  return {
    sign: (fields) => digest(key, fields).toString("hex"),
    verify: (fields, mac) => {
      // Spelled exactly as `sign` spells one: Buffer's hex decode stops at
      // the first character that is not hex, so a mac with text after it
      // would otherwise decode to the mac.
      if (!MAC_SPELLING.test(mac)) return false;
      return timingSafeEqual(Buffer.from(mac, "hex"), digest(key, fields));
    },
  };
}
