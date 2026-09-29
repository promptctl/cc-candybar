// The memento plugin's edge: where the bar finds memento, asks it for the
// context ceiling a session is running under, and moves that ceiling.
//
// [LAW:one-source-of-truth] Memento owns its config grammar and the order its
// layers fold in (its lib/ceiling_config.py), and says so: a second writer of
// that grammar is how a session's gate silently stops — a line memento's
// reader refuses fails its Stop hook, which Claude Code treats as
// non-blocking. So nothing here knows the grammar. The reading is memento's
// own `in_force`, imported from its module; a move is memento's own `ceiling`
// command, which writes atomically, reads the file back through that reader,
// and refuses a layer that changed under it. What the bar holds is only the
// session, the directories memento anchors on, and the words to hand over.
//
// [LAW:effects-at-boundaries] Every effect — the registry read, both spawns —
// lives behind the `MementoEdge` record, so the provider and the verb are
// driven by fakes in tests and by `productionMementoEdge()` in the daemon.

import fs from "node:fs";
import path from "node:path";
import { claudeInstalledPluginsPath } from "../claude-settings.js";
import { launch, launchSync, type LaunchResult } from "../proc/launch.js";
import { ABSENT, failed, ok, type Outcome } from "../utils/outcome.js";

// The session a ceiling belongs to, and the two directories memento's
// `anchored` reads its project layer from — the same pair its Stop hook sees:
// `CLAUDE_PROJECT_DIR` from Claude Code, the working directory as fallback.
export interface CeilingScope {
  readonly sessionId: string;
  readonly projectDir: string;
  readonly cwd: string;
}

export interface CeilingReading {
  // The ceiling in force for the session, in tokens, or "off" when a layer
  // lifted it.
  readonly ceiling: number | "off";
  // The session's own layer as written (`400000`, `off`), or null when the
  // session has none — what a clear would take away.
  readonly session: string | null;
}

// [LAW:types-are-the-program] The two things a click can ask of a session's
// layer. `to` is memento's own value grammar (`+100_000`, `350000`, `off`),
// carried as text and judged only by memento.
export type CeilingMove =
  | { readonly kind: "set"; readonly to: string }
  | { readonly kind: "clear" };

export interface MementoEdge {
  // The installed plugin's root directory for a session in `projectDir`;
  // absent when memento is not installed there.
  readonly locate: (projectDir: string) => Outcome<string>;
  readonly read: (
    root: string,
    scope: CeilingScope,
  ) => Promise<Outcome<CeilingReading>>;
  // Throws with memento's own refusal when the command does not succeed.
  readonly move: (root: string, scope: CeilingScope, move: CeilingMove) => void;
}

const PLUGIN_NAME = "memento";
const CEILING_MODULE = path.join("lib", "ceiling_config.py");
const CEILING_COMMAND = path.join("skills", "ceiling", "bin", "ceiling");

interface PluginInstall {
  readonly scope: string;
  readonly installPath: string;
  readonly projectPath?: string;
}

// [LAW:parse-dont-validate] The registry is Claude Code's file, read as
// untrusted: every install entry either becomes a PluginInstall or the whole
// lookup fails naming the file.
function installsOf(registry: unknown, file: string): PluginInstall[] {
  const plugins =
    registry !== null && typeof registry === "object"
      ? (registry as { plugins?: unknown }).plugins
      : undefined;
  if (plugins === null || typeof plugins !== "object") {
    throw new Error(`${file} has no "plugins" object`);
  }
  return Object.entries(plugins as Record<string, unknown>)
    .filter(([key]) => key.split("@")[0] === PLUGIN_NAME)
    .flatMap(([key, entries]) => {
      if (!Array.isArray(entries)) {
        throw new Error(`${file}: "${key}" is not a list of installs`);
      }
      return entries.map((e: unknown) => {
        const { scope, installPath, projectPath } = (e ?? {}) as Record<
          string,
          unknown
        >;
        if (typeof scope !== "string" || typeof installPath !== "string") {
          throw new Error(`${file}: an install of "${key}" has no scope/path`);
        }
        return typeof projectPath === "string"
          ? { scope, installPath, projectPath }
          : { scope, installPath };
      });
    });
}

// The install in force for a session in `projectDir`: one scoped to that
// project wins over the user-wide one, as Claude Code applies them.
export function locateIn(file: string, projectDir: string): Outcome<string> {
  if (!fs.existsSync(file)) return ABSENT;
  let installs: PluginInstall[];
  try {
    installs = installsOf(JSON.parse(fs.readFileSync(file, "utf8")), file);
  } catch (e) {
    return failed(`memento lookup: ${(e as Error).message}`);
  }
  const install =
    installs.find((i) => i.projectPath === projectDir) ??
    installs.find((i) => i.scope === "user");
  if (install === undefined) return ABSENT;
  const missing = [CEILING_MODULE, CEILING_COMMAND].filter(
    (rel) => !fs.existsSync(path.join(install.installPath, rel)),
  );
  return missing.length === 0
    ? ok(install.installPath)
    : failed(
        `memento at ${install.installPath} has no ${missing.join(" or ")} — upgrade the plugin`,
      );
}

// [LAW:no-ambient-temporal-coupling] The daemon is detached, so its own env
// may carry whichever session's CLAUDE_* vars spawned it; both are replaced
// by the clicked or rendered session's, never inherited.
function mementoEnv(scope: CeilingScope): NodeJS.ProcessEnv {
  const {
    CLAUDE_PROJECT_DIR: _project,
    CLAUDE_CODE_SESSION_ID: _session,
    ...inherited
  } = process.env;
  return {
    ...inherited,
    CLAUDE_CODE_SESSION_ID: scope.sessionId,
    CLAUDE_PROJECT_DIR: scope.projectDir,
  };
}

// Memento's own resolution, asked through its module: the same `in_force` its
// Stop hook gates on, over the same session directory and anchor.
const READ_SCRIPT = `
import json, math, sys
sys.path.insert(0, sys.argv[1])
from ceiling_config import CONFIG_NAME, anchored, ceiling_in, in_force, session_directory
directory = session_directory(sys.argv[2])
ceiling = in_force(directory, anchored(sys.argv[3]))
layer = ceiling_in(directory / CONFIG_NAME)
print(json.dumps({"ceiling": "off" if ceiling == math.inf else ceiling,
                  "session": layer.text if layer else None}))
`;

// Memento's refusals are whole sentences on stderr (`memento config: <file>
// line 3 …`); a launch that never ran says why in `error`.
function refusal(result: Extract<LaunchResult, { ok: false }>): string {
  return (
    result.stderr.trim() ||
    result.error ||
    `${result.reason}${result.exitCode === null ? "" : ` (exit ${result.exitCode})`}`
  );
}

// [LAW:parse-dont-validate] The one crossing from the script's stdout to a
// CeilingReading.
export function parseReading(stdout: string): Outcome<CeilingReading> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return failed(`memento read: not JSON: ${stdout.trim()}`);
  }
  const { ceiling: c, session } = (raw ?? {}) as Record<string, unknown>;
  const ceiling =
    c === "off" || (typeof c === "number" && c >= 0) ? c : undefined;
  return ceiling !== undefined &&
    (session === null || typeof session === "string")
    ? ok({ ceiling, session })
    : failed(`memento read: unexpected answer: ${stdout.trim()}`);
}

async function read(
  root: string,
  scope: CeilingScope,
): Promise<Outcome<CeilingReading>> {
  const result = await launch({
    bin: "python3",
    args: [
      "-c",
      READ_SCRIPT,
      path.join(root, "lib"),
      scope.sessionId,
      scope.cwd,
    ],
    cwd: scope.cwd,
    env: mementoEnv(scope),
    timeoutMs: 3000,
    category: "memento.read",
  });
  return result.ok ? parseReading(result.stdout) : failed(refusal(result));
}

function move(root: string, scope: CeilingScope, m: CeilingMove): void {
  const result = launchSync({
    bin: path.join(root, CEILING_COMMAND),
    args: m.kind === "set" ? ["set", "session", m.to] : ["clear", "session"],
    cwd: scope.cwd,
    env: mementoEnv(scope),
    timeoutMs: 5000,
    category: "memento.move",
  });
  if (!result.ok) throw new Error(refusal(result));
}

export function productionMementoEdge(): MementoEdge {
  const registry = claudeInstalledPluginsPath();
  return {
    locate: (projectDir) => locateIn(registry, projectDir),
    read,
    move,
  };
}
