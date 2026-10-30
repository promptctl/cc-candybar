// [LAW:one-source-of-truth] The one reading of LANDSCAPE_DIR, the folder below the live bar where the
// deploy publishes the landscape explorer. Both pages' builds take it from here, so they agree on what
// a valid value is. Unset, there is no explorer beside the page: null.
// [LAW:no-silent-failure] a path that is not plain folders below the page would link outside it.
export function landscapeDir(env = process.env) {
  const dir = env.LANDSCAPE_DIR;
  if (dir === undefined) return null;
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(dir))
    throw new Error(`LANDSCAPE_DIR must be folders below the live bar, like "landscape"; got ${JSON.stringify(dir)}`);
  return dir;
}
