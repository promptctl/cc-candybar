// [LAW:single-enforcer] One candidate-path enumerator feeds the resolver, the watchers and the collision detector.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// [LAW:one-source-of-truth] Order is load-bearing: .json5 wins at a location.
const CONFIG_EXTENSIONS = ["json5", "json"] as const;

// [LAW:types-are-the-program] Only ENOENT is `absent`; every other stat failure is `Unchecked`, never "not found".
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

// [LAW:single-enforcer] The one `~`-expansion; paths reaching here are literal.
// [LAW:enumeration-gap] `~alice/cfg` names a home we cannot resolve, so only bare `~`, `~/…`, `~\…` expand.
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\")
    ? os.homedir() + p.slice(1)
    : p;
}

/**
 * Every candidate, existing or not — watchers listen on all of them so a file
 * created later triggers reload. `configFile` collapses the chain to one entry.
 * [LAW:no-ambient-temporal-coupling] No env is read here: the detached daemon's env answers for the wrong session.
 */
export function dslConfigCandidatePaths(
  projectDir?: string,
  cwd?: string,
  configFile?: string,
): readonly string[] {
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

// [LAW:one-source-of-truth] The extension-less base of the chain's XDG tail.
function xdgConfigBase(): string {
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "cc-candybar", "config");
}

/**
 * [LAW:types-are-the-program] The three arms that render the bundled default
 * are not one fact: `default` is what the user asked for, `missing` and
 * `unreadable` are not. `unchecked` names locations stat could not see past.
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
 * [LAW:dataflow-not-control-flow] One fold over `presence` of the candidates.
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
 * [LAW:one-source-of-truth] Projected from the resolution the render runs, so
 * a click writes the file the next reload reads; with none yet, the XDG `.json5`.
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
 * [LAW:no-silent-failure] The bundled default renders for liveness, but never
 * silently: every row names its path, so none reads as "no override".
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
 * [LAW:single-enforcer] Same enumerator as the resolver, so this cannot
 * disagree about which files are candidates.
 */
export function detectConfigCollisions(
  projectDir?: string,
  cwd?: string,
): string | null {
  const existing = dslConfigCandidatePaths(projectDir, cwd).filter(
    (candidate) => presence(candidate) === "present",
  );
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
  const lines = collisions.map((g) => {
    const [winner, ...shadowed] = g;
    return `${winner} shadows ${shadowed.join(", ")}`;
  });
  return `config-extension collision: ${lines.join("; ")} — remove the duplicate`;
}
