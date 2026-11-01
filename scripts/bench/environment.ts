// The machine and the build a run happened on. A latency is a fact about a
// machine, so a run without its environment cannot be compared with another,
// and a run compared with another from a different machine says nothing.
//
// [LAW:nothing-unseen] The questions a surprising number raises (was the
// machine busy, was this the bundle I think, is the native client the one
// built from this source) are answered by the record, not by asking the person
// who ran it.
//
// [LAW:effects-at-boundaries] Everything read from the world is read here, once,
// at the start. The report only formats what this returned.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { crateDigest, sourceDigest } from "../../src/source-digest.js";

// The package root, which `pnpm bench` runs in and the test helpers take theirs
// from (jest compiles scripts to CommonJS, where `import.meta` does not exist).
export const REPO = process.cwd();
// [LAW:no-silent-failure] Run elsewhere, every path below points at nothing,
// and the first thing to say so would be an unrelated ENOENT.
if (!fs.existsSync(path.join(REPO, "rust-client", "Cargo.toml"))) {
  throw new Error(`${REPO} is not the cc-candybar package root: run the benchmark with pnpm bench from there`);
}
export const BUNDLE = path.join(REPO, "dist", "index.mjs");
export const BUNDLED_CLIENT_SHIM = path.join(REPO, "bin", "cc-candybar");

// Where `just install-rust` stages the native client, then where `cargo build`
// leaves it: the staged one is what a deploy runs.
const NATIVE_CLIENTS = [
  path.join(REPO, "bin", "cc-candybar-native"),
  path.join(REPO, "rust-client", "target", "release", "cc-candybar"),
];

export interface NativeClient {
  readonly path: string;
  readonly bytes: number;
  readonly modified: string;
  // Whether the binary carries the digest of the crate source in this
  // checkout, which `just install-rust` bakes in: false is a binary built
  // from other source, or one built without the stamp.
  readonly builtFromThisSource: boolean;
}

export interface Environment {
  readonly capturedAt: string;
  readonly host: {
    readonly platform: string;
    readonly arch: string;
    readonly release: string;
    readonly cpuModel: string;
    readonly cpus: number;
    readonly memoryGiB: number;
  };
  readonly node: string;
  readonly commit: { readonly sha: string; readonly dirty: boolean };
  readonly bundle: { readonly modified: string } | null;
  // The shipped fast path: null when none is built.
  readonly native: NativeClient | null;
  // One-minute load average, at the start of the run: a busy machine's numbers
  // are the machine's.
  readonly loadAtStart: number;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

export function nativeClient(): NativeClient | null {
  const found = NATIVE_CLIENTS.find((p) => fs.existsSync(p));
  if (found === undefined) return null;
  const stat = fs.statSync(found);
  const stamp = crateDigest(path.join(REPO, "rust-client"));
  return {
    path: path.relative(REPO, found),
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
    builtFromThisSource: fs.readFileSync(found).includes(stamp),
  };
}

export const loadNow = (): number => Math.round(os.loadavg()[0]! * 100) / 100;

export function captureEnvironment(): Environment {
  const cpus = os.cpus();
  const bundle = fs.existsSync(BUNDLE) ? fs.statSync(BUNDLE) : null;
  return {
    capturedAt: new Date().toISOString(),
    host: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpuModel: cpus[0]?.model ?? "unknown",
      cpus: cpus.length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    },
    node: process.version,
    commit: {
      sha: git("rev-parse", "--short", "HEAD"),
      // Only what a run measures makes the tree dirty: the bench's own files
      // are not what is being timed.
      dirty:
        git("status", "--porcelain", "--", "src", "rust-client").length > 0,
    },
    bundle: bundle === null ? null : { modified: bundle.mtime.toISOString() },
    native: nativeClient(),
    loadAtStart: loadNow(),
  };
}

// [LAW:no-silent-failure] A bundle built from other source answers for code
// that is not in this checkout, and every wire number would be about that code.
// The daemon reports the digest baked into it; this is the checkpoint that
// compares it with the source tree.
export function requireCurrentBundle(bakedDigest: string | null): void {
  const current = sourceDigest(path.join(REPO, "src"));
  if (bakedDigest !== current) {
    throw new Error(
      `dist/ was built from ${bakedDigest === null ? "no source digest" : "other source"} (${bakedDigest} != ${current}): run pnpm build`,
    );
  }
}
