// [LAW:single-enforcer] Where installed plugins live, and which definitions
// those places hold. An app installs a plugin by dropping a folder —
// `<root>/<name>/plugin.json5` — into one of these roots, with no config
// edit; a plugin is on exactly when one of its segments is placed.

import fs from "node:fs";
import path from "node:path";
import type { PluginScope } from "../../config/loader/plugin-scope.js";
import type { Locations } from "../../config/loader/chain-places.js";
import type { Unchecked } from "../../utils/presence.js";
import type { ApprovedRepo } from "../../config/loader/repo-gate.js";

/**
 * The plugin roots, lowest precedence first: each `$XDG_DATA_DIRS` entry
 * (package managers — Homebrew's `share/` — the first entry the most
 * important, so it comes last), then `$XDG_DATA_HOME` (the user's), then
 * `<repo>/.cc-candybar/plugins` (a repo's own, for sessions working there,
 * once the user approved it). Each root carries its scope: the repo's is
 * `repo`, every other `plugins`. Within a scope a nearer root's plugin
 * replaces a farther one's of the same name. Read from `Locations`, as the XDG
 * config location is.
 */
// [LAW:one-source-of-truth] The scope is decided here, where the root is
// found, and travels with every definition the root holds.
export interface PluginRoot {
  readonly dir: string;
  readonly scope: PluginScope;
}

export function pluginRoots(
  locs: Locations,
  repo: ApprovedRepo | null,
): readonly PluginRoot[] {
  const installed = [
    ...[...locs.dataDirs]
      .reverse()
      .map((d) => path.join(d, "cc-candybar", "plugins")),
    userPluginRoot(locs),
  ];
  // A root listed twice keeps its NEAREST position: `$XDG_DATA_HOME` named in
  // `$XDG_DATA_DIRS` too still outranks every package manager's root.
  return [
    ...installed
      .filter((r, i) => installed.lastIndexOf(r) === i)
      .map((dir) => ({ dir, scope: "plugins" as const })),
    ...(repo === null
      ? []
      : [{ dir: path.join(repo, REPO_PLUGIN_DIR), scope: "repo" as const }]),
  ];
}

// The user's plugin root, `$XDG_DATA_HOME/cc-candybar/plugins`: where
// `cc-candybar plugin install` puts what it installs.
export function userPluginRoot(locs: Locations): string {
  return path.join(locs.dataHome, "cc-candybar", "plugins");
}

// [LAW:one-source-of-truth] Where a repository keeps its plugins, relative to
// its root: the root sessions working in it load, and the one
// `cc-candybar plugin install` installs from.
export const REPO_PLUGIN_DIR = path.join(".cc-candybar", "plugins");

// A root's entries: the folders in it, each a plugin's, and the loose files,
// each a drop naming where it belongs. A root that is not there holds
// nothing; one that cannot be listed is the `Unchecked` it is, never absence.
export function listFolders(
  root: string,
):
  | { readonly folders: readonly string[]; readonly files: readonly string[] }
  | Unchecked {
  try {
    // A dot-entry (`.git`, `.DS_Store`, an editor's) is never an install.
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const folders: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      const list =
        entry.isDirectory() || isDirectoryLink(root, entry) ? folders : files;
      list.push(entry.name);
    }
    return { folders, files };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { folders: [], files: [] }
      : { path: root, error: (e as Error).message };
  }
}

// A symlinked plugin folder (a package manager linking its share/) counts;
// a link to nothing is a folder whose definition is missing, and is listed
// so the load names it.
function isDirectoryLink(root: string, e: fs.Dirent): boolean {
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(root, e.name)).isDirectory();
  } catch {
    return true;
  }
}
