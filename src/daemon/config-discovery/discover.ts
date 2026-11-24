// [LAW:effects-at-boundaries] Config discovery: every fact a config load
// learns from the filesystem, read ahead of the load and handed to it as one
// value (config-snapshot.ts). The loader opens no file; its disk reads are
// here. Discovery is total: whatever it cannot read is a notice, an
// `unreadable` layer or an `unreadable` definition, never a throw.
// [LAW:one-way-deps] It is the host's, so the zone rule refuses the renderer
// any import of it: the renderer loads what it is handed and reads no disk.

import path from "node:path";
import { parseJson5Syntax } from "../../config/loader/diagnostics.js";
import type {
  ConfigSnapshot,
  Layer,
  PluginFile,
  Stray,
} from "../../config/config-snapshot.js";
import type { Checkout, CheckoutRead } from "../../utils/git-root.js";
import type { StateObservation } from "../state-file.js";
import { repoConfigs } from "./repo-configs.js";
import type { LayerRole } from "../../config/layer-role.js";
import {
  chainPlaces,
  configResolutionNotice,
  scopeOf,
  type ConfigLayer,
  type ConfigQuery,
  type Locations,
} from "../../config/loader/chain-places.js";
import { configCollisionNotice, searchConfig } from "./config-search.js";
import {
  discoveryFiles,
  diskFiles,
  readNamedText,
  type DiscoveryFiles,
} from "./discovery-files.js";
import {
  installedPluginDirs,
  repoPluginDir,
  type RootListing,
} from "./plugin-folders.js";
import {
  DEFINITION_FILE,
  STORAGE_FOLDER,
  pluginDefinitionProblem,
  listedPath,
  pluginList,
} from "../../config/loader/plugins.js";
import type { PluginScope } from "../../config/loader/plugin-scope.js";
import { advisory, type Advisory } from "../../config/loader/diagnostics.js";
import {
  repoUnreadNotice,
  type RepoConfigBook,
} from "../../config/loader/repo-gate.js";

// [LAW:one-source-of-truth] What every origin's discovery shares: the user's
// answers for repositories and the installed plugin roots, read once, so a
// batch of origins discovered together reads each of them once.
export interface SharedFacts {
  readonly locs: Locations;
  readonly answers: () => StateObservation<RepoConfigBook>;
  readonly installed: readonly RootListing[];
  readonly files: DiscoveryFiles;
  readonly references: (text: string) => readonly string[];
}

export interface DiscoveryWorld {
  readonly locations: Locations;
  readonly stateDir: string;
}

export function readShared(
  world: DiscoveryWorld,
  source: DiscoveryFiles = diskFiles,
): SharedFacts {
  const files = discoveryFiles(source);
  const included = new Map<string, readonly string[]>();
  const book = repoConfigs(world.stateDir, files.stateText);
  let answers: StateObservation<RepoConfigBook> | undefined;
  return {
    locs: world.locations,
    answers: () => (answers ??= book.observe()),
    installed: installedRoots(world.locations, files),
    files,
    // The same bytes can name different physical files relative to their
    // layers. Parse the reference names once and resolve them at each layer.
    references: (text) => {
      const held = included.get(text);
      if (held !== undefined) return held;
      const names = pluginRefs(text);
      included.set(text, names);
      return names;
    },
  };
}

// Installed roots in ascending precedence. Every origin in the batch uses
// the same directory listings.
export function installedRoots(
  locs: Locations,
  files: DiscoveryFiles = discoveryFiles(),
): readonly RootListing[] {
  return installedPluginDirs(locs).map((root) => ({
    root,
    scope: "plugins",
    listed: files.folders(root),
  }));
}

/**
 * One definition, read: its text and its folder's real path, or why it could
 * not be had. A path that names no definition file is never opened — the
 * loader refuses it by its name before it would read it, and it could be any
 * file at all.
 */
export function readDefinition(
  file: string,
  scope: PluginScope,
  files: DiscoveryFiles = diskFiles,
): PluginFile {
  const badPath = pluginDefinitionProblem(file);
  if (badPath !== null)
    return {
      scope,
      path: file,
      definition: { kind: "unreadable", error: badPath },
    };
  // [LAW:one-source-of-truth] The same physical plugin folder determines
  // its definition read, sources and programs. Keep the original path for
  // the name, legacy data paths and diagnostics.
  const dir = files.realpath(path.dirname(file));
  if (typeof dir !== "string")
    return {
      scope,
      path: file,
      definition: { kind: "unreadable", error: dir.error },
    };
  const read = readNamedText(files, dir, file);
  return {
    scope,
    path: file,
    definition:
      read.kind === "text"
        ? { ...read, dir, storage: path.join(dir, STORAGE_FOLDER) }
        : read,
  };
}

// What a session's plugins are, wherever its chain comes from: one definition
// per scope and name, the loose files, the roots that could not be listed,
// and the checkout its `data: { checkout }` paths resolve against.
export interface SessionPlugins {
  readonly plugins: readonly PluginFile[];
  readonly strays: readonly Stray[];
  readonly notices: readonly Advisory[];
  readonly checkout: Checkout | null;
}

// [LAW:single-enforcer] The scope and folder name select the definition
// before it is opened. An unreadable winner keeps its own diagnostic.
// A repository's `lit` and an installed `lit` belong to different scopes.
export function sessionPlugins(
  roots: readonly RootListing[],
  checkout: CheckoutRead,
  files: DiscoveryFiles = discoveryFiles(),
): SessionPlugins {
  const byNs = new Map<string, Pick<PluginFile, "path" | "scope">>();
  const strays: Stray[] = [];
  const notices: Advisory[] = [];
  for (const { root, scope, listed } of roots) {
    // [LAW:types-are-the-program] A root that cannot be listed is a fact the
    // bar says, never absence.
    if ("error" in listed) {
      notices.push(
        advisory(
          ["plugin-folder", listed.path],
          `Plugin folder could not be listed: ${listed.path} — ${listed.error}`,
        ),
      );
      continue;
    }
    for (const name of listed.folders) {
      const key = `${scope}\0${name}`;
      byNs.delete(key);
      byNs.set(key, { scope, path: path.join(root, name, DEFINITION_FILE) });
    }
    for (const name of listed.files)
      strays.push({ path: path.join(root, name), scope });
  }
  // [LAW:no-silent-failure] Only confirmed absence can use cwd. A failed
  // ancestor check gives checkout-relative plugin data no root.
  if (checkout.kind === "failed")
    notices.push(
      advisory(["checkout"], `Checkout could not be read: ${checkout.reason}`),
    );
  return {
    plugins: [...byNs.values()].map((file) =>
      readDefinition(file.path, file.scope, files),
    ),
    strays,
    notices,
    checkout: checkout.kind === "ok" ? checkout.value : null,
  };
}

// A layer file's text, or why it could not be read. A directory's read error
// names no path, so it is said as what it is.
export function readLayer(file: string): Layer["content"] {
  return diskFiles.text(file);
}

/**
 * A layer, and the definitions its text lists, read. Discovery reads the
 * `plugins` key and nothing else, as a preprocessor reads its includes:
 * resolving each entry as the loader names it, against the layer's directory
 * and `~`. Whose plugins they are is the layer's role.
 */
export function layerOf(
  role: LayerRole,
  file: string,
  content: Layer["content"],
  home: string,
  batch: Pick<SharedFacts, "files" | "references"> = {
    files: diskFiles,
    references: pluginRefs,
  },
): Layer {
  const refs = content.kind === "text" ? batch.references(content.text) : [];
  return {
    role,
    path: file,
    content,
    listed: Object.fromEntries(
      refs.map((ref) => [
        ref,
        readDefinition(listedPath(ref, file, home), scopeOf(role), batch.files),
      ]),
    ),
  };
}

// The entries of a text's `plugins` list. A text that does not parse, or
// whose list is not one, lists nothing here: the loader parses the whole text
// and reports both, naming the line.
function pluginRefs(text: string): readonly string[] {
  const syntax = parseJson5Syntax(text);
  if (syntax.kind === "invalid") return [];
  const json = syntax.value;
  return typeof json === "object" && json !== null && "plugins" in json
    ? (pluginList(json.plugins) ?? [])
    : [];
}

// The snapshot of a chain over a session's plugins: what a caller that names
// its chain outright (a writer's held texts) loads.
export function snapshotOf(
  session: SessionPlugins,
  chain: readonly Layer[],
): ConfigSnapshot {
  return {
    chain,
    repo: null,
    plugins: session.plugins,
    strays: session.strays,
    checkout: session.checkout,
    notices: session.notices,
    watch: null,
  };
}

// Where an origin's config is discovered: its project, the explicit file it
// names, and the working directory its checkout is found from.
export type DiscoverQuery = ConfigQuery & { readonly cwd: string };

// [LAW:single-enforcer] Discovery names every candidate layer, repository
// answer file it consulted, and plugin root it searched. A new file in
// those locations can change the snapshot.
export interface ConfigTargets {
  readonly files: readonly string[];
  readonly roots: readonly string[];
}

export interface Discovered {
  readonly snapshot: ConfigSnapshot;
  readonly targets: ConfigTargets;
}

/**
 * Discover the config at one origin: resolve its chain, read each layer and
 * the definitions it lists, list the plugin roots its plugins come from, and
 * say what could not be read.
 *
 * [LAW:one-source-of-truth] The chain holds every layer a click can write,
 * each at the file a write lands in: a layer not written yet is `absent`, and
 * one whose location stat could not see past is `unreadable`, never `absent`
 * — a write must not create a file where one may already be.
 */
export function discover(
  query: DiscoverQuery,
  shared: SharedFacts,
): Discovered {
  const { locs, answers, files } = shared;
  const search = searchConfig(locs, answers, query, files);
  const { resolution, repoRoot, locations, watchedFiles } = search;
  const { project } = resolution;
  const session = sessionPlugins(
    repoRoot === null ? shared.installed : [...shared.installed, repoRoot],
    // [LAW:nothing-unseen] exception: discovery observes a new ancestor .git
    // on its next pass. Watching every parent would add a watch per ancestor.
    files.checkout(query.cwd),
    files,
  );
  const places = chainPlaces(resolution, locations).map((place) =>
    contentAt(search, place, files),
  );
  const chain = places.map((at) =>
    layerOf(at.role, at.path, at.content, locs.home, shared),
  );
  // [LAW:dataflow-not-control-flow] Every notice is computed every time; an
  // absent one is a null in the list.
  const { unreadIdentity } = project;
  const notices = [
    configCollisionNotice(locations),
    configResolutionNotice(resolution),
    repoUnreadNotice(project),
    unreadIdentity === null
      ? null
      : advisory(
          ["repository-identity", unreadIdentity.dir],
          `Repository identity could not be read: ${unreadIdentity.dir} — ${unreadIdentity.reason}`,
        ),
    ...session.notices,
  ].filter((n): n is Advisory => n !== null);
  return {
    snapshot: {
      ...snapshotOf(session, chain),
      repo: project.question,
      notices,
    },
    targets: {
      files: watchedFiles,
      roots: [
        ...new Set([
          ...shared.installed.map((r) => r.root),
          // A chain must hear a new repository plugin even before approval.
          ...(query.kind === "chain" && query.projectDir !== undefined
            ? [repoPluginDir(query.projectDir)]
            : []),
        ]),
      ],
    },
  };
}

// The file a chain role names, and what is there: the layer the search
// found, read; the location stat could not see past; or nothing yet. The
// load fails naming a layer it could not read.
function contentAt(
  { resolution, locations }: ReturnType<typeof searchConfig>,
  place: ConfigLayer,
  files: DiscoveryFiles,
): ConfigLayer & { readonly content: Layer["content"] } {
  const at = (path: string, content: Layer["content"]) => ({
    role: place.role,
    path,
    content,
  });
  if (place.role === "user" && resolution.kind === "missing")
    return at(place.path, { kind: "absent" });
  if (place.role === "user" && resolution.kind === "unreadable")
    return at(place.path, { kind: "unreadable", error: resolution.error });
  const location = locations.find(({ role }) => role === place.role);
  if (location?.kind === "found" && location.winner.file === place.path)
    return at(place.path, readNamedText(files, location.directory, place.path));
  const unchecked = location?.unchecked[0];
  return unchecked === undefined
    ? at(place.path, { kind: "absent" })
    : at(unchecked.path, { kind: "unreadable", error: unchecked.error });
}
