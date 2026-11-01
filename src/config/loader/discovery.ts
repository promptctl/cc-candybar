// [LAW:single-enforcer] Config-file discovery: where the DSL config can live, in
// what precedence. One candidate-path enumerator feeds the
// resolver, the watchers, and the collision detector so none can disagree about
// which files are candidates. This file changes when the resolution rules change.

import fs from "node:fs";
import os from "node:os";
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

// [LAW:one-source-of-truth] The set of accepted extensions lives here once.
// Both .json5 and .json are accepted: JSON ⊂ JSON5, so the same parser
// (JSON5.parse) handles both — only the filename lookup varies. Ordering is
// load-bearing: .json5 wins over .json at the same location (documented
// format > compatibility tail).
const CONFIG_EXTENSIONS = ["json5", "json"] as const;

/**
 * The full ordered list of candidate paths the DSL config could live at,
 * for a given (projectDir, cwd). Returned regardless of which exist — the
 * cache uses this to watch every candidate location so the creation of any
 * file in the resolution chain triggers hot-reload.
 *
 * `configFile` is the highest-precedence entry — the explicit path
 * a session's render origin names (load-config pick > `--config` >
 * `configEnv` hint, absolute). When present, it is the
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
 *
 * Each path appears ONCE: when projectDir and cwd are the same directory (the
 * common case — the daemon often resolves both from one hook payload) the
 * project and cwd rungs spell identical strings, and a second occurrence is
 * a duplicate of *position in the chain*, not of a file on disk. Deduped
 * here so no consumer probes, watches, or reports one location twice.
 */
export function dslConfigCandidatePaths(
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): readonly string[] {
  // [LAW:dataflow-not-control-flow] An explicit override is the ONLY
  // candidate — the precedence chain collapses to one entry.
  if (configFile !== undefined) return [configFile];

  const effectiveCwd = cwd ?? process.cwd();

  return [
    ...new Set([
      ...(projectDir
        ? CONFIG_EXTENSIONS.map((ext) =>
            path.join(projectDir, `${REPO_CONFIG_BASE}.${ext}`),
          )
        : []),
      ...CONFIG_EXTENSIONS.map((ext) =>
        path.join(effectiveCwd, `${REPO_CONFIG_BASE}.${ext}`),
      ),
      ...CONFIG_EXTENSIONS.map((ext) => `${xdgConfigBase()}.${ext}`),
    ]),
  ];
}

// [LAW:one-source-of-truth] The base name a repository's own config file
// carries, at a project or working directory.
const REPO_CONFIG_BASE = ".cc-candybar";

// [LAW:one-source-of-truth] The extension-less base of the XDG location, the
// tail of the precedence chain: `$XDG_CONFIG_HOME/cc-candybar/config`
// (defaulting to `~/.config/cc-candybar/config`). The candidate enumerator
// appends each accepted extension; `userHome` appends the documented one.
function xdgConfigBase(): string {
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "cc-candybar", "config");
}

/**
 * One chain layer: its file, and whose plugins the file lists — a
 * repository's (`repo`) or the user's installed ones (`plugins`).
 *
 * [LAW:one-source-of-truth] The scope is decided where the search finds the
 * file, from which location supplied it, and rides with the path. A second
 * list of repository paths beside the layers drifts the moment a caller
 * builds or filters one list and not the other, and a repository's plugin
 * then replaces the installed one of the same name.
 */
export interface ConfigLayer {
  readonly path: string;
  readonly scope: PluginScope;
}

// The user's own file or an explicit one: never a repository's, whatever its
// name. The one way to state a layer outside the search.
export function homeLayer(path: string): ConfigLayer {
  return { path, scope: "plugins" };
}

/**
 * What the config search found. Three outcomes:
 *   • `chain` — the files the config is merged from, lowest precedence
 *     first: the user's XDG file, then `<cwd>`'s, then `<projectDir>`'s, each
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
 * Every arm carries `home`: the one file a durable click writes
 * (`durableConfig`). `chain` carries `unchecked`: locations stat could not
 * see past; the search never stops on a guess, and the notice names each.
 *
 * Every arm carries `repos`: what the session's repositories contribute,
 * as their answers decide it. A cwd or project layer whose directory is not
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
 *   1. `configFile` — the session's explicit path (load-config pick >
 *      `--config` > `configEnv` hint, absolute, from its render origin); the
 *      sole candidate when present
 *   2. `<projectDir>/.cc-candybar.json5`, then `.json`
 *   3. `<cwd>/.cc-candybar.json5`, then `.json`
 *   4. `$XDG_CONFIG_HOME/cc-candybar/config.json5`, then `.json`
 *      (defaulting to `~/.config/cc-candybar/`)
 * Each LOCATION contributes its first existing file (`.json5` wins a tie;
 * the sibling is the collision notice), and the chain is those files in
 * reverse — the user's at the bottom, the project's on top. A location is
 * its directory as the filesystem resolves it, so a project directory and a
 * cwd that spell one directory two ways (a symlinked checkout, macOS's
 * `/tmp`) contribute one layer, never a file over itself.
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
  answers: RepoAnswers,
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): ConfigResolution {
  const unchecked: Unchecked[] = [];
  // Each location's file, and the repository directory that supplies it —
  // null for the user's own file or the explicit one.
  const atLocation = new Map<
    string,
    { readonly file: string; readonly repo: RepoDir | null }
  >();
  for (const candidate of dslConfigCandidatePaths(
    projectDir,
    cwd,
    configFile,
  )) {
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
        repo:
          configFile !== undefined || isUserFile(candidate)
            ? null
            : { dir, link: worktreeLink(dir) },
      });
    }
  }
  const found = [...atLocation.values()];
  const repos = gateRepos(
    answers,
    found.flatMap((f) => (f.repo === null ? [] : [f.repo])),
    repoProject(projectDir),
  );
  const kept = found
    .filter((f) => f.repo === null || repos.approved.includes(f.repo.dir))
    .reverse();
  const layers = kept.map(
    (f): ConfigLayer => ({
      path: f.file,
      scope: f.repo === null ? "plugins" : "repo",
    }),
  );
  if (configFile === undefined) {
    return {
      kind: "chain",
      layers,
      home: userHome(layers),
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
function isUserFile(candidate: string): boolean {
  return CONFIG_EXTENSIONS.some((e) => candidate === `${xdgConfigBase()}.${e}`);
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
function userHome(layers: readonly ConfigLayer[]): string {
  return (
    layers.find((l) => isUserFile(l.path))?.path ??
    `${xdgConfigBase()}.${CONFIG_EXTENSIONS[0]}`
  );
}

/**
 * The file a DURABLE write lands in, and the layers above it.
 *
 * The home is the user's own file (or the session's explicit one), never a
 * project's: a project file is checked into somebody's repository, and a
 * theme picked from the bar is the user's taste, not the project's. A value
 * a layer ABOVE the home holds wins over anything the home says, so a write
 * the home takes but the chain hides is refused by the writer, naming the
 * layer that holds it (`config-file-store`'s commit) — never a click that
 * silently does nothing.
 *
 * [LAW:one-source-of-truth] A projection of the same resolution the render
 * runs, so the file a click writes is a layer the next reload reads — by
 * construction, not by two lists agreeing.
 */
export interface ConfigHome {
  readonly path: string;
  // The chain's layers over `path`, lowest first. The home is the chain's
  // bottom, so a layer is either the home or above it.
  readonly above: readonly ConfigLayer[];
  // The approved project whose plugins the chain loads, and the working
  // directory their checkout data paths resolve against.
  readonly repo: ApprovedRepo | null;
  readonly cwd: string | null;
}

export function durableConfig(
  answers: RepoAnswers,
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): ConfigHome {
  const resolved = resolveDslConfig(answers, projectDir, cwd, configFile);
  const layers = resolved.kind === "chain" ? resolved.layers : [];
  return {
    path: resolved.home,
    above: layers.filter((l) => l.path !== resolved.home),
    repo: resolved.repos.plugins,
    cwd: cwd ?? null,
  };
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
  projectDir?: string,
  cwd?: string,
): string | null {
  // The enumerator yields each path once, so an existing member here is a
  // file on disk, never the same candidate seen from two chain positions.
  const existing = dslConfigCandidatePaths(projectDir, cwd).filter(
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
