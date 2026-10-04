// The client's memento probe — the variables that move where the memento
// plugin keeps its ceiling layers, read from the client's own environment.
//
// [LAW:single-enforcer] Only the statusline CLIENT can observe this: Claude
// Code spawns it with Claude Code's exact environment — the one memento's Stop
// hook runs in — while the daemon is detached and one-per-user, its env
// answering for whichever shell spawned it. So the client reports the
// variables as the `mementoEnv` hint and the daemon hands them to memento's
// reader and `ceiling` command in place of its own (src/memento/edge.ts).
//
// [LAW:one-source-of-truth] Memento owns the rule that folds these into its
// config home (its lib/ceiling_config.py), so they cross RAW, by name; nothing
// here resolves a directory from them. The names are mirrored by the Rust
// client (rust-client/src/main.rs, MEMENTO_ENV_VARS) and diffed by
// scripts/check-protocol.mjs, which anchors on the declaration below.
import path from "node:path";

export const MEMENTO_ENV_VARS = [
  "MEMENTO_CONFIG_HOME",
  "XDG_CONFIG_HOME",
] as const;

export type MementoEnvVar = (typeof MEMENTO_ENV_VARS)[number];

// Each variable the client's environment sets, as an absolute path; a name
// left out is one that environment does not set.
export type MementoEnvHint = Readonly<Partial<Record<MementoEnvVar, string>>>;

// [LAW:dataflow-not-control-flow] Total over the client's environment: an
// unset or empty variable is left out (memento reads both the same way), and
// the hint is always an object, so its absence on the wire means only "client
// too old to report". A relative value is made absolute against the client's
// cwd — where memento's own hook would resolve it — since the daemon's spawn
// stands somewhere else. Mirrored by the Rust client (memento_env_hint).
export function detectMementoEnv(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): MementoEnvHint {
  return Object.fromEntries(
    MEMENTO_ENV_VARS.flatMap((name) => {
      const value = env[name] ?? "";
      return value === "" ? [] : [[name, path.resolve(cwd, value)]];
    }),
  );
}
