import type { RequestedOrigin } from "../../config-hint";

// The record is flat and additive, and `configFile` keeps its meaning, because
// session state sits at one unversioned path that builds of either age read:
// an older build finds the field it requires and ignores `source`.
export function encodeRenderOrigin({
  projectDir,
  cwd,
  target,
}: RequestedOrigin): string {
  return JSON.stringify({
    projectDir,
    cwd,
    configFile: target.path ?? null,
    source: target.source,
  });
}
