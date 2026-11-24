import path from "node:path";
import type { Host } from "../host";
import { recordHostBundle } from "../daemon/host-bundle";
import { isJsonObject } from "../claude-settings";
import { firstShellWord } from "../shell-word";
import type { JsonValue } from "../var-system/types.js";

// [LAW:one-source-of-truth] What makes a bundle the install is the user's
// statusline setting: it is the install when the setting's command names it.
// The record the host starts from is that fact resolved once, kept where a
// client that finds no host can read it, so this is its one writer, and the
// statusline decides whether it writes. A bundle the setting does not name
// (a worktree built beside the install, a staged copy a customised setting
// ignores) records nothing, so building or staging one never moves the host.

// The bundle a statusline command runs. Every entry flavor locates its bundle
// by adjacency, `<entry>/../dist/index.mjs`, so the entry's own path names it.
// null for a setting that names no absolute entry: unset, another shape, or a
// command this cannot read without a shell.
export function bundleNamedByStatusLine(
  statusLine: JsonValue | undefined,
): string | null {
  const command = isJsonObject(statusLine) ? statusLine.command : undefined;
  const entry = typeof command === "string" ? firstShellWord(command) : null;
  return entry !== null && path.isAbsolute(entry)
    ? path.resolve(path.dirname(entry), "..", "dist", "index.mjs")
    : null;
}

export type Recording =
  | { readonly kind: "recorded"; readonly bundle: string }
  | { readonly kind: "not-the-install"; readonly named: string | null };

export function recordIfInstall(
  bundle: string,
  statusLine: JsonValue | undefined,
  host: Host,
): Recording {
  const named = bundleNamedByStatusLine(statusLine);
  if (named !== bundle) return { kind: "not-the-install", named };
  recordHostBundle(host, bundle);
  return { kind: "recorded", bundle };
}
