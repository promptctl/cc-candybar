import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNTIME_MANIFEST = "runtime.json";
export const rendererDigest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const SHA256 = /^[0-9a-f]{64}$/;

export function rendererAssetName(digest: string): string {
  if (!SHA256.test(digest))
    throw new Error("Invalid portable renderer SHA-256 digest");
  return `renderer-${digest}.mjs`;
}

export interface RuntimeManifest {
  readonly cli: string;
  readonly renderer: string;
}

export function manifestOf(text: string): RuntimeManifest | undefined {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !value ||
    typeof value.cli !== "string" ||
    typeof value.renderer !== "string" ||
    !SHA256.test(value.cli) ||
    !SHA256.test(value.renderer)
  )
    return undefined;
  return { cli: value.cli, renderer: value.renderer };
}

// Reap only this build's immutable module names. Keep the last generation
// until a later upgrade so a process resolving the old entry can still start.
export function obsoleteRendererFiles(
  names: string[],
  previous: string | undefined,
  current: string,
): string[] {
  if (!previous || previous === current) return [];
  const keep = new Set([
    rendererAssetName(previous),
    rendererAssetName(current),
  ]);
  return names.filter(
    (name) => /^renderer-[0-9a-f]{64}\.mjs$/.test(name) && !keep.has(name),
  );
}

export interface RendererAsset {
  readonly bytes: Buffer;
  readonly cli: Buffer;
  readonly digest: string;
  readonly manifest: string;
}

// [LAW:one-source-of-truth] Read both files and bind their captured bytes to
// one build manifest. A rebuild may be publishing the checkout we install from.
export function rendererAssetOf(
  dist: string,
  entry = path.join(dist, "index.mjs"),
): RendererAsset {
  const manifest = fs.readFileSync(path.join(dist, RUNTIME_MANIFEST), "utf8");
  const hashes = manifestOf(manifest);
  if (!hashes) throw new Error(`Invalid runtime manifest at ${dist}`);
  const cli = fs.readFileSync(entry);
  if (rendererDigest(cli) !== hashes.cli)
    throw new Error(
      `CLI content does not match the runtime manifest at ${entry}`,
    );
  const file = path.join(dist, rendererAssetName(hashes.renderer));
  const bytes = fs.readFileSync(file);
  if (rendererDigest(bytes) !== hashes.renderer)
    throw new Error(
      `Portable renderer content does not match its digest at ${file}`,
    );
  return { bytes, digest: hashes.renderer, cli, manifest };
}
