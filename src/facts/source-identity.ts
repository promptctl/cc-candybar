// [LAW:one-source-of-truth] The seam a declared `shell` or `file` source
// crosses between a renderer and the host: what its run needs, and the digest
// that names it (spec: docs/design/gather-and-renderer.md, section 19). The
// renderer computes an identity from its config and its values; the host runs
// it, keyed by the digest, and hands the reading back in world state. Neither
// side reaches the other's half: a renderer never holds a run, and the host
// never evaluates a template.
//
// The identity is what a run needs and nothing the renderer owns: the
// default, the empty default and the key template are a declaration's, so two
// declarations differing only in those share a run. The key's VALUE is in,
// hashed, so a key that moves is a new identity with a run of its own.

import crypto from "node:crypto";
import { digestOf } from "../utils/plain.js";

export type ReadMode = "whole" | "first-line";

// What text a run reads: a command's stdout in a directory, or a file's
// content, whole or its first line.
export type SourceRead =
  | { readonly kind: "shell"; readonly command: string; readonly cwd: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly readMode: ReadMode;
    };

// [LAW:types-are-the-program] The parser without its default: the identity
// arm, a capture over a pattern, or a document. The pattern is the author's
// string, judged by the host before any reader compiles it.
export type ParserId =
  | { readonly kind: "text" }
  | { readonly kind: "regex"; readonly pattern: string }
  | { readonly kind: "json" };

// The cache policy as a run sees it: a period, a watched path, or none, the
// run reading once. A policy over the declaration's own values (`key`,
// `depends_on`) is a hash of what those values answered: the template is the
// renderer's, its value's hash is the run's.
export type RunRefresh =
  | { readonly kind: "ttl"; readonly durationMs: number }
  | { readonly kind: "watch_file"; readonly path: string }
  | { readonly kind: "key"; readonly hash: string }
  | { readonly kind: "never" };

export interface SourceIdentity {
  readonly read: SourceRead;
  readonly parse: ParserId;
  readonly refresh: RunRefresh;
}

declare const RUN: unique symbol;

// [LAW:types-are-the-program] An identity with the digest that names it. The
// brand means a `Run` is built only by `runOf`, so its digest cannot disagree
// with its identity, and the host keys by the digest without hashing again.
export interface Run {
  readonly digest: string;
  readonly identity: SourceIdentity;
  readonly [RUN]: true;
}

// [LAW:single-enforcer] The one digest of a source identity: lowercase sha256
// hex of its canonical JSON (src/utils/plain.ts).
export const runOf = (identity: SourceIdentity): Run =>
  ({ digest: digestOf(identity), identity }) as Run;

// [LAW:one-source-of-truth] The one hash of a key's value, the `key` message's
// `keyHash` on the wire (spec section 13).
export function keyHashOf(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
