import path from "node:path";

// [LAW:types-are-the-program] A path a renderer stores, saying whose it is. A
// file under the home's root is the home's and is stored relative to it, so a
// home's tree names its own root nowhere and a copy of it under another root
// is a working renderer whose history writes the copy's config, never the
// original's. Anything else is the world's (a session's directory, a config
// file named outside the home) and is stored absolute, because no root can
// express it. The root is `storedRoot` (paths.ts).
export type StoredPath =
  | { readonly kind: "home"; readonly path: string }
  | { readonly kind: "world"; readonly path: string };

// [LAW:effects-at-boundaries] The root a stored home path is relative to
// (`storedRoot`, paths.ts), with the one question the decision asks the disk:
// a directory's on-disk spelling (utils/on-disk-path.ts), handed in so the
// decision itself is pure and a test hands a map of links.
export interface StoredRoot {
  readonly dir: string;
  readonly onDisk: (dir: string) => string;
}

// [LAW:one-source-of-truth] One operation's reading of the disk: each
// directory is asked once, so every decision the operation makes (a request's
// spelling and the origin it records, a history's many steps) stands on one
// answer, and walks over shared ancestors read each once. It is made per
// operation and dropped with it, because a link re-pointed after is the next
// operation's to read.
export function oneReading(root: StoredRoot): StoredRoot {
  const read = new Map<string, string>();
  return {
    dir: root.dir,
    onDisk: (dir) => {
      const known = read.get(dir);
      if (known !== undefined) return known;
      const spelled = root.onDisk(dir);
      read.set(dir, spelled);
      return spelled;
    },
  };
}

// [LAW:one-source-of-truth] Whose a file is: the home's when a directory on
// its path, as named, is the root directory, and then its path from there.
// Directories are compared in their on-disk spelling, read now, so a file
// named through a link above the root (macOS's /tmp, a dotfiles ~/.config) or
// in another letter case is the home's, as one named through a link inside
// the home (its config/ pointing elsewhere) is, where resolving the file
// itself would send it to the world. `file` is absolute. A file named under
// the root as the home names it has the root on its path by definition, so it
// answers with no disk read: a home file in the home's spelling, which is
// what the store holds and reads back, costs nothing.
function homeRelative(root: StoredRoot, file: string): string | null {
  return underRoot(root.dir, file) ?? namedThrough(root, file);
}

function namedThrough(root: StoredRoot, file: string): string | null {
  const home = root.onDisk(root.dir);
  const at = ancestors(file).find((dir) => root.onDisk(dir) === home);
  return at === undefined ? null : path.relative(at, file);
}

// The directories `file` names on its way, nearest first.
function ancestors(file: string): string[] {
  const dir = path.dirname(file);
  return dir === file ? [] : [dir, ...ancestors(dir)];
}

// The lexical test: the plain path of `file` under the root as the root is
// spelled, or null. It is also the shape a stored home path is checked by.
function underRoot(root: string, file: string): string | null {
  const rel = path.relative(root, file);
  return rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
    ? null
    : rel;
}

// Total over an absolute path: the spelling a store writes.
export function storedPathOf(root: StoredRoot, file: string): StoredPath {
  const rel = homeRelative(root, file);
  return rel === null
    ? { kind: "world", path: file }
    : { kind: "home", path: rel };
}

// [LAW:no-silent-failure] A stored path its root refuses, as its own type, so a
// store that answers a refusal (dropping a history, refusing a click) answers
// that and nothing else: any other throw is a defect and stays one.
export class StoredPathRefused extends Error {}

// [LAW:parse-dont-validate] The one way a stored path is read back: the
// absolute path it names under this root, or a StoredPathRefused naming what
// is wrong. A world path spelled under the root is refused rather than taken,
// because no build writes one: a home's file has one spelling, and the
// absolute one names a root the tree may no longer live at.
//
// Every other absolute path, a world path or an older build's bare string
// (which had only the absolute spelling), is read as this build spells it.
// Whose a file is is the disk's to say at the read: a world path that reaches
// the home through a link (macOS's /tmp, or a link made since it was stored)
// names the home's file, so it reads back as the home's. Refusing it would
// drop a whole history over a link while guarding nothing: a tree copied under
// another root names the original's root, which no spelling rule can tell
// from a file of the world's.
export function resolveStoredPath(root: StoredRoot, raw: unknown): string {
  if (typeof raw === "string") {
    if (!path.isAbsolute(raw)) {
      throw new StoredPathRefused(
        `an older build's stored path ${JSON.stringify(raw)} is not absolute`,
      );
    }
    return homeSpelling(root, raw);
  }
  if (raw === null || typeof raw !== "object") {
    throw new StoredPathRefused(
      `stored path is not an object: ${JSON.stringify(raw)}`,
    );
  }
  const { kind, path: p } = raw as Record<string, unknown>;
  if (typeof p !== "string") {
    throw new StoredPathRefused(
      `stored path has no path: ${JSON.stringify(raw)}`,
    );
  }
  if (kind === "home") {
    const file = path.join(root.dir, p);
    if (path.isAbsolute(p) || underRoot(root.dir, file) !== p) {
      throw new StoredPathRefused(
        `stored home path ${JSON.stringify(p)} is not a plain path inside the home's root ${root.dir}`,
      );
    }
    return file;
  }
  if (kind === "world") {
    if (!path.isAbsolute(p)) {
      throw new StoredPathRefused(
        `stored world path ${JSON.stringify(p)} is not absolute`,
      );
    }
    if (underRoot(root.dir, p) !== null) {
      throw new StoredPathRefused(
        `stored world path ${p} lies under the home's root ${root.dir}; a home's file is stored relative to it`,
      );
    }
    return homeSpelling(root, p);
  }
  throw new StoredPathRefused(
    `stored path has no kind of home or world: ${JSON.stringify(raw)}`,
  );
}

// [LAW:one-source-of-truth] What the store reads back for a file: the root as
// the home names it, then the file's path inside, whatever spelling named it;
// a file of the world's as given. It is `storedPathOf` then
// `resolveStoredPath`, from the one answer of whose the file is, without
// asking the disk a second time, so a requested path that crosses it before
// it is recorded, cached or written reads back as itself, and a home file has
// the one spelling its default target already has.
export function homeSpelling(root: StoredRoot, file: string): string {
  const rel = homeRelative(root, file);
  return rel === null ? file : path.join(root.dir, rel);
}
