// [LAW:single-enforcer] Config-file discovery: where the DSL config can live, in
// what precedence. One candidate-path enumerator feeds the
// resolver, the watchers, and the collision detector so none can disagree about
// which files are candidates. This file changes when the resolution rules change.

import fs from "node:fs";
import path from "node:path";
import { presence, type Unchecked } from "../../utils/presence.js";
import {
  installedPlugins,
  listFolders,
  REPO_PLUGIN_DIR,
} from "./plugin-folders.js";
import { checkoutOf, worktreeLink } from "../../utils/git-root.js";
import {
  answerDir,
  gateRepos,
  repoUnreadNotice,
  type RepoAnswers,
  type RepoDir,
  type RepoGate,
  type RepoProject,
  type RepoStanding,
} from "../../config/loader/repo-gate.js";
import type { PluginScope } from "../../config/loader/plugin-scope.js";
import type { LayerRole } from "../../config/layer-role.js";
import { repoConfigs } from "./repo-configs.js";
import { pluginRefsOf } from "../../config/dsl-loader.js";
import { listedPath, STORAGE_FOLDER } from "../../config/loader/plugins.js";
import type {
  ConfigSnapshot,
  Layer,
  LayerContent,
  PluginFile,
  RepoQuestion,
} from "../../config/config-snapshot.js";

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
export type ConfigResolution = {
  readonly repos: RepoGate;
  // The session's project, as the gate judged it: null for none, or one that
  // is not there.
  readonly project: RepoProject | null;
} & (
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
  const project = repoProject(projectDir);
  const repos = gateRepos(answers, [...repoDirs.values()], project);
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
      project,
    };
  }
  // An explicit path is the sole candidate: its one probe is the verdict.
  const [own] = unchecked;
  const home = configFile;
  if (layers.length > 0) {
    return { kind: "chain", layers, home, unchecked, repos, project };
  }
  return own === undefined
    ? { kind: "missing", path: configFile, home, repos, project }
    : { kind: "unreadable", ...own, home, repos, project };
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

// What a session's config search starts from: its project, the directory it
// works in (whose checkout a plugin's data path resolves against), and the
// explicit file its render origin names.
export interface DiscoveryQuery extends ConfigQuery {
  readonly cwd: string;
}

// Where discovery reads: the user's locations, and the state directory whose
// answers book says which repositories' configs run.
export interface DiscoveryWorld {
  readonly locations: Locations;
  readonly stateDir: string;
}

// What one discovery found: the snapshot a renderer is handed, but for what
// the watch over it cannot hear, which only the watch's holder knows; the
// paths a change to any of it is heard at; and the gate it was judged by,
// which `check` reports.
export interface Discovered {
  readonly snapshot: Omit<ConfigSnapshot, "watch">;
  readonly targets: {
    readonly named: readonly string[];
    // Roots watched for every child: a folder created in one is a plugin
    // installed.
    readonly whole: readonly string[];
  };
  readonly gate: RepoGate;
}

/**
 * [LAW:single-enforcer] The one writer of a ConfigSnapshot: everything a
 * config load learns from the filesystem — which files form the chain, their
 * texts, the definitions each lists, the plugin roots' folders, the
 * repository's answer, the checkout — read here, in the host, so the loader
 * opens nothing.
 *
 * [LAW:one-source-of-truth] The chain holds exactly the layers a session may
 * write: the user's (the explicit file, when one is named, replacing the
 * rest) and, once its repository is approved, the project's and its local
 * one — each at the file the chain found, or the file a first write there
 * creates.
 */
export function discover(
  query: DiscoveryQuery,
  { locations: locs, stateDir }: DiscoveryWorld,
): Discovered {
  const resolved = resolveDslConfig(locs, repoConfigs(stateDir).read(), query);
  const gate = resolved.repos;
  const found = resolved.kind === "chain" ? resolved.layers : [];
  const approved = gate.plugins;
  const places: ReadonlyArray<{
    readonly role: LayerRole;
    readonly at: string;
  }> =
    query.configFile === undefined && approved !== null
      ? [
          { role: "user", at: resolved.home },
          { role: "project", at: firstWrite(approved, "project") },
          { role: "local", at: firstWrite(approved, "local") },
        ]
      : [{ role: "user", at: resolved.home }];
  const chain = places.map(({ role, at }): Layer => {
    const file = found.find((l) => l.role === role)?.path;
    return layerAt(role, file ?? at, file !== undefined, locs.home);
  });
  const installed = installedPlugins(locs, approved);
  const plugins = installed.definitions.map((d) =>
    readPluginFile(d.path, d.scope),
  );
  const notices = [
    detectConfigCollisions(locs, query.projectDir),
    configResolutionNotice(resolved),
    repoUnreadNotice(gate),
    ...installed.unchecked.map(
      (u) => `Plugin folder could not be listed: ${u.path} — ${u.error}`,
    ),
  ].filter((n): n is string => n !== null);
  // The project's plugin folder is heard whatever its answer: a plugin
  // dropped there is a question to ask.
  const roots = [
    ...new Set([
      ...installed.roots,
      ...(query.projectDir === undefined
        ? []
        : [path.join(query.projectDir, REPO_PLUGIN_DIR)]),
    ]),
  ];
  const files = [...plugins, ...chain.flatMap((l) => Object.values(l.listed))];
  return {
    snapshot: {
      chain,
      repo: repoQuestion(resolved.project, gate),
      plugins,
      strays: installed.strays,
      checkout: checkoutOf(query.cwd),
      notices,
    },
    targets: {
      named: [
        ...dslConfigCandidatePaths(locs, query),
        ...roots,
        ...files.map((f) => f.path),
        // A plugin's storage folder: its removal or replacement is heard, so
        // the storage owner makes it again.
        ...files.flatMap((f) =>
          f.definition.kind === "text"
            ? [path.join(f.definition.dir, STORAGE_FOLDER)]
            : [],
        ),
      ],
      whole: roots,
    },
    gate,
  };
}

// The file a first write to a repository's layer creates: CONFIG_EXTENSIONS'
// head, the documented format.
function firstWrite(project: string, role: Exclude<LayerRole, "user">): string {
  return `${path.join(project, PROJECT_BASES[role])}.${CONFIG_EXTENSIONS[0]}`;
}

function layerAt(
  role: LayerRole,
  file: string,
  present: boolean,
  home: string,
): Layer {
  const content: LayerContent = present ? readLayer(file) : { kind: "absent" };
  return {
    role,
    path: file,
    content,
    listed:
      content.kind === "text"
        ? Object.fromEntries(
            pluginRefsOf(content.text).map((ref) => [
              ref,
              readPluginFile(listedPath(ref, file, home), scopeOf(role)),
            ]),
          )
        : {},
  };
}

// [LAW:types-are-the-program] A layer stat found and a read then failed is
// `unreadable`: the load fails naming it, never reads it as absent.
function readLayer(file: string): LayerContent {
  try {
    return { kind: "text", text: fs.readFileSync(file, "utf-8") };
  } catch (e) {
    return { kind: "unreadable", error: (e as Error).message };
  }
}

// One definition as the loader takes it: its text and its folder's real
// path, or why either could not be read — the reason its drop gives.
export function readPluginFile(file: string, scope: PluginScope): PluginFile {
  try {
    const text = fs.readFileSync(file, "utf-8");
    return {
      scope,
      path: file,
      definition: {
        kind: "text",
        text,
        dir: fs.realpathSync(path.dirname(file)),
      },
    };
  } catch (e) {
    return {
      scope,
      path: file,
      definition: { kind: "unreadable", error: (e as Error).message },
    };
  }
}

// [LAW:one-source-of-truth] The session's one repository and its answer: its
// project and local layers share its directory, so the gate's lists hold at
// most this one. Null when its directories hold nothing to ask about.
function repoQuestion(
  project: RepoProject | null,
  gate: RepoGate,
): RepoQuestion | null {
  const standing = standingOf(gate);
  return project === null || standing === null
    ? null
    : {
        dir: answerDir(project),
        standing,
        unproven: project.link.kind === "unproven" ? project.link.reason : null,
      };
}

function standingOf(gate: RepoGate): RepoStanding | null {
  if (gate.unread !== null) return "unread";
  if (gate.plugins !== null) return "approved";
  if (gate.awaiting.length > 0) return "awaiting";
  if (gate.declined.length > 0) return "declined";
  return null;
}
