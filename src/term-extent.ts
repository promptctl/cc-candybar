// [LAW:one-type-per-behavior] Columns and rows are one fact on two axes; `undefined` is honest, never a guessed size.
// [LAW:one-source-of-truth] The env value is accepted exactly when the Rust client's
// `str::parse::<u32>` accepts it, so both runtimes agree or neither reads.
export function detectTermExtent(
  envValue: string | undefined,
  ttyExtent: number | undefined,
): number | undefined {
  if (envValue !== undefined && /^\+?\d+$/.test(envValue)) {
    const n = Number(envValue);
    if (n > 0 && n <= 0xffff_ffff) return n;
  }
  if (ttyExtent && ttyExtent > 0) return ttyExtent;
  return undefined;
}
