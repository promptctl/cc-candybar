// [LAW:one-source-of-truth] Config row and group addresses, setting fields
// and environment names share this ASCII identifier grammar.
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

declare const identifier: unique symbol;
type Identifier = string & { readonly [identifier]: true };

export function isIdentifier(value: unknown): value is Identifier {
  return typeof value === "string" && IDENTIFIER.test(value);
}
