// [LAW:single-enforcer] Only the CLIENT can observe this: it inherits Claude Code's
// env, while the detached daemon's answers for whichever shell spawned it.
// [LAW:one-source-of-truth] check-protocol anchors here: keep it a named const.
export const CONFIG_ENV = "CC_CANDYBAR_CONFIG";

// [LAW:dataflow-not-control-flow] Unset or empty is the affirmative "no override".
export function detectConfigEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env[CONFIG_ENV] ?? "";
  return value === "" ? undefined : value;
}
