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
import type { Unchecked } from "../../utils/presence.js";
import type { RepoGate } from "./repo-gate.js";
import type { PluginScope } from "./plugin-scope.js";
import { LAYER_ROLES, type LayerRole } from "../layer-role.js";

// [LAW:one-source-of-truth] The set of accepted extensions lives here once.
// Both .json5 and .json are accepted: JSON ⊂ JSON5, so the same parser
// (JSON5.parse) handles both — only the filename lookup varies. Ordering is
// load-bearing: .json5 wins over .json at the same location (documented
// format > compatibility tail).
const CONFIG_EXTENSIONS = ["json5", "json"] as const;

// One place a config file can be: its role, and its path without extension.
interface ConfigLocation {
  readonly role: LayerRole;
  readonly base: string;
}

// [LAW:dataflow-not-control-flow] The locations, highest precedence first, as
// the search reads them. The chain is user, project and local, as Claude
// Code's own settings are: a working directory names no layer, so a config in
// a subdirectory of the project, or in any other directory a session moves
// to, is not read.
function configLocations(
  locs: Locations,
  projectDir: string | undefined,
): readonly ConfigLocation[] {
  const project: readonly ConfigLocation[] = projectDir
    ? [
        { role: "local", base: path.join(projectDir, PROJECT_BASES.local) },
        { role: "project", base: path.join(projectDir, PROJECT_BASES.project) },
      ]
    : [];
  return [...project, { role: "user", base: locs.userConfig }];
}

// What a session's config search starts from: its project, and the explicit
// file its render origin names, which replaces the chain.
export interface ConfigQuery {
  readonly projectDir?: string;
  readonly configFile?: string;
}

// Each candidate file and the role its location gives it, highest precedence
// first. An explicit `configFile` is the user layer and the only candidate.
export function configCandidates(
  locs: Locations,
  { projectDir, configFile }: ConfigQuery,
): ReadonlyArray<{ readonly file: string; readonly role: LayerRole }> {
  // [LAW:dataflow-not-control-flow] An explicit override is the ONLY
  // candidate — the precedence chain collapses to one entry.
  if (configFile !== undefined) return [{ file: configFile, role: "user" }];
  return configLocations(locs, projectDir).flatMap(({ role, base }) =>
    CONFIG_EXTENSIONS.map((ext) => ({ file: `${base}.${ext}`, role })),
  );
}

/**
 * The full ordered list of candidate paths the DSL config could live at,
 * for a given project. Returned regardless of which exist — the
 * cache uses this to watch every candidate location so the creation of any
 * file in the resolution chain triggers hot-reload.
 *
 * `configFile` is the highest-precedence entry — the explicit path
 * a session's render origin names (`--config` > `configEnv` hint,
 * absolute). When present, it is the
 * sole candidate and the rest of the precedence chain is bypassed. This
 * module reads no environment of its own: the daemon is detached and
 * one-per-user, so its env answers for whichever shell spawned it, not for
 * the session being rendered ([LAW:no-ambient-temporal-coupling]).
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
  return configCandidates(locs, query).map(({ file }) => file);
}

// [LAW:one-source-of-truth] The base names a project's config files carry: the
// checked-in one, and the local one beside it.
const PROJECT_BASES: Readonly<Record<Exclude<LayerRole, "user">, string>> = {
  project: ".cc-candybar",
  local: ".cc-candybar.local",
};

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
 *     An explicit `configFile` is a chain of exactly that file. An empty
 *     chain is the bundled default, which is what the user asked for.
 *   • `missing` — an explicit file was named (`configFile`) and it is
 *     absent. The bundled default renders so a long-running bar
 *     stays live and the watcher recovers when the file appears — but it is
 *     not what the user asked for, and the render says so.
 *   • `unreadable` — an explicit file was named and stat could not see it
 *     (an unsearchable directory, a symlink loop); the errno rides the arm.
 * Every arm carries `home`: the user layer's file, where a durable click to
 * the user role writes. `chain` carries `unchecked`: locations stat could not
 * see past; the search never stops on a guess, and the notice names each.
 *
 * Every arm carries `repos`: what the session's repositories contribute,
 * as their answers decide it. A project or local layer whose directory is not
 * approved is not in the chain.
 *
 * [LAW:types-are-the-program] `string | null` collapsed `default` and
 * `missing` into one null, which is how an explicit path to a nonexistent
 * file rendered byte-identically to no config at all (brandon-config-5g8).
 * The path rides on `missing` so the message and the durable-write target
 * both name it without re-deriving it from the inputs.
 */
export type ConfigResolution = { readonly repos: RepoGate } & (
  | {
      readonly kind: "chain";
      readonly layers: readonly ConfigLayer[];
      readonly home: string;
      readonly unchecked: readonly Unchecked[];
    }
  | { readonly kind: "missing"; readonly path: string; readonly home: string }
  | {
      readonly kind: "unreadable";
      readonly path: string;
      readonly home: string;
      readonly error: string;
    }
);

// The user's own XDG file, at either extension: the one chain layer no
// repository can supply.
function isUserFile(locs: Locations, candidate: string): boolean {
  return CONFIG_EXTENSIONS.some((e) => candidate === `${locs.userConfig}.${e}`);
}

// The user's file: the XDG layer when the chain holds one, else the file a
// first-ever write creates there — CONFIG_EXTENSIONS' head, the documented
// format, the one that wins a same-location tie.
export function userHome(
  locs: Locations,
  layers: readonly ConfigLayer[],
): string {
  return (
    layers.find((l) => isUserFile(locs, l.path))?.path ??
    `${locs.userConfig}.${CONFIG_EXTENSIONS[0]}`
  );
}

// [LAW:dataflow-not-control-flow] The file a role names in the session's
// chain, or null where the chain has no place for it: a project's layers are
// an approved project's, and an explicit config file is the chain's one
// layer. The file is the layer the chain holds for the role, or, where it
// holds none, the file a first write there creates.
function placeOf(
  resolved: ConfigResolution,
  layers: readonly ConfigLayer[],
  { projectDir, configFile }: ConfigQuery,
  role: LayerRole,
): string | null {
  if (role === "user") return resolved.home;
  if (
    configFile !== undefined ||
    projectDir === undefined ||
    resolved.repos.plugins === null
  )
    return null;
  return (
    layers.find((l) => l.role === role)?.path ??
    `${path.join(projectDir, PROJECT_BASES[role])}.${CONFIG_EXTENSIONS[0]}`
  );
}

// [LAW:one-source-of-truth] Each role the session's chain can write, lowest
// first, at the file a write there lands in: the placement every write
// resolves, so discovery's chain holds exactly the layers a click can write.
export function chainPlaces(
  resolved: ConfigResolution,
  query: ConfigQuery,
): readonly ConfigLayer[] {
  const layers = resolved.kind === "chain" ? resolved.layers : [];
  return LAYER_ROLES.flatMap((role): ConfigLayer[] => {
    const place = placeOf(resolved, layers, query, role);
    return place === null ? [] : [{ path: place, role }];
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
  return noticeLines(resolution).join("\n") || null;
}

function noticeLines(resolution: ConfigResolution): readonly string[] {
  switch (resolution.kind) {
    case "chain":
      return resolution.unchecked.map(
        (u) => `Config location could not be checked: ${u.path} — ${u.error}`,
      );
    case "missing":
      return [
        `Config file not found: ${resolution.path} — rendering the bundled default until it appears`,
      ];
    // The file's layer fails the load, which names it.
    case "unreadable":
      return [];
  }
}

// [LAW:one-source-of-truth] Where the user's config and installed plugins live,
// and the home they default under: the one derivation the config loader, the
// plugin installer and the doctor share, so an empty `XDG_CONFIG_HOME` means
// the default in all of them (the XDG rule `xdgEnv` applies to every variable
// here). Pure over the host, parsed once by the root and handed down.
export interface Locations {
  readonly home: string;
  // The extension-less base of the user's config: the renderer's profile's.
  readonly userConfig: string;
  readonly dataHome: string;
  // Most-preferred first, as `XDG_DATA_DIRS` orders them.
  readonly dataDirs: readonly string[];
}
