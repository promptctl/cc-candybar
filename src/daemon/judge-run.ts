// [LAW:single-enforcer] The host's one checkpoint for what a shell or file
// run may ask of the world (spec: docs/design/host-and-renderer.md, section 7).
// A renderer's loader parses a declaration and does not judge it, because a
// renderer outside the host's process is not trusted to have run any check;
// so every run a renderer subscribes to is judged here, as it is declared.

import { isAbsolute } from "node:path";
import type { Run } from "../facts/source-identity.js";

// Shell runs are refused a period shorter than this: a `ttl: 50ms` against a
// 200ms command would overlap and stack children. [LAW:no-mode-explosion] Not
// a config knob.
export const MIN_SHELL_TTL_MS = 500;

declare const ACCEPTED: unique symbol;

// [LAW:parse-dont-validate] A run the judge accepted. Only `judgeRun` builds
// one, and the readers take nothing else, so no run reaches the world
// unjudged.
export type AcceptedRun = Run & { readonly [ACCEPTED]: true };

export type Judged =
  | { readonly kind: "accepted"; readonly run: AcceptedRun }
  | { readonly kind: "refused"; readonly reason: string };

export function judgeRun(run: Run): Judged {
  const reason = refusalOf(run);
  return reason === null
    ? { kind: "accepted", run: run as AcceptedRun }
    : { kind: "refused", reason };
}

// The first rule the run breaks, or `null` when it breaks none.
function refusalOf({ identity: { read, parse, refresh } }: Run): string | null {
  return (
    (read.kind === "file" ? absolute("file.path", read.path) : null) ??
    (refresh.kind === "watch_file"
      ? absolute("cache.watch_file", refresh.path)
      : null) ??
    (parse.kind === "regex" ? capturing(parse.pattern) : null) ??
    (read.kind === "shell" &&
    refresh.kind === "ttl" &&
    refresh.durationMs < MIN_SHELL_TTL_MS
      ? `a shell source's cache.ttl must be at least ${MIN_SHELL_TTL_MS}ms, got ${refresh.durationMs}ms`
      : null)
  );
}

// A shell run runs in its session's directory while the host's own cwd is
// whichever shell spawned it, so a relative path has no single directory to
// mean, and it is refused rather than resolved against either. `~` is a
// relative path to the OS, so the same test refuses it.
function absolute(where: string, path: string): string | null {
  return isAbsolute(path)
    ? null
    : `${where} must be an absolute path (\`~\` and relative paths are not expanded), got ${JSON.stringify(path)}`;
}

// A pattern the reader can compile, with the group 1 it reads the value from.
// The compile proof is the pattern alone (`(a)\` does not compile, `(a)\|`
// does: the backslash would escape the alternation). Then the group count:
// the pattern alternated with the empty pattern always matches, and every
// group is a (non-participating) slot.
function capturing(pattern: string): string | null {
  let groups: number;
  try {
    new RegExp(pattern);
    groups = new RegExp(`${pattern}|`).exec("")!.length - 1;
  } catch (e) {
    return `parse.regex is not a valid regular expression: ${(e as Error).message}`;
  }
  return groups > 0
    ? null
    : `parse.regex must contain a capture group — its group 1 is the value; got ${JSON.stringify(pattern)}`;
}
