import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RENDERER_DIGEST_FILE = "renderer.sha256";
export const rendererDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export function rendererAssetName(digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest))
    throw new Error("Invalid portable renderer SHA-256 digest");
  return `renderer-${digest}.mjs`;
}

export interface RendererAsset {
  readonly bytes: Buffer;
  readonly digest: string;
}

// Resolve the build's manifest before publishing any part of the install.
// A damaged or mismatched renderer cannot acquire a valid build's filename.
export function rendererAssetOf(dist: string): RendererAsset {
  const digest = fs
    .readFileSync(path.join(dist, RENDERER_DIGEST_FILE), "utf8")
    .trimEnd();
  const file = path.join(dist, rendererAssetName(digest));
  const bytes = fs.readFileSync(file);
  if (rendererDigest(bytes) !== digest)
    throw new Error(
      `Portable renderer content does not match its digest at ${file}`,
    );
  return { bytes, digest };
}
