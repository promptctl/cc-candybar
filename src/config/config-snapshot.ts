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
  // The root a plugin's `data.checkout` resolves against; null when no
  // working directory was named, so such a plugin drops naming why.
  readonly checkout: Checkout | null;
  readonly notices: readonly string[]; // what discovery found wrong: a shadowed file, an unlistable root
  readonly watch: string | null; // what the config's watch cannot hear, or null
}

// A chain is user, project, local. The file `--config` names is the user
// layer, and it replaces the chain, so the chain is that one layer. A
// repository's layers are in the chain only once it is approved.
export interface Layer {
  readonly role: LayerRole;
  // Where the layer lives: messages, the directory its `run` actions start
  // in, and the menu's link to the file. A write names the role, never this.
  readonly path: string;
  readonly content:
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "absent" } // not written yet: a write creates it
    | { readonly kind: "unreadable"; readonly error: string }; // maybe there, and not read: no layer of the merge, a notice, and no write
  // The definitions the layer's `plugins` list names, by each entry as
  // written. Discovery reads that one key, as a preprocessor reads its
  // includes.
  readonly listed: Readonly<Record<string, PluginFile>>;
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
    | { readonly kind: "text"; readonly text: string; readonly dir: string } // dir: its folder's real path
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
