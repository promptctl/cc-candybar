import type { RequestedOrigin } from "../../config-hint";
import { storedPathOf } from "./stored-path";

// The record is flat and additive, because session state sits at one
// unversioned path that builds of either age read: an older build finds the
// fields it requires and ignores `source`. `configFile` is the requested file
// as a StoredPath against the home's root (stored-path.ts), or null for a
// search. An older build refuses the object loudly rather than reading it as
// anything else, and that refusal lasts one tick: every render rewrites this
// record and no render reads it, so the session's next render on that build
// writes one it reads.
export function encodeRenderOrigin(
  { projectDir, cwd, target }: RequestedOrigin,
  root: string,
): string {
  return JSON.stringify({
    projectDir,
    cwd,
    configFile:
      target.path === undefined ? null : storedPathOf(root, target.path),
    source: target.source,
  });
}
