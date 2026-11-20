// [LAW:one-source-of-truth] Config row and group addresses, setting fields
// and environment names share this ASCII identifier grammar.
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}
