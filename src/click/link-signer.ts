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

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Asked } from "../utils/outcome.js";
import { isBarLink } from "./wire.js";
import {
  rendererNameOf,
  type RendererName,
} from "../daemon/foundations/renderer-name.js";
import {
  parseSessionId,
  type SessionId,
} from "../daemon/foundations/session-id.js";

// HMAC-SHA256 takes a key of any length; the key file holds this many random
// bytes.
export const LINK_KEY_BYTES = 32;

// What a link signs: the session it runs for, the action it names, that
// action's declaration as the draw saw it, and the JSON of what the draw
// evaluated. The host reads the session, name and evaluation from the link
// and checks the declaration supplied by the renderer's turn.
export interface SignedFields {
  readonly sessionId: string;
  readonly action: string;
  readonly declaration: string;
  readonly evaluated: string;
}

// A SHA-256 mac in lowercase hex.
const MAC_SPELLING = /^[0-9a-f]{64}$/;

// [LAW:types-are-the-program] Only the host knows which renderer published
// a frame. Its source travels in the proof instead of a frame registry.
export interface FrameSource {
  readonly renderer: RendererName;
  readonly session: SessionId;
}

export interface OpenedLink {
  readonly href: string;
  readonly source?: FrameSource;
}

export interface LinkSigner {
  // The mac a link carries for `fields`.
  readonly sign: (fields: SignedFields) => string;
  // Whether `mac` is the one `sign` gives `fields`, compared in constant time.
  readonly verify: (fields: SignedFields, mac: string) => boolean;
  // A bar link as a terminal sends it back: in its transit form, its mac
  // after a `#`.
  readonly signLink: (link: string, source?: FrameSource) => string;
  // [LAW:parse-dont-validate] The link a signed one carries, or why it is
  // refused: no mac, a mac that does not match, or a key this signer cannot
  // have. Never throws, so a refusal is the click's to say.
  readonly openLink: (signed: string) => Asked<OpenedLink>;
}

// A link's mac: HMAC-SHA256 truncated to 128 bits, which NIST SP 800-107
// allows, in base64url. Every word cell of a row repeats its link, so the
// mac's length is paid many times in a frame's bytes.
const LINK_MAC_BYTES = 16;
const LINK_MAC_SPELLING = /^[A-Za-z0-9_-]{22}$/;
const LINK_MAC_MARK = "#";
const SOURCE_VERSION = "v1";

// [LAW:one-source-of-truth] Which daemon signed a link, spelled in the link
// itself: the first field of its proof, `#<id>/…`. A bar drawn over ssh is
// signed by the remote's daemon and clicked on the machine the terminal is on,
// whose URL handler reads the id to reach the one daemon that can open the link
// (the handler's copy of the spelling is pinned by scripts/check-protocol.mjs).
// The id is 48 bits of a one-way function of the key, so it names the key and
// gives nothing of it away; it routes and never authenticates, because the mac
// covers it.
export const LINK_KEY_ID_CHARS = 8;
const LINK_KEY_ID_DOMAIN = "cc-candybar link key id";

// Spelled from base64 by hand, because the page's Buffer has no base64url.
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// A link's text starts with its scheme, so no link is ever the domain text
// above: the id and a link's mac are never one computation.
export function linkKeyId(key: Buffer): string {
  const digest = createHmac("sha256", key).update(LINK_KEY_ID_DOMAIN).digest();
  return base64url(digest.subarray(0, (LINK_KEY_ID_CHARS * 3) / 4));
}

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

// A signed link with its proof fragment removed, for a log or debug dump.
// A proof in a log is a link anyone reading it can send.
// A link of another scheme carries no mac, so its own `#fragment` stays.
export function unprovenLink(signed: string): string {
  const mark = isBarLink(signed) ? signed.lastIndexOf(LINK_MAC_MARK) : -1;
  return mark === -1 ? signed : signed.slice(0, mark);
}

// [LAW:types-are-the-program] What a link's mac is over, kept apart from the
// fields' JSON array: a link's text starts with its scheme, never `[`.
function linkMac(key: Buffer, link: string): string {
  return base64url(
    createHmac("sha256", key).update(link).digest().subarray(0, LINK_MAC_BYTES),
  );
}

// [LAW:single-enforcer] The proof is the signer's id, then the issuing frame's
// identity when the link has one, then a mac over the destination and all of
// that. The raw fragment delimiter in the proof input is outside any authored
// link's text: transitForm escapes any fragment an authored href names.
function signLinkWith(key: Buffer, link: string, source?: FrameSource): string {
  const signer = `${transitForm(link)}${LINK_MAC_MARK}${linkKeyId(key)}`;
  const issued =
    source === undefined
      ? signer
      : `${signer}/${SOURCE_VERSION}/${source.renderer}/${encodeURIComponent(JSON.stringify(source.session))}`;
  return `${issued}/${linkMac(key, issued)}`;
}

// [LAW:parse-dont-validate] Only an authenticated address can yield a
// typed source. Names use the same parsers as renderer and session ingress.
function openLinkWith(key: Buffer, signed: string): Asked<OpenedLink> {
  const mark = signed.lastIndexOf(LINK_MAC_MARK);
  if (mark === -1)
    return {
      kind: "failed",
      reason:
        "the link carries no signature: the bar did not draw it, or drew it before its links were signed",
    };
  const proof = signed.slice(mark + 1).split("/");
  const mac = proof[proof.length - 1] ?? "";
  const [signer, ...source] = proof.slice(0, -1);
  if (signer === undefined)
    return {
      kind: "failed",
      reason:
        "the link does not say which daemon signed it: the bar drew it before its links named their signer, and its next redraw does",
    };
  const own = linkKeyId(key);
  if (signer !== own)
    return {
      kind: "failed",
      reason: `the link was signed by another daemon (key ${signer}, this one is ${own}): a bar drawn on another machine over ssh reaches its daemon through an ssh forward, which \`cc-candybar ssh-config ALIAS\` run on that machine prints`,
    };
  // Compared as spelled, in constant time, once its spelling says it has the
  // length of one.
  const proven =
    LINK_MAC_SPELLING.test(mac) &&
    timingSafeEqual(
      Buffer.from(mac),
      Buffer.from(
        linkMac(key, signed.slice(0, signed.length - mac.length - 1)),
      ),
    );
  if (!proven)
    return {
      kind: "failed",
      reason:
        "the link's signature does not match what it carries: it was changed after the bar drew it",
    };
  const href = signed.slice(0, mark);
  if (source.length === 0) return { kind: "ok", value: { href } };
  const [version, name, encoded] = source;
  if (
    source.length !== 3 ||
    version !== SOURCE_VERSION ||
    name === undefined ||
    encoded === undefined
  )
    return { kind: "failed", reason: "the link has an unknown frame source" };
  try {
    const renderer = rendererNameOf(name);
    const session = parseSessionId(JSON.parse(decodeURIComponent(encoded)));
    return session.ok
      ? {
          kind: "ok",
          value: { href, source: { renderer, session: session.id } },
        }
      : { kind: "failed", reason: `the link's session ${session.problem}` };
  } catch (error) {
    return {
      kind: "failed",
      reason: `the link's frame source is malformed: ${String(error)}`,
    };
  }
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
    signLink: (link, source) => {
      const cacheKey =
        source === undefined
          ? `legacy:${link}`
          : `frame:${source.renderer}\0${source.session}\0${link}`;
      let done = signed.get(cacheKey);
      if (done === undefined) {
        if (signed.size >= SIGNED_LINKS_HELD) signed.clear();
        done = signLinkWith(key, link, source);
        signed.set(cacheKey, done);
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
    signLink: (link, source) => held().signLink(link, source),
    openLink: (signed) => {
      const asked = loaded();
      return asked.kind === "ok" ? asked.value.openLink(signed) : asked;
    },
  };
}
