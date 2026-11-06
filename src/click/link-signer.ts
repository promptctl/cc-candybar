// [LAW:single-enforcer] The one signer of the links a draw makes that run
// something: the render signs what it evaluated, and the click verifies it
// before anything runs. Any web page can open a `cc-candybar://` link, so a
// link the daemon honours as a command must prove the daemon drew it.
//
// [LAW:effects-at-boundaries] Pure over its key: where the key comes from (the
// state directory's key file, a test's fixed bytes) is the caller's.

import { createHmac, timingSafeEqual } from "node:crypto";
import { VERB_TMUX_STATUS_CLICK } from "./wire.js";

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
  // The mac a tmux server's status-line click binding carries, over the
  // server's socket: a click names a range id, a counter anyone can guess, so
  // the click proves it came from a binding this daemon wrote.
  readonly signBinding: (socket: string) => string;
  readonly verifyBinding: (socket: string, mac: string) => boolean;
}

// [LAW:types-are-the-program] What is signed is joined as one JSON array, so
// no choice of field text makes two different sets sign alike, and a
// binding's two entries never sign as a link's four.
function digest(key: Buffer, signed: readonly string[]): Buffer {
  return createHmac("sha256", key).update(JSON.stringify(signed)).digest();
}

const linkFields = (fields: SignedFields): readonly string[] => [
  fields.sessionId,
  fields.action,
  fields.declaration,
  fields.evaluated,
];

const bindingFields = (socket: string): readonly string[] => [
  VERB_TMUX_STATUS_CLICK,
  socket,
];

export function linkSigner(key: Buffer): LinkSigner {
  if (key.length !== LINK_KEY_BYTES) {
    throw new Error(`a link key is ${LINK_KEY_BYTES} bytes, got ${key.length}`);
  }
  const sign = (signed: readonly string[]): string =>
    digest(key, signed).toString("hex");
  // Spelled exactly as `sign` spells one: Buffer's hex decode stops at the
  // first character that is not hex, so a mac with text after it would
  // otherwise decode to the mac.
  const verify = (signed: readonly string[], mac: string): boolean =>
    MAC_SPELLING.test(mac) &&
    timingSafeEqual(Buffer.from(mac, "hex"), digest(key, signed));
  return {
    sign: (fields) => sign(linkFields(fields)),
    verify: (fields, mac) => verify(linkFields(fields), mac),
    signBinding: (socket) => sign(bindingFields(socket)),
    verifyBinding: (socket, mac) => verify(bindingFields(socket), mac),
  };
}
