// [LAW:verifiable-goals] The page's simulated machine (site/world.ts) replaces a
// session's transcript as /compact does: the replacement is a different file to
// the daemon (a new inode), so the daemon folds it again from nothing rather
// than reading on from where it stopped in the old one.

import { vol } from "../site/shims/fs";
import { newTranscript } from "../site/world";

test("a replaced transcript is a new file to the daemon, never the old one reused", () => {
  const file = newTranscript("s");
  vol.appendFileSync(file, '{"type":"user"}\n');
  const seen = new Set([vol.statSync(file).ino]);
  for (let i = 0; i < 3; i++) {
    expect(newTranscript("s")).toBe(file);
    expect(vol.readFileSync(file, "utf8")).toBe("");
    const ino = vol.statSync(file).ino;
    expect(seen.has(ino)).toBe(false);
    seen.add(ino);
  }
});
