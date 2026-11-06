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

// [LAW:one-source-of-truth] The one test of "under the root" that both
// directions share. `file` is absolute.
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
export function storedPathOf(root: string, file: string): StoredPath {
  const rel = underRoot(root, file);
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
// is wrong. An absolute path under the root is refused rather than taken,
// because a home's file has one spelling, and the absolute one names a root
// the tree may no longer live at.
export function resolveStoredPath(root: string, raw: unknown): string {
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
    const file = path.join(root, p);
    if (path.isAbsolute(p) || underRoot(root, file) !== p) {
      throw new StoredPathRefused(
        `stored home path ${JSON.stringify(p)} is not a plain path inside the home's root ${root}`,
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
    if (underRoot(root, p) !== null) {
      throw new StoredPathRefused(
        `stored world path ${p} lies under the home's root ${root}; a home's file is stored relative to it`,
      );
    }
    return p;
  }
  throw new StoredPathRefused(
    `stored path has no kind of home or world: ${JSON.stringify(raw)}`,
  );
}
