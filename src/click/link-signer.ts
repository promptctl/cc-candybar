// [LAW:single-enforcer] The one signer of the links a draw makes: the draw
// signs every `cc-candybar://` link it puts in a frame, and the host verifies
// each click before any renderer sees it. Any web page can open a
// `cc-candybar://` link, so a link the bar honours must prove the bar drew it.
// A `run` link also signs its declaration, so a link whose action has been
// edited since the draw runs nothing.
//
// [LAW:effects-at-boundaries] Pure over its key: where the key comes from (the
// state directory's key file, a test's fixed bytes) is the caller's.

import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC-SHA256 takes a key of any length; the key file holds this many random
// bytes.
export const LINK_KEY_BYTES = 32;

// What a `run` link signs beside the link itself: the session it runs for, the
// action it names, that action's declaration as the draw saw it, and the JSON
// of what the draw evaluated. The verb reads the session, name and evaluation
// back from the URL, and the declaration from the session's config.
export interface SignedFields {
  readonly sessionId: string;
  readonly action: string;
  readonly declaration: string;
  readonly evaluated: string;
}

// A SHA-256 mac in lowercase hex.
const MAC_SPELLING = /^[0-9a-f]{64}$/;

// A link's mac follows its last `#`: the wire escapes every `#` an effect or
// its words carry, so the mac's mark is unambiguous whatever verb the link
// names. The mac is HMAC-SHA256 truncated to its first 128 bits, in base64url,
// because every link a frame draws carries one and a terminal drops a link
// past a length.
const LINK_MAC_MARK = "#";
const LINK_MAC_BYTES = 16;
const LINK_MAC_SPELLING = /^[A-Za-z0-9_-]{22}$/;

// [LAW:parse-dont-validate] A clicked link as its mac proves it: the link the
// bar drew, its mac removed, or why it is not one.
export type VerifiedLink =
  | { readonly ok: true; readonly link: string }
  | { readonly ok: false; readonly problem: string };

export interface LinkSigner {
  // The mac a `run` link carries for `fields`.
  readonly sign: (fields: SignedFields) => string;
  // Whether `mac` is the one `sign` gives `fields`, compared in constant time.
  readonly verify: (fields: SignedFields, mac: string) => boolean;
  // `link` with its mac.
  readonly signLink: (link: string) => string;
  // The link `signLink` was given, when `signed` is what it returned.
  readonly verifyLink: (signed: string) => VerifiedLink;
}

// [LAW:types-are-the-program] The fields are joined as one JSON array, so no
// choice of field text makes two different sets sign alike. A link is signed
// as a JSON string, so neither verifies as the other under the one key.
function digest(key: Buffer, signed: unknown): Buffer {
  return createHmac("sha256", key).update(JSON.stringify(signed)).digest();
}

const fieldsOf = (fields: SignedFields): readonly string[] => [
  fields.sessionId,
  fields.action,
  fields.declaration,
  fields.evaluated,
];

// Compared as spelled, never decoded: base64url's last character carries bits
// a decode drops, so a changed one could decode to the same mac. Spelled from
// base64 by hand, since the page's Buffer knows no base64url.
const linkMac = (key: Buffer, link: string): Buffer =>
  Buffer.from(
    digest(key, link)
      .subarray(0, LINK_MAC_BYTES)
      .toString("base64")
      .replace(/=+$/, "")
      .replaceAll("+", "-")
      .replaceAll("/", "_"),
  );

// A drawn link with its mac removed, unproven: what a reader of a frame (the
// harness, the page, the bench) reads a link's effects off. Only the host's
// `verifyLink` proves one.
export function unprovenLink(signed: string): string {
  const mark = signed.lastIndexOf(LINK_MAC_MARK);
  return mark !== -1 && LINK_MAC_SPELLING.test(signed.slice(mark + 1))
    ? signed.slice(0, mark)
    : signed;
}

export function linkSigner(key: Buffer): LinkSigner {
  if (key.length !== LINK_KEY_BYTES) {
    throw new Error(`a link key is ${LINK_KEY_BYTES} bytes, got ${key.length}`);
  }
  return {
    sign: (fields) => digest(key, fieldsOf(fields)).toString("hex"),
    verify: (fields, mac) => {
      // Spelled exactly as `sign` spells one: Buffer's hex decode stops at
      // the first character that is not hex, so a mac with text after it
      // would otherwise decode to the mac.
      if (!MAC_SPELLING.test(mac)) return false;
      return timingSafeEqual(
        Buffer.from(mac, "hex"),
        digest(key, fieldsOf(fields)),
      );
    },
    signLink: (link) => `${link}${LINK_MAC_MARK}${linkMac(key, link)}`,
    verifyLink: (signed) => {
      const mark = signed.lastIndexOf(LINK_MAC_MARK);
      const mac = signed.slice(mark + 1);
      // A link with no mark, or a mark followed by anything but a mac, is
      // one no bar drew: a link from before every link was signed, or one a
      // page made.
      if (mark === -1 || !LINK_MAC_SPELLING.test(mac)) {
        return {
          ok: false,
          problem:
            "the link carries no signature: it was not drawn by this bar, or was drawn before every link was signed",
        };
      }
      const link = signed.slice(0, mark);
      return timingSafeEqual(Buffer.from(mac), linkMac(key, link))
        ? { ok: true, link }
        : {
            ok: false,
            problem:
              "the link's signature does not match what it carries: it was not drawn by this bar, or has been changed since",
          };
    },
  };
}
