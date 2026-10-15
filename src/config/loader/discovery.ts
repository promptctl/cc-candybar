// [LAW:single-enforcer] Config-file discovery: where the DSL config can live, in
// what precedence, and how `~` expands. One candidate-path enumerator feeds the
// resolver, the watchers, and the collision detector so none can disagree about
// which files are candidates. This file changes when the resolution rules change.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// [LAW:one-source-of-truth] The set of accepted extensions lives here once.
// Both .json5 and .json are accepted: JSON ⊂ JSON5, so the same parser
// (JSON5.parse) handles both — only the filename lookup varies. Ordering is
// load-bearing: .json5 wins over .json at the same location (documented
// format > compatibility tail).
const CONFIG_EXTENSIONS = ["json5", "json"] as const;

// [LAW:types-are-the-program] One stat, carried as the fact it found rather
// than collapsed to a boolean: `fs.existsSync` answers false to EVERY stat
// failure, so a file behind an unsearchable directory resolved as "not found"
// — a permissions problem reported as a wrong path. Only ENOENT is `absent`;
// any other failure is an `Unchecked` location stat could not see past, which
// the resolution carries as data — no consumer guesses whether a file is there.
export interface Unchecked {
  readonly path: string;
  readonly error: string;
}
type Presence = "present" | "absent" | Unchecked;
function presence(path: string): Presence {
  try {
    return fs.statSync(path, { throwIfNoEntry: false }) === undefined
      ? "absent"
      : "present";
  } catch (e) {
    return { path, error: (e as Error).message };
  }
}

// [LAW:single-enforcer] One implementation of `~`-prefix expansion, called at
// each trust boundary that takes a user-supplied path: `sanitizeConfigPath`
// (src/daemon/protocol.ts — both the `--config` flag and the client's
// `CC_CANDYBAR_CONFIG` hint) and the `check` CLI's target. Every path that
// reaches this module is already literal.
//
// [LAW:types-are-the-program] Only the shell-standard home-expansion forms trigger
// replacement: bare `~`, `~/...`, or `~\...` on Windows. A string like
// `~alice/cfg` (POSIX named-home lookup) is NOT expanded — we have no way
// to resolve another user's home and a literal substitution would corrupt
// the path (`<homedir>alice/cfg`).
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\")
    ? os.homedir() + p.slice(1)
    : p;
}

/**
 * The full ordered list of candidate paths the DSL config could live at,
 * for a given (projectDir, cwd). Returned regardless of which exist — the
 * cache uses this to watch every candidate location so the creation of any
 * file in the resolution chain triggers hot-reload.
 *
 * `configFile` is the highest-precedence entry — the explicit path
 * server.ts composed for the session (load-config pick > `--config` >
 * `configEnv` hint, already literal). When present, it is the
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
            path.join(projectDir, `.cc-candybar.${ext}`),
          )
        : []),
      ...CONFIG_EXTENSIONS.map((ext) =>
        path.join(effectiveCwd, `.cc-candybar.${ext}`),
      ),
      ...CONFIG_EXTENSIONS.map((ext) => `${xdgConfigBase()}.${ext}`),
    ]),
  ];
}

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
 * [LAW:types-are-the-program] `string | null` collapsed `default` and
 * `missing` into one null, which is how an explicit path to a nonexistent
 * file rendered byte-identically to no config at all (brandon-config-5g8).
 * The path rides on `missing` so the message and the durable-write target
 * both name it without re-deriving it from the inputs.
 */
export type ConfigResolution =
  | {
      readonly kind: "chain";
      readonly layers: readonly string[];
      readonly home: string;
      readonly unchecked: readonly Unchecked[];
    }
  | { readonly kind: "missing"; readonly path: string; readonly home: string }
  | {
      readonly kind: "unreadable";
      readonly path: string;
      readonly home: string;
      readonly error: string;
    };

/**
 * The search, over the locations of `dslConfigCandidatePaths`:
 *   1. `configFile` — the session's explicit path (load-config pick >
 *      `--config` > `configEnv` hint, composed literal in server.ts); the
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
 * precedence list lives in one place.
 */
export function resolveDslConfig(
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): ConfigResolution {
  const unchecked: Unchecked[] = [];
  const atLocation = new Map<string, string>();
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
    const location = path.join(
      fs.realpathSync(path.dirname(candidate)),
      path.basename(candidate).replace(/\.(json5|json)$/, ""),
    );
    if (!atLocation.has(location)) atLocation.set(location, candidate);
  }
  const layers = [...atLocation.values()].reverse();
  if (configFile === undefined) {
    return { kind: "chain", layers, home: userHome(layers), unchecked };
  }
  // An explicit path is the sole candidate: its one probe is the verdict.
  const [own] = unchecked;
  const home = configFile;
  if (layers.length > 0) return { kind: "chain", layers, home, unchecked };
  return own === undefined
    ? { kind: "missing", path: configFile, home }
    : { kind: "unreadable", ...own, home };
}

// The user's file: the XDG layer when the chain holds one, else the file a
// first-ever write creates there — CONFIG_EXTENSIONS' head, the documented
// format, the one that wins a same-location tie.
function userHome(layers: readonly string[]): string {
  const base = xdgConfigBase();
  return (
    layers.find((l) => CONFIG_EXTENSIONS.some((e) => l === `${base}.${e}`)) ??
    `${base}.${CONFIG_EXTENSIONS[0]}`
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
  readonly above: readonly string[];
  // The session's project the chain loads for (its installed plugins).
  readonly projectDir: string | null;
}

export function durableConfig(
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): ConfigHome {
  const resolved = resolveDslConfig(projectDir, cwd, configFile);
  const layers = resolved.kind === "chain" ? resolved.layers : [];
  return {
    path: resolved.home,
    above: layers.filter((l) => l !== resolved.home),
    projectDir: projectDir ?? null,
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
