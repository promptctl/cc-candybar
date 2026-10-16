import { explicitConfigPath } from "./utils/user-path";

// The client's explicit-config probe — the `CC_CANDYBAR_CONFIG` the shell
// Claude Code spawned the statusline in carries, read from the client's own
// environment.
//
// [LAW:single-enforcer] Only the statusline CLIENT can observe this: Claude
// Code spawns it with Claude Code's exact environment, while the daemon is
// detached and one-per-user, its env answering for whichever shell spawned it
// (brandon-config-5g8 measured exactly that: an override set on the client
// never reached a daemon that was already running, so a rejected config
// rendered byte-identically to none). So the client reports it as a hint and
// server.ts composes it beneath a load-config pick and `--config` at the
// request boundary — the daemon reads no `CC_CANDYBAR_CONFIG` of its own.
//
// [LAW:one-source-of-truth] The variable name is mirrored by the Rust client
// (rust-client/src/main.rs, CONFIG_ENV) and diffed by scripts/check-protocol.mjs,
// which anchors on the declaration below — keep it a named const holding a
// string literal, or repoint the CHECKS row in the same commit.
export const CONFIG_ENV = "CC_CANDYBAR_CONFIG";

// [LAW:dataflow-not-control-flow] Total over the client's environment: an
// unset or empty variable is the affirmative "no override" — `undefined`, the
// hint left off the wire — never a failure to determine. A set value is made
// absolute HERE, against this client's cwd (brandon-config-nuq6): the daemon
// is detached, so a relative path it resolved would name a file relative to
// whichever shell spawned it, and it records the hint for clicks that carry
// no cwd of their own. So the daemon accepts only an absolute hint, like
// `claudeConfigDir` (src/claude-settings.ts).
export function detectConfigEnv(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string | undefined {
  return explicitConfigPath(cwd, env[CONFIG_ENV]);
}
