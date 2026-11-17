// [LAW:effects-at-boundaries] What config discovery found for one session's
// directories: every fact a load learns from the filesystem, as a value. The
// host finds it; the loader parses, merges and validates it and opens nothing.
// [LAW:types-are-the-program] A field missing here is a read the loader would
// have to make itself, so each fact the load uses has a place in this type.

import type { LayerRole } from "./layer-role.js";
import type { PluginScope } from "./loader/plugin-scope.js";

export interface ConfigSnapshot {
  // Lowest precedence first. Every layer in it is writable: the user's always
  // (the explicit file, when one is named, is the chain's one layer), a
  // repository's project and local layers once it is approved.
  readonly chain: readonly Layer[];
  // The session's repository and its answer, or null when its directories
  // hold nothing to ask about.
  readonly repo: RepoQuestion | null;
  // Installed plugins and the approved repository's, one per scope and name
  // (a nearer root's replacing a farther one's), lowest root first.
  readonly plugins: readonly PluginFile[];
  // Loose files in a plugin root: each drops, naming where it belongs.
  readonly strays: ReadonlyArray<Pick<PluginFile, "scope" | "path">>;
  readonly checkout: Checkout;
  // What discovery found wrong, each line as the bar shows it.
  readonly notices: readonly string[];
  // What the host's watch over these files cannot hear, or null: an edit it
  // misses never reaches the bar, so the bar says so.
  readonly watch: string | null;
}

export interface Layer {
  readonly role: LayerRole;
  // Where the layer lives: its messages, the directory its `run` actions
  // start in, the menu's link to the file. A write names the role.
  readonly path: string;
  readonly content: LayerContent;
  // The definitions the layer's `plugins` list names, by each entry as
  // written: discovery reads that one key, as a preprocessor its includes.
  readonly listed: Readonly<Record<string, PluginFile>>;
}

export type LayerContent =
  | { readonly kind: "text"; readonly text: string }
  // Not written yet: the layer merges nothing, and a write creates it.
  | { readonly kind: "absent" }
  // There, and its read failed: the load fails naming it.
  | { readonly kind: "unreadable"; readonly error: string };

// The one repository a session's directories belong to. Its project and local
// layers share its answer, kept under `dir`: a linked worktree's counterpart
// in its main worktree, else the directory itself.
export interface RepoQuestion {
  readonly dir: string;
  readonly standing: RepoStanding;
  // Why the directory's worktree link could not be proven, or null.
  readonly unproven: string | null;
}

// [LAW:types-are-the-program] `unread` is not `awaiting`: a book that could
// not be read takes no answer either, so the bar asks nothing it could not
// record.
export type RepoAnswer = "approved" | "declined";
export type RepoStanding = RepoAnswer | "awaiting" | "unread";

export interface PluginFile {
  readonly scope: PluginScope;
  // The definition as found: its identity, its messages, the base its `data`
  // path resolves against.
  readonly path: string;
  readonly definition: // `dir`: its folder's real path, where its `run` starts and its storage
    // lives, so a linked folder replaced by an install is another folder.
    | { readonly kind: "text"; readonly text: string; readonly dir: string }
    | { readonly kind: "unreadable"; readonly error: string };
}

// The checkout a working directory is in: its git root, or, for a directory
// in no checkout, the directory itself, with which of the two it is.
export interface Checkout {
  readonly root: string;
  readonly git: boolean;
}
