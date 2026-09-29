// [LAW:single-enforcer] Go has no optional parameter, so an optional tail is
// declared as a variadic slot and the engine's arity gate owns only the minimum.
// The maximum is this one refusal, shared by every func with an optional tail,
// so each states only which optional arguments it takes.
export function refuseSurplus(
  call: string,
  optional: readonly string[],
  surplus: readonly unknown[],
): void {
  if (surplus.length === 0) return;
  throw new Error(
    `${call}: takes at most ${optional.length} optional argument${optional.length === 1 ? "" : "s"} (${optional.join(", ")}), got ${optional.length + surplus.length}`,
  );
}
