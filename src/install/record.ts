import fs from "node:fs";
import path from "node:path";
import type { Host } from "../host";
import { recordHostBundle } from "../daemon/host-bundle";
import type { StatusLine } from "../claude-settings-read";
import { firstShellWord } from "../shell-word";

// [LAW:one-source-of-truth] What makes a bundle the install is the user's
// statusline setting: it is the install when the setting runs it. The record
// the host starts from is that fact resolved once, kept where a client that
// finds no host can read it. It has two writers, each recording only on the
// fact it holds: the install records the bundle it staged when it owns the
// statusline command (src/install/index.ts), and a checkout, which stages
// nothing, records itself when the setting names it (`recordIfInstall`). A
// bundle the setting does not run (a worktree built beside the install, a
// staged copy a customised setting ignores) records nothing, so building or
// staging one never moves the host.

// The bundle a statusline command runs. Every entry flavor locates its bundle
// by adjacency, `<entry>/../dist/index.mjs`, to the entry's real location: Node
// resolves a symlinked entry before it imports the bundle beside it, and
// reports the running bundle by its real path, so both are resolved here for a
// symlinked entry or a checkout behind a symlinked directory to equal itself.
// null for a setting that names no absolute entry: unset, no command, or a
// command this cannot read without a shell.
export function bundleNamedByStatusLine(
  statusLine: StatusLine | null,
): string | null {
  const command = statusLine?.command ?? null;
  const entry = command === null ? null : firstShellWord(command);
  if (entry === null || !path.isAbsolute(entry)) return null;
  const named = path.resolve(
    path.dirname(realPathIfThere(entry)),
    "..",
    "dist",
    "index.mjs",
  );
  return realPathIfThere(named);
}

// A file that is not there has no other spelling to resolve: it is a path
// nothing runs, so it equals no running bundle whichever way it is spelled.
function realPathIfThere(file: string): string {
  return fs.existsSync(file) ? fs.realpathSync(file) : file;
}

// A command wrapped in anything a shell runs (`env X=1 <entry>`, `node
// <entry>`, a pipeline) names its entry somewhere past the first word. The
// entry is any file in the bundle's `bin/`, so the command runs the bundle when
// it spells that directory as a path of its own, not as the tail of a longer
// one: `<root>/bin/` is not inside `<root>-other/bin/` or a worktree nested in
// `<root>`.
function commandRunsEntryBeside(
  statusLine: StatusLine | null,
  bundle: string,
): boolean {
  const command = statusLine?.command ?? null;
  if (command === null) return false;
  const bin = `${path.dirname(path.dirname(bundle))}${path.sep}bin${path.sep}`;
  const spelled = new RegExp(
    `(?<![\\w./-])${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  return spelled.test(command);
}

// Whether the user's statusline setting runs `bundle`: its entry is the
// command's first word, or the command spells the bundle's `bin/` directory.
export function statusLineRunsBundle(
  statusLine: StatusLine | null,
  bundle: string,
): boolean {
  return (
    bundleNamedByStatusLine(statusLine) === bundle ||
    commandRunsEntryBeside(statusLine, bundle)
  );
}

export interface Recording {
  readonly kind: "recorded";
  readonly bundle: string;
}

export interface NotTheInstall {
  readonly kind: "not-the-install";
  readonly named: string | null;
}

export function recordIfInstall(
  bundle: string,
  statusLine: StatusLine | null,
  host: Host,
): Recording | NotTheInstall {
  if (!statusLineRunsBundle(statusLine, bundle)) {
    return {
      kind: "not-the-install",
      named: bundleNamedByStatusLine(statusLine),
    };
  }
  recordHostBundle(host, bundle);
  return { kind: "recorded", bundle };
}
