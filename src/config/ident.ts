// [LAW:one-source-of-truth] THE identifier-collapse rule: every non-alphanumeric run
// becomes one `_`. [LAW:no-silent-failure] Several sites derive synthesized identities
// from it; a second copy would let a collision guard stop matching the collision rule.
export function ident(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_");
}
