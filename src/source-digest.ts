// The identity of a source tree: one digest over every source file's path
// and content. It answers "is this the source the bundle was built from?"
// where an mtime cannot — a `git checkout` or rebase rewrites mtimes on
// files whose bytes did not change, so a build watch keyed on mtimes cries
// wolf on every branch switch and trains the reader to dismiss it.
//
// [LAW:one-source-of-truth] The build bakes this digest into the bundle
// (tsdown.config.ts's plugin) and the daemon recomputes it on a clock
// (src/daemon/build-currency.ts); both call THIS function, so the two sides
// of the comparison can never walk or hash the tree differently.
//
// [LAW:effects-at-boundaries] Reads the filesystem, nothing else: no clock,
// no env, no cache. A tree that cannot be read throws — a digest over part
// of the source would be a lie, and the caller owns what "cannot check"
// means (the daemon's `unchecked` verdict; the build's failure).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Dotfiles and `~` backups are never source: `.DS_Store` is rewritten by
// Finder browsing a directory and editors park swap files beside the file
// being edited, so counting them would fake a change from no source change
// at all. A deny-list of "never source" holds for every bundler; an
// extension allow-list would be a second copy of the import graph.
export const isSourceEntry = (name: string): boolean =>
  !name.startsWith(".") && !name.endsWith("~");

// The bytes an entry contributes. A symlink is an entry — its link text,
// never its target: the source of a checkout is what lives under its `src/`,
// and a link into another tree is that tree's business, not a path to walk
// (so no cycle and no wandering into an external tree is representable).
function entryBytes(p: string, st: fs.Stats): Buffer {
  return st.isSymbolicLink()
    ? Buffer.from(fs.readlinkSync(p))
    : fs.readFileSync(p);
}

// Every source entry under `dir` whose name `keep` admits, as `[path
// relative to root, bytes]`, in a total order — the digest must not depend on
// readdir order, which differs across filesystems. `dir` itself is read, so a
// tree that is not there throws; an entry deleted between readdir and lstat
// (a `git pull` racing the walk) simply has no contribution.
function sourceEntries(
  root: string,
  dir: string,
  keep: (name: string) => boolean = isSourceEntry,
): Array<[string, Buffer]> {
  return fs
    .readdirSync(dir)
    .filter(keep)
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

// sha256 over `path NUL bytes NUL` per entry, so a rename (same bytes, new
// path) and a content edit both change it, and no two entry boundaries can be
// confused. Lowercase hex.
function digestOf(entries: ReadonlyArray<[string, Buffer]>): string {
  const h = crypto.createHash("sha256");
  for (const [rel, bytes] of entries) {
    h.update(rel).update("\0").update(bytes).update("\0");
  }
  return h.digest("hex");
}

// The digest of a source tree: every entry under `srcDir`.
export function sourceDigest(srcDir: string): string {
  return digestOf(sourceEntries(srcDir, srcDir));
}

// What cargo builds the native client from: the crate's manifest, its
// lockfile and its source — a dependency bump in Cargo.lock is as much a
// change to the binary as an edit under src/. `target/` is cargo's output.
export const CRATE_SOURCE = ["Cargo.toml", "Cargo.lock", "src"] as const;

// [LAW:one-source-of-truth] The native client's build stamp: `just
// install-rust` bakes it in (scripts/crate-digest.ts) and the doctor
// recomputes it over the checkout (src/doctor/edge.ts), one function.
export function crateDigest(crateDir: string): string {
  return digestOf(
    sourceEntries(crateDir, crateDir, (name) =>
      (CRATE_SOURCE as readonly string[]).includes(name),
    ),
  );
}

// How much of a digest a person is shown: seven hex characters, the length
// git abbreviates a commit to, so the identifier reads as the familiar
// short hash rather than a wall of hex.
export const SHORT_DIGEST_LENGTH = 7;
export const shortDigest = (digest: string): string =>
  digest.slice(0, SHORT_DIGEST_LENGTH);
