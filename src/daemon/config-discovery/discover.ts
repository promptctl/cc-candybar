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
import type { Checkout } from "../../utils/git-root.js";
import type { Unchecked } from "../../utils/presence.js";
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
  REPO_PLUGIN_DIR,
  pluginRoots,
  type PluginRoot,
} from "./plugin-folders.js";
import {
  DEFINITION_FILE,
  pluginDefinitionProblem,
  listedPath,
  pluginList,
} from "../../config/loader/plugins.js";
import type { PluginScope } from "../../config/loader/plugin-scope.js";
import {
  repoUnreadNotice,
  type ApprovedRepo,
  type RepoAnswers,
  type RepoGate,
} from "../../config/loader/repo-gate.js";

// One plugin root as discovery listed it: each folder's definition, read, and
// each loose file, or why the root could not be listed.
export interface RootListing {
  readonly root: string;
  readonly scope: PluginScope;
  readonly listed:
    | {
        readonly folders: readonly PluginFile[];
        readonly files: readonly string[];
      }
    | Unchecked;
}

// [LAW:one-source-of-truth] What every origin's discovery shares: the user's
// answers for repositories and the installed plugin roots, read once, so a
// batch of origins discovered together reads each of them once.
export interface SharedFacts {
  readonly locs: Locations;
  readonly answers: () => RepoAnswers;
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
  let answers: RepoAnswers | undefined;
  return {
    locs: world.locations,
    answers: () => (answers ??= repoConfigs(world.stateDir).read()),
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

// The installed roots, lowest precedence first, each listed and its
// definitions read: origin-independent, as no repository's root is among
// them.
export function installedRoots(
  locs: Locations,
  files: DiscoveryFiles = discoveryFiles(),
): readonly RootListing[] {
  return pluginRoots(locs, null).map((root) => listRoot(root, files));
}

function listRoot(
  { dir, scope }: PluginRoot,
  files: DiscoveryFiles,
): RootListing {
  const listed = files.folders(dir);
  return {
    root: dir,
    scope,
    listed:
      "error" in listed
        ? listed
        : {
            folders: listed.folders.map((name) =>
              readDefinition(
                path.join(dir, name, DEFINITION_FILE),
                scope,
                files,
              ),
            ),
            files: listed.files,
          },
  };
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
    definition: read.kind === "text" ? { ...read, dir } : read,
  };
}

// What a session's plugins are, wherever its chain comes from: one definition
// per scope and name, the loose files, the roots that could not be listed,
// and the checkout its `data: { checkout }` paths resolve against.
export interface SessionPlugins {
  readonly plugins: readonly PluginFile[];
  readonly strays: readonly Stray[];
  readonly notices: readonly string[];
  readonly checkout: Checkout;
}

// [LAW:single-enforcer] The one place plugin precedence applies: keyed by
// scope and folder, a nearer root's plugin replaces a farther one's, so a
// repository's `lit` and an installed `lit` both survive. A folder whose name
// is no plugin's is keyed alike: it still loads, once, and drops naming why.
export function sessionPlugins(
  locs: Locations,
  installed: readonly RootListing[],
  repo: ApprovedRepo | null,
  cwd: string,
  files: DiscoveryFiles = discoveryFiles(),
): SessionPlugins {
  const repoRoots = pluginRoots(locs, repo)
    .filter((r) => r.scope === "repo")
    .map((root) => listRoot(root, files));
  const byNs = new Map<string, PluginFile>();
  const strays: Stray[] = [];
  const notices: string[] = [];
  for (const { root, scope, listed } of [...installed, ...repoRoots]) {
    // [LAW:types-are-the-program] A root that cannot be listed is a fact the
    // bar says, never absence.
    if ("error" in listed) {
      notices.push(
        `Plugin folder could not be listed: ${listed.path} — ${listed.error}`,
      );
      continue;
    }
    for (const file of listed.folders) {
      const key = `${scope}\0${path.basename(path.dirname(file.path))}`;
      byNs.delete(key);
      byNs.set(key, file);
    }
    for (const name of listed.files)
      strays.push({ path: path.join(root, name), scope });
  }
  return {
    plugins: [...byNs.values()],
    strays,
    notices,
    // [LAW:single-enforcer] The one place a session's working directory
    // becomes the checkout its plugins' data paths resolve against.
    // [LAW:nothing-unseen] exception: nothing watches for a `.git` appearing
    // above it, since an ancestor watch per session is the cost; the next
    // rediscovery reads the new checkout.
    checkout: files.checkout(cwd),
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

// [LAW:single-enforcer] What the render cache watches beside what the load
// names: every candidate location of the chain, there or not, and the plugin
// roots searched, so a file or a root appearing reloads.
export interface ConfigTargets {
  readonly candidates: readonly string[];
  readonly roots: readonly string[];
}

export interface Discovered {
  readonly snapshot: ConfigSnapshot;
  readonly targets: ConfigTargets;
  // What the origin's repositories contribute, as their answers decide it:
  // the gate the snapshot's question is ruled from in the same pass.
  readonly repos: RepoGate;
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
  const { resolution, question, locations, candidates } = search;
  const { repos } = resolution;
  const session = sessionPlugins(
    locs,
    shared.installed,
    repos.plugins,
    query.cwd,
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
  const notices = [
    configCollisionNotice(locations),
    configResolutionNotice(resolution),
    repoUnreadNotice(repos),
    ...session.notices,
  ].filter((n): n is string => n !== null);
  return {
    snapshot: { ...snapshotOf(session, chain), repo: question, notices },
    targets: {
      candidates,
      roots: [
        ...new Set([
          ...pluginRoots(locs, repos.plugins).map((r) => r.dir),
          // A chain must hear a new repository plugin even before approval.
          ...(query.kind === "chain" && query.projectDir !== undefined
            ? [path.join(query.projectDir, REPO_PLUGIN_DIR)]
            : []),
        ]),
      ],
    },
    repos,
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
