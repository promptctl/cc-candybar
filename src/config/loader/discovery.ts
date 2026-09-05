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
// [LAW:enumeration-gap] Only the shell-standard home-expansion forms trigger
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
 * [LAW:single-enforcer] One enumerator; `resolveDslConfig` finds the
 * first that exists, watchers listen on all of them, no second list.
 *
 * [LAW:dataflow-not-control-flow] Location is the dominant precedence axis;
 * extension breaks ties within a location. Encoded as a nested flat-map: each
 * location yields one path per extension in order. No branches on extension.
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
    ...(projectDir
      ? CONFIG_EXTENSIONS.map((ext) =>
          path.join(projectDir, `.cc-candybar.${ext}`),
        )
      : []),
    ...CONFIG_EXTENSIONS.map((ext) =>
      path.join(effectiveCwd, `.cc-candybar.${ext}`),
    ),
    ...CONFIG_EXTENSIONS.map((ext) => `${xdgConfigBase()}.${ext}`),
  ];
}

// [LAW:one-source-of-truth] The extension-less base of the XDG location, the
// tail of the precedence chain: `$XDG_CONFIG_HOME/cc-candybar/config`
// (defaulting to `~/.config/cc-candybar/config`). The candidate enumerator
// appends each accepted extension; `durableConfigPath` appends the
// documented one.
function xdgConfigBase(): string {
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "cc-candybar", "config");
}

/**
 * What the config search found. Four outcomes, and the three that render the
 * bundled default are NOT the same fact:
 *   • `file` — a verified candidate; load it.
 *   • `default` — the precedence chain named no explicit file and none of
 *     its locations exist. The bundled default is what the user asked for.
 *   • `missing` — an explicit file was named (`configFile`) and it is
 *     absent. The bundled default renders so a long-running bar
 *     stays live and the watcher recovers when the file appears — but it is
 *     not what the user asked for, and the render says so.
 *   • `unreadable` — an explicit file was named and stat could not see it
 *     (an unsearchable directory, a symlink loop); the errno rides the arm.
 * `file` and `default` carry `unchecked`: chain locations stat could not see
 * past on the way. A lower, verified candidate still wins — the search never
 * stops on a guess — and the notice names each location it had to skip.
 *
 * [LAW:types-are-the-program] `string | null` collapsed `default` and
 * `missing` into one null, which is how an explicit path to a nonexistent
 * file rendered byte-identically to no config at all (brandon-config-5g8).
 * The path rides on `missing` so the message and the durable-write target
 * both name it without re-deriving it from the inputs.
 */
export type ConfigResolution =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly unchecked: readonly Unchecked[];
    }
  | { readonly kind: "default"; readonly unchecked: readonly Unchecked[] }
  | { readonly kind: "missing"; readonly path: string }
  | {
      readonly kind: "unreadable";
      readonly path: string;
      readonly error: string;
    };

/**
 * Resolution order for the user's DSL config file:
 *   1. `configFile` — the session's explicit path (load-config pick >
 *      `--config` > `configEnv` hint, composed literal in server.ts)
 *   2. `<projectDir>/.cc-candybar.json5`
 *   3. `<projectDir>/.cc-candybar.json`
 *   4. `<cwd>/.cc-candybar.json5`
 *   5. `<cwd>/.cc-candybar.json`
 *   6. `$XDG_CONFIG_HOME/cc-candybar/config.json5`
 *      (defaulting to `~/.config/cc-candybar/config.json5`)
 *   7. `$XDG_CONFIG_HOME/cc-candybar/config.json`
 *
 * [LAW:dataflow-not-control-flow] The locations array is data; the search is
 * one fold over `presence`. Adding a layer is a new array entry, not a new
 * branch. Extension support is a property of the candidate list, not the
 * search.
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
  for (const path of dslConfigCandidatePaths(projectDir, cwd, configFile)) {
    const p = presence(path);
    if (p === "present") return { kind: "file", path, unchecked };
    if (p !== "absent") unchecked.push(p);
  }
  if (configFile === undefined) return { kind: "default", unchecked };
  // An explicit path is the sole candidate: its one probe is the verdict.
  const [own] = unchecked;
  return own === undefined
    ? { kind: "missing", path: configFile }
    : { kind: "unreadable", ...own };
}

/**
 * The file a DURABLE write lands in (candybar-config-dqe): the config file
 * the session's render resolved, or — when no candidate exists yet — the
 * file a first-ever write creates: the explicit path if the client named
 * one, else the XDG `config.json5` at the tail of the same precedence chain.
 *
 * [LAW:one-source-of-truth] A projection of the same resolution the render
 * runs, so the file a click writes is the file the next reload reads — by
 * construction, not by two lists agreeing. `missing` carries its path, so a
 * first write under an explicit override creates exactly the file the bar
 * is waiting for. The `.json5` spelling is CONFIG_EXTENSIONS' head: the
 * documented format, the one that wins a same-location tie.
 */
export function durableConfigPath(
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): string {
  const resolved = resolveDslConfig(projectDir, cwd, configFile);
  return resolved.kind === "default"
    ? `${xdgConfigBase()}.${CONFIG_EXTENSIONS[0]}`
    : resolved.path;
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
    case "file":
    case "default":
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
  const candidates = dslConfigCandidatePaths(projectDir, cwd);
  // [LAW:dataflow-not-control-flow] Dedupe candidates by full path first.
  // When projectDir === cwd (a very common case — the daemon often resolves
  // both from the same hook payload), the enumerator yields the same path
  // at both precedence levels. That is a structural duplicate of *position
  // in the precedence list*, not a same-location duplicate of *files on
  // disk*. The latter is what collision detection is for; the former is
  // noise that would fire a false positive.
  const seen = new Set<string>();
  const uniqueExisting: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (presence(candidate) !== "present") continue;
    uniqueExisting.push(candidate);
  }
  // Group by (dir + base-without-extension). A group with > 1 existing
  // member is a collision at that logical location.
  const groups = new Map<string, string[]>();
  for (const candidate of uniqueExisting) {
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
