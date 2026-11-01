// [LAW:single-enforcer] Where installed plugins live, and which definitions
// those places hold. An app installs a plugin by dropping a folder —
// `<root>/<name>/plugin.json5` — into one of these roots, with no config
// edit; a plugin is on exactly when one of its segments is placed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFINITION_FILE,
  pluginDefinition,
  type DroppedPlugin,
  type PluginDefinition,
} from "./plugins.js";
import type { PluginScope } from "./plugin-scope.js";
import type { Unchecked } from "../../utils/presence.js";
import type { ApprovedRepo } from "./repo-gate.js";

/**
 * The plugin roots, lowest precedence first: each `$XDG_DATA_DIRS` entry
 * (package managers — Homebrew's `share/` — the first entry the most
 * important, so it comes last), then `$XDG_DATA_HOME` (the user's), then
 * `<repo>/.cc-candybar/plugins` (a repo's own, for sessions working there,
 * once the user approved it). Each root carries its scope: the repo's is
 * `repo`, every other `plugins`. Within a scope a nearer root's plugin
 * replaces a farther one's of the same name. Read from the daemon's
 * environment, as the XDG config location is.
 */
// [LAW:one-source-of-truth] The scope is decided here, where the root is
// found, and travels with every definition the root holds.
export interface PluginRoot {
  readonly dir: string;
  readonly scope: PluginScope;
}

export function pluginRoots(repo: ApprovedRepo | null): readonly PluginRoot[] {
  const dataDirs = (process.env.XDG_DATA_DIRS || defaultDataDirs())
    .split(":")
    .filter((d) => d !== "");
  const installed = [
    ...[...dataDirs]
      .reverse()
      .map((d) => path.join(d, "cc-candybar", "plugins")),
    userPluginRoot(),
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
export function userPluginRoot(): string {
  const dataHome =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "cc-candybar", "plugins");
}

// [LAW:one-source-of-truth] Where a repository keeps its plugins, relative to
// its root: the root sessions working in it load, and the one
// `cc-candybar plugin install` installs from.
export const REPO_PLUGIN_DIR = path.join(".cc-candybar", "plugins");

// The XDG default, and on macOS Homebrew's share/ first — Apple-silicon
// Homebrew lives outside `/usr/local` (`$HOMEBREW_PREFIX`, set by its shellenv,
// else its default `/opt/homebrew`).
function defaultDataDirs(): string {
  const xdg = "/usr/local/share:/usr/share";
  return process.platform === "darwin"
    ? `${path.join(process.env.HOMEBREW_PREFIX || "/opt/homebrew", "share")}:${xdg}`
    : xdg;
}

export interface InstalledPlugins {
  // The roots searched, lowest first — every one is watched, so a plugin
  // installed into any of them, or a root created, reloads.
  readonly roots: readonly string[];
  // One definition per plugin namespace, the nearest root's, in root order.
  readonly definitions: readonly PluginDefinition[];
  // Roots a listing could not see into (anything but absence).
  readonly unchecked: readonly Unchecked[];
  // Files sitting directly in a root: a plugin is a folder, so each is a drop
  // naming where it belongs.
  readonly strays: readonly DroppedPlugin[];
}

// [LAW:types-are-the-program] A root that does not exist holds no plugins;
// one that cannot be listed is a fact the caller reports, never absence.
export function installedPlugins(repo: ApprovedRepo | null): InstalledPlugins {
  const roots = pluginRoots(repo);
  // [LAW:single-enforcer] The one place same-scope precedence applies: keyed
  // by namespace, so a repo's `lit` and an installed `lit` both survive.
  const byNs = new Map<string, PluginDefinition>();
  const unchecked: Unchecked[] = [];
  const strays: DroppedPlugin[] = [];
  for (const { dir: root, scope } of roots) {
    const listed = listFolders(root);
    if ("error" in listed) {
      unchecked.push(listed);
      continue;
    }
    for (const name of listed.folders) {
      const definition = pluginDefinition(
        path.join(root, name, DEFINITION_FILE),
        scope,
      );
      // Keyed by scope and folder alike for a folder whose name is no
      // plugin's: it still loads, once, and drops naming why.
      const key = `${scope}\0${name}`;
      byNs.delete(key);
      byNs.set(key, definition);
    }
    for (const file of listed.files) {
      strays.push({
        path: path.join(root, file),
        scope,
        name: undefined,
        reason: `a plugin is a folder holding its ${DEFINITION_FILE}: move this file to ${path.join(root, "<name>", DEFINITION_FILE)}`,
      });
    }
  }
  return {
    roots: roots.map((r) => r.dir),
    definitions: [...byNs.values()],
    unchecked,
    strays,
  };
}

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
    const isFolder = (e: fs.Dirent): boolean =>
      e.isDirectory() || isDirectoryLink(root, e);
    return {
      folders: entries.filter(isFolder).map((e) => e.name),
      files: entries.filter((e) => !isFolder(e)).map((e) => e.name),
    };
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
