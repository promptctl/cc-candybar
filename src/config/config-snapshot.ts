// [LAW:effects-at-boundaries] What config discovery found at one origin: the
// imperative-shell half of a load, as a value. Parse, merge and validate are
// the loader's, which reads every text from here and opens no file.
// (docs/design/host-and-renderer.md §7)

import type { LayerRole } from "./layer-role.js";
import type { PluginScope } from "./loader/plugin-scope.js";
import type { Checkout } from "../utils/git-root.js";

export type { LayerRole } from "./layer-role.js";
export type { Checkout } from "../utils/git-root.js";

// [LAW:types-are-the-program] It holds every fact a load learns from the
// filesystem, so the loader never asks the disk for one.
export interface ConfigSnapshot {
  readonly chain: readonly Layer[]; // lowest precedence first; every layer in it is writable
  readonly repo: RepoQuestion | null; // null: the origin's directories hold nothing to ask about
  readonly plugins: readonly PluginFile[]; // installed and the approved repository's, one per scope and name
  readonly strays: readonly Stray[]; // loose files in a plugin root, each dropped naming where it belongs
  // The root a plugin's `data.checkout` resolves against: the checkout of the
  // origin's working directory. A read failure supplies a notice and no root.
  readonly checkout: Checkout | null;
  readonly notices: readonly string[]; // what discovery found wrong: a shadowed file, an unlistable root
  readonly watch: string | null; // what the config's watch cannot hear, or null
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
export function layerForRole(
  chain: readonly Layer[],
  role: LayerRole,
): Layer | undefined {
  return chain.find((layer) => layer.role === role);
}

export function layerAtPath(
  chain: readonly Layer[],
  path: string,
): Layer | undefined {
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
