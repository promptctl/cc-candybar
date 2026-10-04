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
export const randomUUID = (): string => globalThis.crypto.randomUUID();
export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export default { createHash, randomUUID, randomBytes };
