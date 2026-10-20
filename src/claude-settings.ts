import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSON_DIALECT } from "./config/json5-edit.js";
import { readTailSync } from "./utils/transcript-fs.js";

// [LAW:one-source-of-truth] The variable that moves Claude Code's
// configuration directory. Mirrored by the Rust client
// (rust-client/src/main.rs, CLAUDE_CONFIG_DIR_ENV) and diffed by
// scripts/check-protocol.mjs, which anchors on the declaration below — keep it
// a named const holding a string literal, or repoint the CHECKS row in the
// same commit.
export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

// [LAW:single-enforcer] Only the statusline CLIENT can observe this: Claude
// Code spawns it with Claude Code's exact environment and working directory,
// while the daemon is detached and one-per-user, its env and cwd answering for
// whichever session spawned it. So the client resolves the directory — the
// variable's first entry, made absolute against the client's own cwd — and
// reports it
// as the `claudeConfigDir` hint, exactly the move `configEnv` made
// (brandon-config-5g8). Mirrored by the Rust client
// (detect_claude_config_dir). Total over the environment: unset or empty is
// `undefined`, the default directory.
export function detectClaudeConfigDir(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string | undefined {
  const first = (env[CLAUDE_CONFIG_DIR_ENV] ?? "").split(",")[0]!.trim();
  return first === "" ? undefined : path.resolve(cwd, first);
}

// Claude Code's configuration directory: the one a client detected, else the
// default, ~/.claude.
export function claudeConfigDir(detected: string | undefined): string {
  return detected ?? path.join(os.homedir(), ".claude");
}

// [LAW:one-source-of-truth] THE location of Claude Code's user settings file
// in a configuration directory. Two writers touch it, both splicing through
// one editor so neither drops the other's keys — `cc-candybar install` (the
// statusLine command) and the doctor's claude-settings fixes (`env`; and
// `statusLine.refreshInterval` when this file is where the statusLine comes
// from, `readSettingsChain`) — and one more reader, the auto-compact window the bar
// shows (src/segments/autocompact.ts), which Claude Code's own `/autocompact`
// writes here. They must all mean the file Claude Code reads, so the path is
// spelled once and imported by each.
export function claudeSettingsPath(configDir: string): string {
  return path.join(configDir, "settings.json");
}

// Claude Code's record of the plugins installed for this user — where each
// one's files live, at which scope. Read to find the memento plugin
// (src/memento/edge.ts), whose context ceiling the bar shows and moves.
export function claudeInstalledPluginsPath(configDir: string): string {
  return path.join(configDir, "plugins", "installed_plugins.json");
}

// A settings file's bytes and the file they came from, or null for no file.
// [LAW:no-silent-failure] Only a missing file is absence: one the daemon
// cannot read (EACCES, ELOOP, a FIFO) is a file Claude Code may still run
// with, so it throws rather than vanishing from the chain.
function readSettingsFile(
  settingsPath: string,
): { text: string; file: string } | null {
  const read = readTailSync(settingsPath, Number.MAX_SAFE_INTEGER);
  switch (read.kind) {
    case "absent":
      return null;
    case "failed":
      throw new Error(`cannot read ${settingsPath}: ${read.reason}`);
    case "ok":
      return { text: read.value.buf.toString("utf8"), file: read.value.file };
  }
}

const cannotRead = (settingsPath: string, e: unknown): Error =>
  new Error(`cannot read ${settingsPath}: ${messageOf(e)}`, { cause: e });

// The settings file's bytes, for an editor that splices it. A missing file is
// the one absence with a meaning — Claude Code has written nothing yet — so it
// reads as the empty document.
export function readClaudeSettingsText(settingsPath: string): string {
  return readSettingsFile(settingsPath)?.text ?? "";
}

// [LAW:one-source-of-truth] The ONE reading of Claude Code's settings as a
// document, shared by every reader of its fields (the doctor's `env`, the
// auto-compact window), so no two of them disagree about what a file means.
// Empty text — a missing file or a blank one — is the empty document; text
// that does not parse, or parses to anything but an object, throws naming the
// file ([LAW:no-silent-failure]: Claude Code is not running with whatever a
// guess would say).
export function readClaudeSettings(
  settingsPath: string,
): Readonly<Record<string, unknown>> {
  return parseSettings(settingsPath, readClaudeSettingsText(settingsPath));
}

function parseSettings(
  settingsPath: string,
  text: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    if (/^\s*$/.test(text)) return {};
    parsed = JSON_DIALECT.parse(text);
  } catch (e) {
    throw cannotRead(settingsPath, e);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`cannot read ${settingsPath}: not a JSON object`);
  }
  return parsed;
}

// Where an administrator's managed settings live (code.claude.com/docs/en/
// managed-settings) — fixed system paths, which CLAUDE_CONFIG_DIR does not
// move.
export function claudeManagedSettingsDir(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode";
    case "win32":
      return "C:\\Program Files\\ClaudeCode";
    default:
      return "/etc/claude-code";
  }
}

// The scopes of Claude Code's settings files, highest precedence first.
// `--settings`, MDM policy and server-managed settings are scopes too, but
// none is a file this machine can read, so none is one of these.
export type SettingsScope = "managed" | "project-local" | "project" | "user";

// Where a session's settings chain is read: the managed directory, the
// session's primary working directory (Claude Code reads both project files
// there), and its user settings file.
export interface SettingsChainAt {
  readonly managedDir: string;
  readonly projectDir: string;
  readonly userFile: string;
}

export interface SettingsSource {
  readonly scope: SettingsScope;
  readonly path: string;
  readonly settings: Readonly<Record<string, unknown>>;
  // The file's `env`, read as Claude Code merges it: an object, `{}` when
  // the file sets none.
  readonly env: Readonly<Record<string, unknown>>;
}

// [LAW:one-source-of-truth] THE order Claude Code reads its settings files
// in, as one list every key's reading folds over — highest precedence first,
// so "the highest level that sets it" is the first source that does. Within
// the managed scope, `managed-settings.json` merges first and then every
// visible `*.json` in `managed-settings.d/` in alphabetical order, each
// later file over the earlier: highest-first is that order reversed. A file
// that does not exist is not a source; one that does not read throws naming
// it, as `readClaudeSettings` does, and so does an `env` that is not an object
// (Claude Code merges `env` key by key, so a non-object `env` is no env it
// can run with).
export function readSettingsChain(
  at: SettingsChainAt,
): readonly SettingsSource[] {
  const dropIns = path.join(at.managedDir, "managed-settings.d");
  const located: ReadonlyArray<{ scope: SettingsScope; path: string }> = [
    ...visibleJsonFiles(dropIns)
      .reverse()
      .map((name) => ({
        scope: "managed" as const,
        path: path.join(dropIns, name),
      })),
    {
      scope: "managed",
      path: path.join(at.managedDir, "managed-settings.json"),
    },
    {
      scope: "project-local",
      path: path.join(at.projectDir, ".claude", "settings.local.json"),
    },
    {
      scope: "project",
      path: path.join(at.projectDir, ".claude", "settings.json"),
    },
    { scope: "user", path: at.userFile },
  ];
  const read = located.flatMap((l) => {
    const file = readSettingsFile(l.path);
    if (file === null) return [];
    const settings = parseSettings(l.path, file.text);
    const { env = {} } = settings;
    if (!isJsonObject(env)) {
      throw new Error(`cannot read ${l.path}: \`env\` is not an object`);
    }
    return [{ source: { ...l, settings, env }, file: file.file }];
  });
  // [LAW:one-source-of-truth] A file has one scope. A project whose
  // `.claude` is the user's config directory (a session in the home
  // directory, or a CLAUDE_CONFIG_DIR naming the project's `.claude`) names
  // the user file as its project file too. The doctor keeps it once, as the
  // user's own, the scope it may write; its position is the same either way,
  // since no scope ranks between project and user. The file is the one the
  // read opened, so a symlinked spelling of one path is the same file.
  const user = read.find((r) => r.source.scope === "user");
  return read
    .filter((r) => r.source.scope !== "project" || r.file !== user?.file)
    .map((r) => r.source);
}

// A directory's `*.json` entries that are not hidden, in alphabetical order;
// a directory that does not exist has none.
function visibleJsonFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith(".") && name.endsWith(".json"))
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cannotRead(dir, e);
  }
}

// A JSON object — the shape the document and each of its sections (`env`,
// `statusLine`) must have for a key to be read or spliced inside it.
export const isJsonObject = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
