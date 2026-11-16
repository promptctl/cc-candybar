// [LAW:single-enforcer] Config-file discovery: where the DSL config can live, in
// what precedence. One candidate-path enumerator feeds the
// resolver, the watchers, and the collision detector so none can disagree about
// which files are candidates. This file changes when the resolution rules change.

import fs from "node:fs";
import path from "node:path";
import { presence, type Unchecked } from "../../utils/presence.js";
import { listFolders, REPO_PLUGIN_DIR } from "./plugin-folders.js";
import { worktreeLink } from "../../utils/git-root.js";
import {
  gateRepos,
  type ApprovedRepo,
  type RepoAnswers,
  type RepoDir,
  type RepoGate,
  type RepoProject,
} from "./repo-gate.js";
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
  return [...project, { role: "user", base: xdgConfigBase(locs) }];
}

// What a session's config search starts from: its project, and the explicit
// file its render origin names, which replaces the chain.
export interface ConfigQuery {
  readonly projectDir?: string;
  readonly configFile?: string;
}

// Each candidate file and the role its location gives it, highest precedence
// first. An explicit `configFile` is the user layer and the only candidate.
function configCandidates(
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
 * [LAW:single-enforcer] One enumerator; `resolveDslConfig` layers the
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

// Whether a file is a project's local layer, by the name it is found under.
export function isLocalConfigFile(file: string): boolean {
  return CONFIG_EXTENSIONS.some(
    (ext) => path.basename(file) === `${PROJECT_BASES.local}.${ext}`,
  );
}

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
 * the user role writes (`writeLayer`). `chain` carries `unchecked`: locations stat could not
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

/**
 * The search, over the locations of `dslConfigCandidatePaths`:
 *   1. `configFile` — the session's explicit path (`--config` > `configEnv`
 *      hint, absolute, from its render origin); the sole candidate when
 *      present
 *   2. `<projectDir>/.cc-candybar.local.json5`, then `.json`
 *   3. `<projectDir>/.cc-candybar.json5`, then `.json`
 *   4. `$XDG_CONFIG_HOME/cc-candybar/config.json5`, then `.json`
 *      (defaulting to `~/.config/cc-candybar/`)
 * Each LOCATION contributes its first existing file (`.json5` wins a tie;
 * the sibling is the collision notice), and the chain is those files in
 * reverse — the user's at the bottom, the local file on top. The local file
 * loads under its project's approval, since it is in the same directory and
 * a clone can commit a file by that name.
 *
 * [LAW:dataflow-not-control-flow] The locations array is data; the search is
 * one fold over `presence`. Adding a layer is a new array entry, not a new
 * branch.
 *
 * [LAW:single-enforcer] Built on top of `dslConfigCandidatePaths` — the
 * precedence list lives in one place. And the one place a repository's
 * answer decides whether its files load (`gateRepos`, whose `approved` the
 * layers are filtered by): the render, `check` and the durable writer all
 * resolve here.
 */
export function resolveDslConfig(
  locs: Locations,
  answers: RepoAnswers,
  query: ConfigQuery,
): ConfigResolution {
  const { projectDir, configFile } = query;
  const unchecked: Unchecked[] = [];
  // Each location's file, its role, and the repository directory that
  // supplies it — null for the user's own file or the explicit one.
  const atLocation = new Map<
    string,
    {
      readonly file: string;
      readonly role: LayerRole;
      readonly repo: RepoDir | null;
    }
  >();
  for (const { file: candidate, role } of configCandidates(locs, query)) {
    const p = presence(candidate);
    if (p === "absent") continue;
    if (p !== "present") {
      unchecked.push(p);
      continue;
    }
    // A location is a directory AND a base name: `.cc-candybar` and the XDG
    // `config` may share a directory and are two layers; `.json5`/`.json`
    // at one location are one, the first enumerated winning.
    // [LAW:one-source-of-truth] The on-disk spelling: on a case-insensitive
    // volume one directory reached as `Code` and `code` is one answer's key.
    const dir = fs.realpathSync.native(path.dirname(candidate));
    const location = path.join(
      dir,
      path.basename(candidate).replace(/\.(json5|json)$/, ""),
    );
    if (!atLocation.has(location)) {
      atLocation.set(location, {
        file: candidate,
        role,
        repo: role === "user" ? null : { dir, link: worktreeLink(dir) },
      });
    }
  }
  const found = [...atLocation.values()];
  // The project's file and its local one share a directory, and so an answer.
  const repoDirs = new Map(
    found.flatMap((f) => (f.repo === null ? [] : [[f.repo.dir, f.repo]])),
  );
  const repos = gateRepos(
    answers,
    [...repoDirs.values()],
    repoProject(projectDir),
  );
  const kept = found
    .filter((f) => f.repo === null || repos.approved.includes(f.repo.dir))
    .reverse();
  const layers = kept.map((f): ConfigLayer => ({ path: f.file, role: f.role }));
  if (configFile === undefined) {
    return {
      kind: "chain",
      layers,
      home: userHome(locs, layers),
      unchecked,
      repos,
    };
  }
  // An explicit path is the sole candidate: its one probe is the verdict.
  const [own] = unchecked;
  const home = configFile;
  if (layers.length > 0) {
    return { kind: "chain", layers, home, unchecked, repos };
  }
  return own === undefined
    ? { kind: "missing", path: configFile, home, repos }
    : { kind: "unreadable", ...own, home, repos };
}

// The user's own XDG file, at either extension: the one chain layer no
// repository can supply.
function isUserFile(locs: Locations, candidate: string): boolean {
  return CONFIG_EXTENSIONS.some(
    (e) => candidate === `${xdgConfigBase(locs)}.${e}`,
  );
}

// The session's project, or null for none, or one that is not there.
export function repoProject(
  projectDir: string | undefined,
): RepoProject | null {
  if (projectDir === undefined || presence(projectDir) !== "present") {
    return null;
  }
  const listed = listFolders(path.join(projectDir, REPO_PLUGIN_DIR));
  const dir = fs.realpathSync.native(projectDir);
  return {
    dir,
    link: worktreeLink(dir),
    path: projectDir,
    ships: !("error" in listed) && listed.folders.length > 0,
  };
}

// The user's file: the XDG layer when the chain holds one, else the file a
// first-ever write creates there — CONFIG_EXTENSIONS' head, the documented
// format, the one that wins a same-location tie.
function userHome(locs: Locations, layers: readonly ConfigLayer[]): string {
  return (
    layers.find((l) => isUserFile(locs, l.path))?.path ??
    `${xdgConfigBase(locs)}.${CONFIG_EXTENSIONS[0]}`
  );
}

/**
 * The file a DURABLE write to one role of the session's chain lands in, and
 * the chain's layers below and above it.
 *
 * The file is the layer the chain holds for the role, or, where it holds
 * none, the file a first write there creates. A value a layer ABOVE it holds
 * wins over anything it says, so a write the chain hides is refused by the
 * writer, naming the layer that holds it (`config-file-store`'s commit) —
 * never a click that silently does nothing.
 *
 * [LAW:one-source-of-truth] A projection of the same resolution the render
 * runs, so the file a click writes is a layer the next reload reads — by
 * construction, not by two lists agreeing.
 */
export interface WriteLayer {
  readonly path: string;
  readonly role: LayerRole;
  // The other roles' files under and over `path`, lowest first: each where
  // the chain holds it or a first write there creates it. Which of them is a
  // layer is the click's to say, since a click may create or change one
  // before it writes `path`.
  readonly below: readonly ConfigLayer[];
  readonly above: readonly ConfigLayer[];
  // The approved project whose plugins the chain loads, and the working
  // directory their checkout data paths resolve against.
  readonly repo: ApprovedRepo | null;
  readonly cwd: string | null;
  // Where the installed plugins this chain loads over live.
  readonly locs: Locations;
}

// [LAW:types-are-the-program] A role the session's chain has no place for:
// a project's layers are an approved project's, and an explicit config file
// is the chain's one layer.
interface Refused {
  readonly kind: "refused";
  readonly why: string;
}
export type LayerWrite = ({ readonly kind: "layer" } & WriteLayer) | Refused;

const rank = (role: LayerRole): number => LAYER_ROLES.indexOf(role);

export function writeLayer(
  locs: Locations,
  answers: RepoAnswers,
  query: ConfigQuery & { readonly cwd?: string },
  role: LayerRole,
): LayerWrite {
  return writeLayers(locs, answers, query)[role];
}

// Every role's write, projected from ONE resolution of the session's chain.
export function writeLayers(
  locs: Locations,
  answers: RepoAnswers,
  query: ConfigQuery & { readonly cwd?: string },
): Readonly<Record<LayerRole, LayerWrite>> {
  const resolved = resolveDslConfig(locs, answers, query);
  const layers = resolved.kind === "chain" ? resolved.layers : [];
  const places = LAYER_ROLES.flatMap((role): ConfigLayer[] => {
    const place = placeOf(resolved, layers, query, role);
    return place.kind === "at" ? [{ path: place.path, role }] : [];
  });
  const writeOf = (role: LayerRole): LayerWrite => {
    const place = placeOf(resolved, layers, query, role);
    if (place.kind === "refused") return place;
    return {
      kind: "layer",
      path: place.path,
      role,
      below: places.filter((l) => rank(l.role) < rank(role)),
      above: places.filter((l) => rank(l.role) > rank(role)),
      repo: resolved.repos.plugins,
      cwd: query.cwd ?? null,
      locs,
    };
  };
  return Object.fromEntries(
    LAYER_ROLES.map((role) => [role, writeOf(role)]),
  ) as Record<LayerRole, LayerWrite>;
}

// [LAW:dataflow-not-control-flow] The file a role names in the session's
// chain, or why it names none.
function placeOf(
  resolved: ConfigResolution,
  layers: readonly ConfigLayer[],
  { projectDir, configFile }: ConfigQuery,
  role: LayerRole,
): { readonly kind: "at"; readonly path: string } | Refused {
  if (role === "user") return { kind: "at", path: resolved.home };
  if (configFile !== undefined)
    return refused(
      `${configFile} is the session's one config layer (it was named explicitly), so there is no ${role} layer to write`,
    );
  if (projectDir === undefined || resolved.repos.plugins === null)
    return refused(
      `the ${role} layer is the project's, and this session has no approved project`,
    );
  return {
    kind: "at",
    path:
      layers.find((l) => l.role === role)?.path ??
      `${path.join(projectDir, PROJECT_BASES[role])}.${CONFIG_EXTENSIONS[0]}`,
  };
}

const refused = (why: string): Refused => ({ kind: "refused", why });

// [LAW:one-source-of-truth] The roles a session's chain can write: what its
// save offers, read off the same placement a write resolves, so the bar never
// offers a layer its click would refuse.
export function writableRoles(
  resolved: ConfigResolution,
  query: ConfigQuery,
): readonly LayerRole[] {
  const layers = resolved.kind === "chain" ? resolved.layers : [];
  return LAYER_ROLES.filter(
    (role) => placeOf(resolved, layers, query, role).kind === "at",
  );
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
    case "unreadable":
      return [
        `Config file could not be read: ${resolution.path} — ${resolution.error} — rendering the bundled default until it can be`,
      ];
  }
}

/**
 * Detect same-location extension collisions: any location where BOTH
 * `<base>.json5` and `<base>.json` exist simultaneously. The resolver picks
 * .json5 (documented format wins), but the user almost certainly didn't
 * intend to keep two; the duplicate is dead weight that will drift.
 *
 * Returns a human-readable warning naming the conflicting files, or null if
 * no collisions exist. The render path surfaces this through the daemon's
 * diagnostics channel so the user sees it on every render until they remove
 * the duplicate.
 *
 * [LAW:single-enforcer] Consumes `dslConfigCandidatePaths` — same enumerator
 * as the resolver and watcher; collision detection cannot disagree with
 * resolution about which files are candidates.
 *
 * [LAW:dataflow-not-control-flow] Walk candidates, group by parent directory
 * + base name (without extension), find groups with size > 1 whose members
 * all exist. No special-case branches per extension.
 */
export function detectConfigCollisions(
  locs: Locations,
  projectDir?: string,
): string | null {
  const existing = dslConfigCandidatePaths(locs, { projectDir }).filter(
    (candidate) => presence(candidate) === "present",
  );
  // Group by (dir + base-without-extension). A group with > 1 existing
  // member is a collision at that logical location.
  const groups = new Map<string, string[]>();
  for (const candidate of existing) {
    const dir = path.dirname(candidate);
    const base = path.basename(candidate).replace(/\.(json5|json)$/, "");
    const key = path.join(dir, base);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(candidate);
  }
  const collisions = [...groups.values()].filter((g) => g.length > 1);
  if (collisions.length === 0) return null;
  // Stable, parseable message. The first file in each group is the .json5
  // (the one that wins); the rest are the shadowed siblings.
  const lines = collisions.map((g) => {
    const [winner, ...shadowed] = g;
    return `${winner} shadows ${shadowed.join(", ")}`;
  });
  return `config-extension collision: ${lines.join("; ")} — remove the duplicate`;
}

// [LAW:one-source-of-truth] Where the user's config and installed plugins live,
// and the home they default under: the one derivation the config loader, the
// plugin installer and the doctor share, so an empty `XDG_CONFIG_HOME` means
// the default in all of them (the XDG rule `xdgEnv` applies to every variable
// here). Pure over the host, parsed once by the root and handed down.
export interface Locations {
  readonly home: string;
  readonly configHome: string;
  readonly dataHome: string;
  // Most-preferred first, as `XDG_DATA_DIRS` orders them.
  readonly dataDirs: readonly string[];
}
