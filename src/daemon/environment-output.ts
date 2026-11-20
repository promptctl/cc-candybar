// [LAW:effects-at-boundaries] Provenance lives with host observations and
// effect outcomes. The marker survives host object spreads and never becomes
// part of renderer input JSON or the replay contract.
const FROM_ENVIRONMENT = Symbol("output derived from a session environment");

export function environmentOutput<T extends object>(
  value: T,
  fromEnvironment: boolean,
): T {
  return fromEnvironment ? { ...value, [FROM_ENVIRONMENT]: true } : value;
}

export function isEnvironmentOutput(value: object): boolean {
  return Object.hasOwn(value, FROM_ENVIRONMENT);
}
