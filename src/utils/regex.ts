// A literal text as a regex source that matches exactly it.
export function escapeRegExp(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
