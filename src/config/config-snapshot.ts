// [LAW:effects-at-boundaries] What config discovery found at one origin: the
// imperative-shell half of a load, as a value. Parse, merge and validate are
// the loader's, which reads every text from here and opens no file.
// (docs/design/host-and-renderer.md §7)

import type { LayerRole } from "./layer-role.js";
import type { PluginScope } from "./loader/plugin-scope.js";
import type { Advisory } from "./loader/diagnostics.js";
import type { Checkout } from "../utils/git-root.js";
import type { ConfigTarget } from "../config-hint.js";
import { digestOf } from "../utils/plain.js";
import type { DisplayDigest } from "./displayed-config.js";

export type { LayerRole } from "./layer-role.js";
export type { Checkout } from "../utils/git-root.js";

// [LAW:types-are-the-program] It holds every fact a load learns from the
// filesystem, so the loader never asks the disk for one.
export interface ConfigSnapshot {
  // The host's opaque identity for the files each writable role resolves to.
  // Older recordings contain only the logical layer paths.
  readonly fileBinding?: DisplayDigest;
  readonly chain: readonly Layer[]; // lowest precedence first; every layer in it is writable
  readonly repo: RepoQuestion | null; // null: the origin's directories hold nothing to ask about
  readonly plugins: readonly PluginFile[]; // installed and the approved repository's, one per scope and name
  readonly strays: readonly Stray[]; // loose files in a plugin root, each dropped naming where it belongs
  // The root a plugin's `data.checkout` resolves against: the checkout of the
  // origin's working directory. A read failure supplies a notice and no root.
  readonly checkout: Checkout | null;
  readonly notices: readonly Advisory[]; // what discovery found wrong: a shadowed file, an unlistable root
  readonly watch: string | null; // what the config's watch cannot hear, or null
}

// [LAW:one-source-of-truth] A snapshot with its digest, taken once. Two
// revisions are the same config exactly when their digests are equal.
export interface ConfigRevision {
  readonly snapshot: ConfigSnapshot;
  readonly digest: string;
}

export function revisionOf(snapshot: ConfigSnapshot): ConfigRevision {
  return { snapshot, digest: digestOf(snapshot) };
}

// A chain is user, project, local. The file `--config` names is the user
// layer. With `--config-only` it is the only layer. A repository's layers
// are in the chain only after approval.
export interface Layer {
  readonly role: LayerRole;
  // Where the layer lives: messages, the directory its `run` actions start
  // in, and the menu's link to the file. A write names the role, never this.
  readonly path: string;
  readonly content: LayerContent;
  // The definitions the layer's `plugins` list names, by each entry as
  // written. Discovery reads that one key, as a preprocessor reads its
  // includes.
  readonly listed: Readonly<Record<string, PluginFile>>;
}

// [LAW:one-source-of-truth] The chain identifies a layer by its resolved
// role or the authored path it already holds.
export function layerForRole<T extends Pick<Layer, "role">>(
  chain: readonly T[],
  role: LayerRole,
): T | undefined {
  return chain.find((layer) => layer.role === role);
}

export function layerAtPath<T extends Pick<Layer, "path">>(
  chain: readonly T[],
  path: string,
): T | undefined {
  return chain.find((layer) => layer.path === path);
}

// [LAW:types-are-the-program] Missing and unreadable layers have different
// consequences. A write may create an absent layer.
export type LayerContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly error: string };

export function contentOfText(text: string | null): LayerContent {
  return text === null ? { kind: "absent" } : { kind: "text", text };
}

// [LAW:single-enforcer] Whether a click may write a layer holding `content`:
// what the bar offers and what a write refuses, so it never offers one its
// click refuses. A file it could not read is never written over.
export function writable(
  content: Layer["content"],
): content is Exclude<Layer["content"], { readonly kind: "unreadable" }> {
  return content.kind !== "unreadable";
}

// The one repository an origin's directories belong to. Project and local
// share its answer, kept under `dir`: a linked worktree's main checkout.
export interface RepoQuestion {
  readonly dir: string;
  readonly standing: "approved" | "declined" | "awaiting" | "unread";
  readonly unproven: string | null; // why the directory's worktree link could not be proven
}

// [LAW:single-enforcer] Both a live load and a replacement can keep a
// project-backed config only while discovery still admits that project.
export function retainsConfig(
  target: ConfigTarget,
  selected: RepoQuestion | null,
  current: RepoQuestion | null,
): boolean {
  return (
    selected?.standing !== "approved" ||
    (target.source !== "argument-only" &&
      current?.standing === "approved" &&
      current.dir === selected.dir)
  );
}

export interface PluginFile {
  readonly scope: PluginScope; // installed, or the repository's, which come with its approval
  readonly path: string; // the definition: its identity, its messages, its `data` path's base
  readonly definition:
    | {
        readonly kind: "text";
        readonly text: string;
        readonly dir: string;
        // The managed directory resolved by discovery, including for a linked plugin.
        readonly storage: string;
      }
    | { readonly kind: "unreadable"; readonly error: string };
}

// [LAW:one-source-of-truth] A loose file carries the scope of the root it
// sits in, as a definition does: an unnamed drop answers only for names in
// its own scope.
export interface Stray {
  readonly path: string;
  readonly scope: PluginScope;
}

// Scope and name name a plugin within its origin's snapshot.
export interface PluginRef {
  readonly scope: PluginFile["scope"];
  readonly name: string;
}
