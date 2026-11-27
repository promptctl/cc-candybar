// [LAW:one-source-of-truth] The key that a lowered "using" statement reads.
// Esbuild uses the registry key on engines without the well-known symbol.
export const disposeSymbol: typeof Symbol.dispose =
  Symbol.dispose ?? (Symbol.for("Symbol.dispose") as typeof Symbol.dispose);
