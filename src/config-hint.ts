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
// rendered byte-identically to none). So the client reports it as a hint,
// `requestedConfigTarget` composes it beneath `--config`, and a load-config
// pick joins over both in `sessionRenderOrigin` — the daemon reads no
// `CC_CANDYBAR_CONFIG` of its own.
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

// [LAW:types-are-the-program] The config a request names, and what named it:
// the file a command's arguments name, else the file its environment names,
// else the search. A search has no path, so no reader can hold a source that
// disagrees with one.
export type RequestedTarget =
  | { readonly source: "search"; readonly path?: undefined }
  | { readonly source: "argument" | "environment"; readonly path: string };

// What a session's config turned out to be: a request's target, a load-config
// pick over it, or a recorded path whose source this build cannot read.
export type ConfigTarget =
  | RequestedTarget
  | { readonly source: "pick" | "unknown"; readonly path: string };

// [LAW:single-enforcer] The one precedence of the two spellings a request
// carries, for a render and a CLI run alike, so the bar and a CLI cannot rank
// them differently. Each spelling arrives already read: absolute, and absent
// when empty.
export function requestedConfigTarget(
  argument: string | undefined,
  environment: string | undefined,
): RequestedTarget {
  if (argument !== undefined) return { source: "argument", path: argument };
  if (environment !== undefined) {
    return { source: "environment", path: environment };
  }
  return { source: "search" };
}

// The config a CLI run (`check`, `doctor`) judges, for the bar a session
// started in this shell renders: the file named on the command line — a
// statusline command's own `--config` — else the override the client would
// report. An empty argument is no argument, as `--config "$CFG"` with CFG
// unset is to the bar, because the argument and the variable cross the one
// `explicitConfigPath` reading.
export function cliConfigTarget(
  arg: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): RequestedTarget {
  return requestedConfigTarget(
    explicitConfigPath(cwd, arg),
    detectConfigEnv(env, cwd),
  );
}

// [LAW:types-are-the-program] What config resolution takes: where a session
// runs and what names its config. Recorded for a session, this is what a
// durable click resolves, so the file it lands in is the one the next reload
// reads, never a snapshot of the one the last render read.
export interface RenderOrigin {
  readonly projectDir: string;
  readonly cwd: string;
  readonly target: ConfigTarget;
}

// The origin a request names, before the session's load-config pick joins it.
// Only this is ever recorded: a pick is a session fact of its own.
export interface RequestedOrigin extends RenderOrigin {
  readonly target: RequestedTarget;
}

// [LAW:one-source-of-truth] How a chain of config files reads to a person,
// lowest precedence first, for `check` and the doctor alike. An empty chain
// says nothing loaded, not that nothing was found: a repository's config that
// awaits its approval is left out of the chain.
export function chainName(
  paths: readonly string[],
  none = "bundled default (no config file loaded)",
): string {
  return paths.join(" < ") || none;
}
