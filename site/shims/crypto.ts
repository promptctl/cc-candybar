import { Buffer } from "buffer";

// node:crypto's createHash, for the sync sha256/sha1/md5 hex digests the daemon takes as cache keys.
// FNV-1a stand-in: these are keys, never security; the page holds one fixture.
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8);
}
export function createHash(_alg: string) {
  let acc = "";
  const h = {
    update(d: string | Uint8Array) { acc += typeof d === "string" ? d : new TextDecoder().decode(d); return h; },
    digest(_enc?: string) { return fnv(acc); },
  };
  return h;
}
// node:crypto's createHmac and timingSafeEqual, for the link signer's sha256 macs. The same
// FNV-1a stand-in over key and text: the page runs no program a link could name.
export function createHmac(_alg: string, key: Uint8Array) {
  let acc = Buffer.from(key).toString("hex");
  const h = {
    update(d: string | Uint8Array) { acc += typeof d === "string" ? d : new TextDecoder().decode(d); return h; },
    digest() { return Buffer.from(fnv(acc), "hex"); },
  };
  return h;
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
  return a.every((byte, i) => byte === b[i]);
}
export const randomUUID = (): string => globalThis.crypto.randomUUID();
export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export default { createHash, createHmac, timingSafeEqual, randomUUID, randomBytes };
