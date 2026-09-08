// [LAW:one-source-of-truth] The build bakes this digest into the bundle and the
// daemon recomputes it; both call THIS function, so neither side can hash differently.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Finder and editor droppings would fake a change from no source change at all.
export const isSourceEntry = (name: string): boolean =>
  !name.startsWith(".") && !name.endsWith("~");

// Link text, never the target: no cycle and no walk into an external tree.
function entryBytes(p: string, st: fs.Stats): Buffer {
  return st.isSymbolicLink()
    ? Buffer.from(fs.readlinkSync(p))
    : fs.readFileSync(p);
}

// Total order: the digest must not depend on readdir order, which differs
// across filesystems.
function sourceEntries(root: string, dir: string): Array<[string, Buffer]> {
  return fs
    .readdirSync(dir)
    .filter(isSourceEntry)
    .sort()
    .flatMap((name): Array<[string, Buffer]> => {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (st === undefined) return [];
      if (st.isDirectory()) return sourceEntries(root, p);
      const rel = path.relative(root, p).split(path.sep).join("/");
      return [[rel, entryBytes(p, st)]];
    });
}

export function sourceDigest(srcDir: string): string {
  const h = crypto.createHash("sha256");
  for (const [rel, bytes] of sourceEntries(srcDir, srcDir)) {
    h.update(rel).update("\0").update(bytes).update("\0");
  }
  return h.digest("hex");
}

export const SHORT_DIGEST_LENGTH = 7;
export const shortDigest = (digest: string): string =>
  digest.slice(0, SHORT_DIGEST_LENGTH);
