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

// A directory listing names candidates. The scope and folder name decide
// precedence before discovery opens a definition.
export interface RootListing {
  readonly root: string;
  readonly scope: PluginScope;
  readonly listed: FolderEntries | Unchecked;
}

// Package-manager directories, lowest precedence first, then the user's.
export function installedPluginDirs(locs: Locations): readonly string[] {
  const installed = [
    ...[...locs.dataDirs]
      .reverse()
      .map((d) => path.join(d, "cc-candybar", "plugins")),
    userPluginRoot(locs),
  ];
  // A root listed twice keeps its NEAREST position: `$XDG_DATA_HOME` named in
  // `$XDG_DATA_DIRS` too still outranks every package manager's root.
  return installed.filter((r, i) => installed.lastIndexOf(r) === i);
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

export const repoPluginDir = (project: string): string =>
  path.join(project, REPO_PLUGIN_DIR);

interface FolderEntries {
  readonly folders: readonly string[];
  readonly files: readonly string[];
}

// [LAW:parse-dont-validate] Only an approved project can publish names for
// the definition reader. A failed listing publishes only its diagnostic.
export function listedRepoRoot(
  approved: ApprovedRepo | null,
  entries: ReturnType<typeof listFolders> | null,
): RootListing | null {
  if (entries === null) return null;
  if ("error" in entries)
    return { root: entries.path, scope: "repo", listed: entries };
  return approved === null
    ? null
    : { root: repoPluginDir(approved), scope: "repo", listed: entries };
}

// A root's entries: the folders in it, each a plugin's, and the loose files,
// each a drop naming where it belongs. A root that is not there holds
// nothing; one that cannot be listed is the `Unchecked` it is, never absence.
export function listFolders(root: string): FolderEntries | Unchecked {
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
    return (e as NodeJS.ErrnoException).code === "ENOENT" && !isEntry(root)
      ? { folders: [], files: [] }
      : { path: root, error: (e as Error).message };
  }
}

// [LAW:no-silent-failure] A root that is a link to nothing is there to
// `lstat`: a prefix removed under it is a broken root, never an empty one.
function isEntry(root: string): boolean {
  try {
    fs.lstatSync(root);
    return true;
  } catch {
    return false;
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
