// [LAW:single-enforcer] The config chain's places: where a config file can
// live, the role each place gives it, in what precedence, and which file a
// write to each role lands in. One candidate-path enumerator feeds the host's
// search, its watchers and its collision detector, so none can disagree about
// which files are candidates. This file changes when the resolution rules
// change.
//
// [LAW:effects-at-boundaries] Pure path math over `Locations`: it opens no
// file, so the renderer can ask what a chain's places are. The search that
// looks at the disk is the host's discovery.

import path from "node:path";
import type { ConfigTarget } from "../../config-hint.js";
import type { Unchecked } from "../../utils/presence.js";
import type { ProjectAccess } from "./repo-gate.js";
import type { PluginScope } from "./plugin-scope.js";
import { LAYER_ROLES, type LayerRole } from "../layer-role.js";

// [LAW:one-source-of-truth] The set of accepted extensions lives here once.
// Both .json5 and .json are accepted: JSON ⊂ JSON5, so the same parser
// (JSON5.parse) handles both — only the filename lookup varies. Ordering is
// load-bearing: .json5 wins over .json at the same location (documented
// format > compatibility tail).
const CONFIG_EXTENSIONS = ["json5", "json"] as const;

// A candidate carries its own extension; an explicit file is read under
// exactly the path it names.
export interface ConfigCandidate {
  readonly file: string;
  readonly extension: string | null;
}

// [LAW:types-are-the-program] A location owns its ordered candidates and
// assigns each the same layer role. No consumer groups them by filename.
export interface ConfigLocation {
  readonly role: LayerRole;
  readonly candidates: readonly ConfigCandidate[];
}

// [LAW:types-are-the-program] Only layered discovery carries a project.
export type ConfigQuery =
  | {
      readonly kind: "chain";
      readonly projectDir?: string;
      readonly path?: string;
    }
  | { readonly kind: "file"; readonly path: string };

export const configQuery = (
  projectDir: string | undefined,
  target: ConfigTarget,
): ConfigQuery =>
  target.source === "argument-only"
    ? { kind: "file", path: target.path }
    : { kind: "chain", projectDir, path: target.path };

// Highest precedence first. The chain's bases are separate locations even
// when they share a directory. The extensions break ties within each base.
export function configLocations(
  locs: Locations,
  query: ConfigQuery,
  extensions: readonly [string, ...string[]] = CONFIG_EXTENSIONS,
): readonly ConfigLocation[] {
  const named: ConfigLocation | undefined =
    query.path === undefined
      ? undefined
      : { role: "user", candidates: [{ file: query.path, extension: null }] };
  const at = (role: LayerRole, base: string): ConfigLocation => ({
    role,
    candidates: extensions
      .map((extension) => ({ file: base + "." + extension, extension }))
      .filter(({ file }) => file !== query.path),
  });
  const project =
    query.kind === "chain" && query.projectDir !== undefined
      ? [
          at("local", path.join(query.projectDir, PROJECT_BASES.local)),
          at("project", path.join(query.projectDir, PROJECT_BASES.project)),
        ]
      : [];
  return [...project, named ?? at("user", xdgConfigBase(locs))];
}

/**
 * The full ordered list of candidate paths the DSL config could live at,
 * for a given project. Returned regardless of which exist — the
 * cache uses this to watch every candidate location so the creation of any
 * file in the resolution chain triggers hot-reload.
 *
 * A named file supplies the user layer. An isolated query has just that
 * candidate. Both queries use the same enumerator for discovery and watches.
 *
 * [LAW:single-enforcer] One enumerator; `searchConfig` layers the
 * files that exist, watchers listen on all of them, no second list.
 *
 * [LAW:dataflow-not-control-flow] Location is the dominant precedence axis;
 * extension breaks ties within a location. Encoded as a nested flat-map: each
 * location yields one path per extension in order. No branches on extension.
 */
export function dslConfigCandidatePaths(
  locs: Locations,
  query: ConfigQuery,
): readonly string[] {
  return configLocations(locs, query).flatMap(({ candidates }) =>
    candidates.map(({ file }) => file),
  );
}

// [LAW:one-source-of-truth] The base names a project's config files carry: the
// checked-in one, and the local one beside it.
const PROJECT_BASES: Readonly<Record<Exclude<LayerRole, "user">, string>> = {
  project: ".cc-candybar",
  local: ".cc-candybar.local",
};

// [LAW:one-source-of-truth] The extension-less base of the XDG location, the
// tail of the precedence chain: `$XDG_CONFIG_HOME/cc-candybar/config`
// (defaulting to `~/.config/cc-candybar/config`). The candidate enumerator
// appends each accepted extension; `userHome` appends the documented one.
function xdgConfigBase(locs: Locations): string {
  return path.join(locs.configHome, "cc-candybar", "config");
}

/**
 * One chain layer: its file, and its role in the chain.
 *
 * [LAW:one-source-of-truth] The role is decided where the search finds the
 * file, from which location supplied it, and rides with the path. A second
 * list of repository paths beside the layers drifts the moment a caller
 * builds or filters one list and not the other, and a repository's plugin
 * then replaces the installed one of the same name.
 */
export interface ConfigLayer {
  readonly path: string;
  readonly role: LayerRole;
}

// [LAW:single-enforcer] Discovery and write destinations admit the same roles.
export const admitsLayer = (project: ProjectAccess, role: LayerRole): boolean =>
  role === "user" || project.approved !== null;

// Whose plugins a layer lists: the user's installed ones, or its repository's.
export const scopeOf = (role: LayerRole): PluginScope =>
  role === "user" ? "plugins" : "repo";

// The user's own file or an explicit one: never a repository's, whatever its
// name. The one way to state a layer outside the search.
export function homeLayer(path: string): ConfigLayer {
  return { path, role: "user" };
}

/**
 * What the config search found. Three outcomes:
 *   • `chain` — the files the config is merged from, lowest precedence
 *     first: the user's XDG file, then the project's, then its local file, each
 *     layered over the ones before it through the same merge the bundled
 *     default takes (brandon-plugins-ktag.8th) — so a project file declares
 *     only what differs from the user's config, never a replacement of it.
 *     A named user file replaces the XDG layer. An empty chain uses the bundled default.
 *   • `missing` — an explicit file was named (`configFile`) and it is
 *     absent. The bundled base and any approved overlays render so a long-running bar
 *     stays live and the watcher recovers when the file appears — but it is
 *     not what the user asked for, and the render says so.
 *   • `unreadable` — an explicit file was named and stat could not see it
 *     (an unsearchable directory, a symlink loop); the errno rides the arm.
 * Every arm carries `home`: the user layer's file, where a durable click to
 * the user role writes. Every arm carries `unchecked`: locations stat could not
 * see past; the search never stops on a guess, and the notice names each.
 *
 * The project decision admits the same layers for rendering and writing.
 *
 * [LAW:types-are-the-program] `string | null` collapsed `default` and
 * `missing` into one null, which is how an explicit path to a nonexistent
 * file rendered byte-identically to no config at all (brandon-config-5g8).
 * The path rides on `missing` so the message and the durable-write target
 * both name it without re-deriving it from the inputs.
 */
export type ConfigResolution = {
  readonly project: ProjectAccess;
  readonly unchecked: readonly Unchecked[];
  readonly layers: readonly ConfigLayer[];
  readonly home: string;
} & (
  | { readonly kind: "chain" }
  | { readonly kind: "missing"; readonly path: string }
  | {
      readonly kind: "unreadable";
      readonly path: string;
      readonly error: string;
    }
);

export function userConfigDefault(locs: Locations): string {
  return xdgConfigBase(locs) + "." + CONFIG_EXTENSIONS[0];
}

// [LAW:one-source-of-truth] Each writable role uses its discovered file or
// its first candidate, where a first write creates it. Non-user roles need
// an approved project. Exact paths assigned to the user cannot be re-used
// as a second role.
export function chainPlaces(
  resolved: ConfigResolution,
  locations: readonly ConfigLocation[],
): readonly ConfigLayer[] {
  return LAYER_ROLES.flatMap((role): ConfigLayer[] => {
    if (!admitsLayer(resolved.project, role)) return [];
    if (role === "user") return [{ path: resolved.home, role }];
    const place =
      resolved.layers.find((layer) => layer.role === role)?.path ??
      locations.find((location) => location.role === role)?.candidates[0]?.file;
    return place === undefined ? [] : [{ path: place, role }];
  });
}

/**
 * The advisory a resolution renders beside the collision notice on the
 * strip: one line per location the search could not check, and the one
 * spelling each of "you named a file that is not there" / "…that cannot be
 * read". Total over the union; a verified `file` with nothing skipped says
 * nothing.
 *
 * [LAW:no-silent-failure] The bar still renders (the bundled default, for
 * liveness), but never silently: every row names its path, so the user can
 * tell a rejected override, an unreadable one, and a skipped location from
 * no override at all.
 */
export function configResolutionNotice(
  resolution: ConfigResolution,
): string | null {
  return (
    [
      ...noticeLines(resolution),
      ...resolution.unchecked.map(
        (u) => `Config location could not be checked: ${u.path} — ${u.error}`,
      ),
    ].join("\n") || null
  );
}

function noticeLines(resolution: ConfigResolution): readonly string[] {
  switch (resolution.kind) {
    case "chain":
      return [];
    case "missing":
      return [
        `Config file not found: ${resolution.path} — using the bundled base until it appears`,
      ];
    // The file's layer fails the load, which names it.
    case "unreadable":
      return [];
  }
}

// [LAW:one-source-of-truth] Where the user's config and installed plugins live,
// and the home they default under: the one derivation the config loader, the
// plugin installer share, so an empty `XDG_CONFIG_HOME` means the default in
// both (the XDG rule `xdgEnv` applies to every variable
// here). Pure over the host, parsed once by the root and handed down.
export interface Locations {
  readonly home: string;
  readonly configHome: string;
  readonly dataHome: string;
  // Most-preferred first, as `XDG_DATA_DIRS` orders them.
  readonly dataDirs: readonly string[];
}
