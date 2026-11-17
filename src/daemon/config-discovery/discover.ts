// [LAW:effects-at-boundaries] Config discovery: every fact a config load
// learns from the filesystem, read ahead of the load and handed to it as one
// value (config-snapshot.ts). The loader opens no file; its disk reads are
// here. Discovery is total: whatever it cannot read is a notice, an
// `unreadable` layer or an `unreadable` definition, never a throw.
// [LAW:one-way-deps] It is the host's, so the zone rule refuses the renderer
// any import of it: the renderer loads what it is handed and reads no disk.

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import type {
  ConfigSnapshot,
  Layer,
  PluginFile,
  Stray,
} from "../../config/config-snapshot.js";
import { checkoutOf, type Checkout } from "../../utils/git-root.js";
import type { Unchecked } from "../../utils/presence.js";
import { repoConfigs } from "./repo-configs.js";
import type { LayerRole } from "../../config/layer-role.js";
import {
  chainPlaces,
  configCandidates,
  configResolutionNotice,
  dslConfigCandidatePaths,
  scopeOf,
  type ConfigLayer,
  type ConfigQuery,
  type ConfigResolution,
  type Locations,
} from "../../config/loader/chain-places.js";
import { detectConfigCollisions, searchConfig } from "./config-search.js";
import { listFolders, pluginRoots, type PluginRoot } from "./plugin-folders.js";
import {
  DEFINITION_FILE,
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
  readonly answers: RepoAnswers;
  readonly installed: readonly RootListing[];
}

export interface DiscoveryWorld {
  readonly locations: Locations;
  readonly stateDir: string;
}

export function readShared(world: DiscoveryWorld): SharedFacts {
  return {
    locs: world.locations,
    answers: repoConfigs(world.stateDir).read(),
    installed: installedRoots(world.locations),
  };
}

// The installed roots, lowest precedence first, each listed and its
// definitions read: origin-independent, as no repository's root is among
// them.
export function installedRoots(locs: Locations): readonly RootListing[] {
  return pluginRoots(locs, null).map(listRoot);
}

function listRoot({ dir, scope }: PluginRoot): RootListing {
  const listed = listFolders(dir);
  return {
    root: dir,
    scope,
    listed:
      "error" in listed
        ? listed
        : {
            folders: listed.folders.map((name) =>
              readDefinition(path.join(dir, name, DEFINITION_FILE), scope),
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
export function readDefinition(file: string, scope: PluginScope): PluginFile {
  if (path.basename(file) !== DEFINITION_FILE) {
    return {
      scope,
      path: file,
      definition: {
        kind: "unreadable",
        error: `not read: a plugin's definition is its folder's ${DEFINITION_FILE}`,
      },
    };
  }
  try {
    const text = fs.readFileSync(file, "utf-8");
    // [LAW:one-source-of-truth] The real path: a plugin's `run` runs in its
    // folder and its storage lives under it, so a linked folder replaced by
    // an install is another folder.
    const dir = fs.realpathSync(path.dirname(file));
    return { scope, path: file, definition: { kind: "text", text, dir } };
  } catch (e) {
    return {
      scope,
      path: file,
      definition: { kind: "unreadable", error: (e as Error).message },
    };
  }
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
): SessionPlugins {
  const repoRoots = pluginRoots(locs, repo)
    .filter((r) => r.scope === "repo")
    .map(listRoot);
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
    checkout: checkoutOf(cwd),
  };
}

// A layer file's text, or why it could not be read. A directory's read error
// names no path, so it is said as what it is.
export function readLayer(file: string): Layer["content"] {
  try {
    return { kind: "text", text: fs.readFileSync(file, "utf-8") };
  } catch (e) {
    const error =
      (e as NodeJS.ErrnoException).code === "EISDIR"
        ? "not a file"
        : (e as Error).message;
    return { kind: "unreadable", error };
  }
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
): Layer {
  const refs = content.kind === "text" ? pluginRefs(content.text) : [];
  return {
    role,
    path: file,
    content,
    listed: Object.fromEntries(
      refs.map((ref) => [
        ref,
        readDefinition(listedPath(ref, file, home), scopeOf(role)),
      ]),
    ),
  };
}

// The entries of a text's `plugins` list. A text that does not parse, or
// whose list is not one, lists nothing here: the loader parses the whole text
// and reports both, naming the line.
function pluginRefs(text: string): readonly string[] {
  let json: unknown;
  try {
    json = JSON5.parse(text);
  } catch {
    return [];
  }
  return typeof json === "object" && json !== null && "plugins" in json
    ? (pluginList(json.plugins) ?? [])
    : [];
}

// The snapshot of a chain over a session's plugins: what a caller that names
// its chain outright (`check`'s layers, a writer's held texts) loads.
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
export interface DiscoverQuery extends ConfigQuery {
  readonly cwd: string;
}

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
  const { locs, answers } = shared;
  const { resolution, question } = searchConfig(locs, answers, query);
  const { repos } = resolution;
  const session = sessionPlugins(
    locs,
    shared.installed,
    repos.plugins,
    query.cwd,
  );
  const places = chainPlaces(resolution, query).map((place) =>
    contentAt(locs, query, resolution, place),
  );
  const chain = places.map((at) =>
    layerOf(at.role, at.path, at.content, locs.home),
  );
  // [LAW:dataflow-not-control-flow] Every notice is computed every time; an
  // absent one is a null in the list.
  const notices = [
    detectConfigCollisions(locs, query.projectDir),
    configResolutionNotice(resolution),
    ...places.map((at) => at.notice),
    repoUnreadNotice(repos),
    ...session.notices,
  ].filter((n): n is string => n !== null);
  return {
    snapshot: { ...snapshotOf(session, chain), repo: question, notices },
    targets: {
      candidates: dslConfigCandidatePaths(locs, query),
      roots: pluginRoots(locs, repos.plugins).map((r) => r.dir),
    },
    repos,
  };
}

// The file a chain role names, and what is there: the layer the search
// found, read; the location stat could not see past; or nothing yet. The
// resolution's own notice names a location stat could not see past; a file
// the search found and could not then read earns its own here.
function contentAt(
  locs: Locations,
  query: ConfigQuery,
  resolution: ConfigResolution,
  place: ConfigLayer,
): ConfigLayer & {
  readonly content: Layer["content"];
  readonly notice: string | null;
} {
  const at = (path: string, content: Layer["content"]) => ({
    role: place.role,
    path,
    content,
    notice: null,
  });
  switch (resolution.kind) {
    case "missing":
      return at(place.path, { kind: "absent" });
    case "unreadable":
      return at(place.path, { kind: "unreadable", error: resolution.error });
    case "chain": {
      const found = resolution.layers.find((l) => l.role === place.role);
      if (found !== undefined) {
        const content = readLayer(found.path);
        return {
          ...at(found.path, content),
          notice:
            content.kind === "unreadable"
              ? `Config file could not be read: ${found.path} — ${content.error} — rendering without it until it can be`
              : null,
        };
      }
      const roles = new Map(
        configCandidates(locs, query).map((c) => [c.file, c.role]),
      );
      const unseen = resolution.unchecked.find(
        (u) => roles.get(u.path) === place.role,
      );
      return at(
        place.path,
        unseen === undefined
          ? { kind: "absent" }
          : { kind: "unreadable", error: unseen.error },
      );
    }
  }
}
