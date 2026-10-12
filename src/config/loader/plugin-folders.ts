// [LAW:single-enforcer] Where installed plugins live, and which definitions
// those places hold. An app installs a plugin by dropping a folder —
// `<root>/<name>/plugin.json5` — into one of these roots, with no config
// edit; a plugin is on exactly when one of its segments is placed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFINITION_FILE } from "./plugins.js";
import type { Unchecked } from "./discovery.js";

/**
 * The plugin roots, lowest precedence first: each `$XDG_DATA_DIRS` entry
 * (package managers — Homebrew's `share/` — the first entry the most
 * important, so it comes last), then `$XDG_DATA_HOME` (the user's), then
 * `<projectDir>/.cc-candybar/plugins` (a repo's own, for sessions working
 * there). A nearer root's plugin replaces a farther one's of the same name.
 * Read from the daemon's environment, as the XDG config location is.
 */
export function pluginRoots(projectDir: string | null): readonly string[] {
  const dataDirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .filter((d) => d !== "");
  const dataHome =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const roots = [
    ...[...dataDirs]
      .reverse()
      .map((d) => path.join(d, "cc-candybar", "plugins")),
    path.join(dataHome, "cc-candybar", "plugins"),
    ...(projectDir === null
      ? []
      : [path.join(projectDir, ".cc-candybar", "plugins")]),
  ];
  // A root listed twice keeps its NEAREST position: `$XDG_DATA_HOME` named in
  // `$XDG_DATA_DIRS` too still outranks every package manager's root.
  return roots.filter((r, i) => roots.lastIndexOf(r) === i);
}

export interface InstalledPlugins {
  // The roots searched, lowest first — every one is watched, so a plugin
  // installed into any of them, or a root created, reloads.
  readonly roots: readonly string[];
  // One definition path per plugin name, the nearest root's, in root order.
  readonly definitions: readonly string[];
  // Roots a listing could not see into (anything but absence).
  readonly unchecked: readonly Unchecked[];
}

// [LAW:types-are-the-program] A root that does not exist holds no plugins;
// one that cannot be listed is a fact the caller reports, never absence.
export function installedPlugins(projectDir: string | null): InstalledPlugins {
  const roots = pluginRoots(projectDir);
  const byName = new Map<string, string>();
  const unchecked: Unchecked[] = [];
  for (const root of roots) {
    const listed = listFolders(root);
    if ("error" in listed) {
      unchecked.push(listed);
      continue;
    }
    for (const name of listed.folders) {
      byName.delete(name);
      byName.set(name, path.join(root, name, DEFINITION_FILE));
    }
  }
  return { roots, definitions: [...byName.values()], unchecked };
}

function listFolders(
  root: string,
): { readonly folders: readonly string[] } | Unchecked {
  try {
    return {
      folders: fs
        .readdirSync(root, { withFileTypes: true })
        // A dot-folder (`.git`, an editor's) is never an install.
        .filter((e) => !e.name.startsWith("."))
        .filter((e) => e.isDirectory() || isDirectoryLink(root, e))
        .map((e) => e.name)
        .sort(),
    };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { folders: [] }
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
