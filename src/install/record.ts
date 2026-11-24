import fs from "node:fs";
import path from "node:path";
import type { Host } from "../host";
import { recordHostBundle } from "../daemon/host-bundle";
import { isJsonObject } from "../claude-settings";
import { firstShellWord } from "../shell-word";
import type { JsonValue } from "../var-system/types.js";

// [LAW:one-source-of-truth] What makes a bundle the install is the user's
// statusline setting: it is the install when the setting runs it. The record
// the host starts from is that fact resolved once, kept where a client that
// finds no host can read it. It has two writers, each recording only on the
// fact it holds: the install records the bundle it staged when it owns the
// statusline command (`recordStagedBundle`), and a checkout, which stages
// nothing, records itself when the setting names it (`recordIfInstall`). A
// bundle the setting does not run (a worktree built beside the install, a
// staged copy a customised setting ignores) records nothing, so building or
// staging one never moves the host.
export interface Recording {
  readonly kind: "recorded";
  readonly bundle: string;
}

export function recordStagedBundle(bundle: string, host: Host): Recording {
  recordHostBundle(host, bundle);
  return { kind: "recorded", bundle };
}

// The bundle a statusline command runs. Every entry flavor locates its bundle
// by adjacency, `<entry>/../dist/index.mjs`, so the entry's own path names it.
// Named by its real path, the spelling Node reports for the running bundle, so
// a checkout reached through a symlink still equals itself. null for a setting
// that names no absolute entry: unset, another shape, or a command this cannot
// read without a shell.
export function bundleNamedByStatusLine(
  statusLine: JsonValue | undefined,
): string | null {
  const command = isJsonObject(statusLine) ? statusLine.command : undefined;
  const entry = typeof command === "string" ? firstShellWord(command) : null;
  if (entry === null || !path.isAbsolute(entry)) return null;
  const named = path.resolve(path.dirname(entry), "..", "dist", "index.mjs");
  // A bundle that is not there has no other spelling to resolve: it names a
  // file nothing runs, so it equals no running bundle either way.
  return fs.existsSync(named) ? fs.realpathSync(named) : named;
}

export interface NotTheInstall {
  readonly kind: "not-the-install";
  readonly named: string | null;
}

export function recordIfInstall(
  bundle: string,
  statusLine: JsonValue | undefined,
  host: Host,
): Recording | NotTheInstall {
  const named = bundleNamedByStatusLine(statusLine);
  return named === bundle
    ? recordStagedBundle(bundle, host)
    : { kind: "not-the-install", named };
}
