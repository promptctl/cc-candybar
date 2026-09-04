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

// [LAW:single-enforcer] One implementation of `~`-prefix expansion, called at
// each trust boundary that takes a user-supplied path. The CLI `--config`
// value is expanded in `parseRenderArgs` (server.ts) before it ever reaches
// here; `CC_CANDYBAR_CONFIG` is expanded below where the env var is read.
// One function, one rule, two callers.
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
 * `configFile` is the highest-precedence entry — the path resolved from the
 * client's `--config` flag (already `~`-expanded at the trust boundary in
 * server.ts). When present, it is the sole candidate and the rest of the
 * precedence chain is bypassed.
 *
 * [LAW:single-enforcer] One enumerator; `resolveDslConfigPath` finds the
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
  const explicit = explicitConfigPath(configFile);
  if (explicit !== null) return [explicit];

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

// [LAW:single-enforcer] The one explicit override of the precedence chain:
// the CLI `--config` value (pre-expanded at the trust boundary in server.ts),
// else `CC_CANDYBAR_CONFIG` (a separate trust boundary — expanded here, where
// the env is read, with the shared `expandHome`). `null` means the standard
// chain applies.
function explicitConfigPath(configFile?: string): string | null {
  if (configFile) return configFile;
  const envPath = process.env.CC_CANDYBAR_CONFIG;
  return envPath ? expandHome(envPath) : null;
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
 * The file a DURABLE write lands in (candybar-config-dqe): the config file
 * the session's render resolved, or — when no candidate exists yet — the
 * file a first-ever write creates: the explicit override if one is set,
 * else the XDG `config.json5` at the tail of the same precedence chain.
 *
 * [LAW:one-source-of-truth] Built from the same enumerator and the same
 * override/XDG units the resolver uses, so the file a click writes is the
 * file the next reload reads — by construction, not by two lists agreeing.
 * The `.json5` spelling is CONFIG_EXTENSIONS' head: the documented format,
 * the one that wins a same-location tie.
 */
export function durableConfigPath(
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): string {
  return (
    resolveDslConfigPath(projectDir, cwd, configFile) ??
    explicitConfigPath(configFile) ??
    `${xdgConfigBase()}.${CONFIG_EXTENSIONS[0]}`
  );
}

/**
 * Resolution order for the user's DSL config file:
 *   1. `configFile` (the CLI `--config <path>` value, already `~`-expanded)
 *   2. $CC_CANDYBAR_CONFIG env var (literal path, `~`-expanded here)
 *   3. `<projectDir>/.cc-candybar.json5`
 *   4. `<projectDir>/.cc-candybar.json`
 *   5. `<cwd>/.cc-candybar.json5`
 *   6. `<cwd>/.cc-candybar.json`
 *   7. `$XDG_CONFIG_HOME/cc-candybar/config.json5`
 *      (defaulting to `~/.config/cc-candybar/config.json5`)
 *   8. `$XDG_CONFIG_HOME/cc-candybar/config.json`
 *
 * Returns the first path that exists, or null if none do.
 *
 * [LAW:dataflow-not-control-flow] The locations array is data; the search is
 * `locations.find(fs.existsSync)`. Adding a layer is a new array entry, not a
 * new branch. Extension support is a property of the candidate list, not the
 * search.
 *
 * [LAW:single-enforcer] Built on top of `dslConfigCandidatePaths` — the
 * precedence list lives in one place.
 */
export function resolveDslConfigPath(
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): string | null {
  return (
    dslConfigCandidatePaths(projectDir, cwd, configFile).find(fs.existsSync) ??
    null
  );
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
    if (!fs.existsSync(candidate)) continue;
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
