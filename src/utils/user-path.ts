// A path a user writes — in an environment variable, a flag, a CLI argument,
// a config file — made into the absolute path it names.

import os from "node:os";
import path from "node:path";

// [LAW:types-are-the-program] Only the shell-standard home-expansion forms trigger
// replacement: bare `~`, `~/...`, or `~\...` on Windows. A string like
// `~alice/cfg` (POSIX named-home lookup) is NOT expanded — we have no way
// to resolve another user's home and a literal substitution would corrupt
// the path (`<homedir>alice/cfg`).
function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\")
    ? os.homedir() + p.slice(1)
    : p;
}

// [LAW:single-enforcer] The one rule for a path a user writes — the
// `CC_CANDYBAR_CONFIG` a client reports, a statusline command's `--config`,
// the `check`/`doctor`/gallery argument, a plugin list entry or data file:
// `~` expanded, then made absolute against `base`, the directory it was
// written relative to. For a path named in a session that is the client's
// cwd, never the detached daemon's (brandon-config-nuq6: a relative override
// resolved against whichever shell spawned the daemon); for one named in a
// file, that file's directory. The Rust client mirrors it for the hint
// (rust-client/src/main.rs, config_env_hint).
export function resolveUserPath(base: string, p: string): string {
  return path.resolve(base, expandHome(p));
}

// [LAW:single-enforcer] An explicit config path, whichever spelling carried
// it — the `CC_CANDYBAR_CONFIG` variable, the `--config` flag, a `check` or
// `doctor` argument: absent or empty is "no override" (`undefined`), never an
// empty path; anything else is the absolute path it names from `base`.
export function explicitConfigPath(
  base: string,
  p: unknown,
): string | undefined {
  return typeof p === "string" && p !== ""
    ? resolveUserPath(base, p)
    : undefined;
}
