// [LAW:single-enforcer] The one signer of the bar's links. Any web page can
// open a `cc-candybar://` link, so the host publishes each bar link with a
// mac over its whole text and opens each click before any renderer sees it.
// A `run` link and the repository question's answer
// carry a mac of their own besides, over what they prove beyond the link: that
// the action's declaration is unchanged since the draw, and that the question,
// not a config, drew the answer.
//
// [LAW:effects-at-boundaries] Pure over its key: where the key comes from (the
// state directory's key file, a test's fixed bytes) is the caller's.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Asked } from "../utils/outcome.js";
import { isBarLink } from "./wire.js";

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
  // A bar link as a terminal sends it back: in its transit form, its mac
  // after a `#`.
  readonly signLink: (link: string) => string;
  // [LAW:parse-dont-validate] The link a signed one carries, or why it is
  // refused: no mac, a mac that does not match, or a key this signer cannot
  // have. Never throws, so a refusal is the click's to say.
  readonly openLink: (signed: string) => Asked<string>;
}

// A link's mac: HMAC-SHA256 truncated to 128 bits, which NIST SP 800-107
// allows, in base64url. Every word cell of a row repeats its link, so the
// mac's length is paid many times in a frame's bytes.
const LINK_MAC_BYTES = 16;
const LINK_MAC_SPELLING = /^[A-Za-z0-9_-]{22}$/;
const LINK_MAC_MARK = "#";

// [LAW:one-source-of-truth] A link spelled as it travels: every character
// outside RFC 3986's unreserved and sub-delims, `:@/?`, escaped, and `%` kept
// only where it starts an escape. The OS hands the URL handler a link it has
// already normalized, so the link is signed as that normalization leaves it,
// and its own `#` is escaped, so the mark before the mac is the only one. A
// lone surrogate is U+FFFD first, so no text a config writes makes the
// escape throw.
export function transitForm(link: string): string {
  return link
    .toWellFormed()
    .replace(
      /%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%]/gu,
      encodeURIComponent,
    );
}

// A signed link with its mac taken off, for a reading of what was clicked: a
// log line, a debug dump. A mac in a log is a link anyone reading it can send.
// A link of another scheme carries no mac, so its own `#fragment` stays.
export function unprovenLink(signed: string): string {
  const mark = isBarLink(signed) ? signed.lastIndexOf(LINK_MAC_MARK) : -1;
  return mark === -1 ? signed : signed.slice(0, mark);
}

// [LAW:types-are-the-program] What a link's mac is over, kept apart from the
// fields' JSON array: a link's text starts with its scheme, never `[`. Spelled
// from base64 by hand, because the page's Buffer has no base64url.
function linkMac(key: Buffer, link: string): string {
  return Buffer.from(
    createHmac("sha256", key).update(link).digest().subarray(0, LINK_MAC_BYTES),
  )
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function signLinkWith(key: Buffer, link: string): string {
  const sent = transitForm(link);
  return `${sent}${LINK_MAC_MARK}${linkMac(key, sent)}`;
}

function openLinkWith(key: Buffer, signed: string): Asked<string> {
  const mark = signed.lastIndexOf(LINK_MAC_MARK);
  if (mark === -1)
    return {
      kind: "failed",
      reason:
        "the link carries no signature: the bar did not draw it, or drew it before its links were signed",
    };
  const link = signed.slice(0, mark);
  const mac = signed.slice(mark + LINK_MAC_MARK.length);
  // Compared as spelled, in constant time, once its spelling says it has the
  // length of one.
  const proven =
    LINK_MAC_SPELLING.test(mac) &&
    timingSafeEqual(Buffer.from(mac), Buffer.from(linkMac(key, link)));
  return proven
    ? { kind: "ok", value: link }
    : {
        kind: "failed",
        reason:
          "the link's signature does not match what it carries: it was changed after the bar drew it, or another key signed it",
      };
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
  // [LAW:carrying-cost] A link's signature is a pure function of its text,
  // and a bar draws the same links frame after frame at its lanes' fps, so
  // each is signed once and kept. The memo empties when it reaches its bound,
  // so links a config mints from changing values never grow it without end.
  const signed = new Map<string, string>();
  return {
    sign: (fields) => digest(key, fields).toString("hex"),
    verify: (fields, mac) => {
      // Spelled exactly as `sign` spells one: Buffer's hex decode stops at
      // the first character that is not hex, so a mac with text after it
      // would otherwise decode to the mac.
      if (!MAC_SPELLING.test(mac)) return false;
      return timingSafeEqual(Buffer.from(mac, "hex"), digest(key, fields));
    },
    signLink: (link) => {
      let done = signed.get(link);
      if (done === undefined) {
        if (signed.size >= SIGNED_LINKS_HELD) signed.clear();
        done = signLinkWith(key, link);
        signed.set(link, done);
      }
      return done;
    },
    openLink: (link) => openLinkWith(key, link),
  };
}

// More than the settings menu draws at once, and a few hundred kilobytes.
const SIGNED_LINKS_HELD = 1024;

// The signer over a key that may not be had yet, asked for at each use.
// [LAW:no-silent-failure] A key it cannot have refuses the click that needed
// it, with the reason, and never throws past the click; a draw that signs
// with it throws the reason.
export function linkSignerOver(key: () => Asked<Buffer>): LinkSigner {
  let signer: LinkSigner | undefined;
  const loaded = (): Asked<LinkSigner> => {
    const asked = key();
    return asked.kind === "ok"
      ? { kind: "ok", value: (signer ??= linkSigner(asked.value)) }
      : asked;
  };
  const held = (): LinkSigner => {
    const asked = loaded();
    if (asked.kind === "failed") throw new Error(asked.reason);
    return asked.value;
  };
  return {
    sign: (fields) => held().sign(fields),
    verify: (fields, mac) => held().verify(fields, mac),
    signLink: (link) => held().signLink(link),
    openLink: (signed) => {
      const asked = loaded();
      return asked.kind === "ok" ? asked.value.openLink(signed) : asked;
    },
  };
}

// [LAW:single-enforcer] The signer of a draw that is only a preview (`check`,
// the bench, the doctor's config draw): a key of its own, made once
// per process and held nowhere, so a preview opens no key file and its links,
// clicked, are refused loudly and prove nothing a real bar draws.
let preview: LinkSigner | undefined;
export function previewSigner(): LinkSigner {
  return (preview ??= linkSigner(randomBytes(LINK_KEY_BYTES)));
}
