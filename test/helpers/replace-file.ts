import fs from "node:fs";

// Rewrites a file the way an editor or a careful program does: the new
// contents land beside it and are renamed over the path, so a read sees the
// old contents or the new, never the empty file a truncating write leaves
// between its two steps. A test that counts a source's changes counts one per
// replacement, not an extra one for a read that landed in the gap.
export function replaceFile(file: string, text: string): void {
  const next = `${file}.next`;
  fs.writeFileSync(next, text);
  fs.renameSync(next, file);
}
