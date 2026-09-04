// [LAW:behavior-not-structure] The contract of the source-tree identity: the
// same bytes at the same paths digest the same whatever the clock or the
// readdir order says; a content edit or a rename changes it; nothing under a
// dotfile or `~` backup counts; a symlink contributes its link text and is
// never followed (brandon-build-notice-5d6).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSourceEntry,
  SHORT_DIGEST_LENGTH,
  shortDigest,
  sourceDigest,
} from "../src/source-digest";

const HOUR_S = 60 * 60;

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-digest-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

function bumpMtimes(dir: string): void {
  const t = Date.now() / 1000 + HOUR_S;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isDirectory()) bumpMtimes(p);
    fs.lutimesSync(p, t, t);
  }
}

const BASE = { "index.ts": "export const a = 1;\n", "daemon/cache/render.ts": "render\n" };
const roots: string[] = [];
const scratch = (files: Record<string, string> = BASE): string => {
  const r = tree(files);
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("sourceDigest", () => {
  test("is a lowercase sha256 hex, the same for the same tree, whatever order it was written in", () => {
    const a = scratch({ "b.ts": "B", "a.ts": "A", "z/y.ts": "Y" });
    const b = scratch({ "z/y.ts": "Y", "a.ts": "A", "b.ts": "B" });
    expect(sourceDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceDigest(a)).toBe(sourceDigest(b));
  });

  test("mtime churn — a checkout or rebase touching every file — does not change it", () => {
    const root = scratch();
    const before = sourceDigest(root);
    bumpMtimes(root);
    expect(sourceDigest(root)).toBe(before);
  });

  test("a content edit changes it", () => {
    const root = scratch();
    const before = sourceDigest(root);
    fs.appendFileSync(path.join(root, "daemon/cache/render.ts"), "// edit\n");
    expect(sourceDigest(root)).not.toBe(before);
  });

  test("a rename — same bytes, new path — changes it", () => {
    const root = scratch();
    const before = sourceDigest(root);
    fs.renameSync(path.join(root, "index.ts"), path.join(root, "main.ts"));
    expect(sourceDigest(root)).not.toBe(before);
  });

  test("dotfiles, dot-directories and ~ backups are not source", () => {
    const root = scratch();
    const before = sourceDigest(root);
    fs.writeFileSync(path.join(root, ".DS_Store"), "finder");
    fs.writeFileSync(path.join(root, "daemon/.render.ts.swp"), "vim");
    fs.writeFileSync(path.join(root, "index.ts~"), "emacs");
    fs.mkdirSync(path.join(root, ".hidden"));
    fs.writeFileSync(path.join(root, ".hidden/x.ts"), "x");
    expect(sourceDigest(root)).toBe(before);
    expect(isSourceEntry(".git")).toBe(false);
    expect(isSourceEntry("a~")).toBe(false);
    expect(isSourceEntry("a.ts")).toBe(true);
  });

  test("a symlink contributes its link text and is never followed", () => {
    const root = scratch();
    const external = scratch({ "lib.ts": "one" });
    fs.symlinkSync(external, path.join(root, "vendored"));
    const linked = sourceDigest(root);
    expect(linked).not.toBe(sourceDigest(scratch()));
    // The target's content is not part of this tree's identity.
    fs.writeFileSync(path.join(external, "lib.ts"), "two");
    expect(sourceDigest(root)).toBe(linked);
    // Self-links and dangling links are entries, not paths to walk.
    fs.symlinkSync(".", path.join(root, "loop"));
    fs.symlinkSync(path.join(root, "gone.ts"), path.join(root, "dangling.ts"));
    expect(sourceDigest(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an empty tree has a digest (of nothing), distinct from any file", () => {
    const empty = scratch({});
    expect(sourceDigest(empty)).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceDigest(empty)).not.toBe(sourceDigest(scratch()));
  });

  // [LAW:no-silent-failure] A tree that cannot be read has no digest — a
  // digest over part of the source would be a lie.
  test("a missing tree throws", () => {
    expect(() => sourceDigest(path.join(os.tmpdir(), "ccb-digest-absent"))).toThrow(
      /ENOENT/,
    );
  });
});

test("shortDigest is the first seven hex characters", () => {
  expect(SHORT_DIGEST_LENGTH).toBe(7);
  expect(shortDigest("0123456789abcdef")).toBe("0123456");
});
