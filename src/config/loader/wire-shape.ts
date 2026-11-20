import type { JsonNode } from "./validate-core.js";

// [LAW:one-source-of-truth] A string a click delivers on the wire, as the
// characters it may not hold. One declaration yields the pattern the loader
// tests, the pattern the schema publishes, and the rule its messages state, so
// an editor never accepts a name the loader refuses.
export interface WireShape {
  readonly pattern: RegExp;
  readonly json: JsonNode;
  readonly rule: string;
}

function wireShape(forbidden: string, rule: string): WireShape {
  const pattern = new RegExp(`^[^${forbidden}]+$`);
  return { pattern, json: { type: "string", pattern: pattern.source }, rule };
}

// The click wire splits a value on "/" and refuses an empty one.
export const WIRE_VALUE = wireShape("/", "non-empty and slash-free");

// A layout op token also splits on ":".
export const LAYOUT_NAME = wireShape("/:", 'non-empty and free of "/" and ":"');

// A value that is also spliced into a template string as display text, where a
// newline would leave the string literal unterminated.
export const DISPLAYED_WIRE_VALUE = wireShape(
  "/\n\r",
  "non-empty, slash-free, and newline-free",
);
