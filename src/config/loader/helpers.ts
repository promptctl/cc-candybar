// [LAW:types-are-the-program] The helpers schema is the simplest possible: a
// record of name → template-body STRING. Each value is a Go-template source the
// renderer compiles into a `{{ define }}` block; whether the body PARSES (and
// whether a `{{ template "name" }}` reference resolves) is a render-time concern
// (registerDslConfig parses the preamble and throws a per-helper diagnostic).
// This file changes only if the helper authoring shape changes.

import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  type ValidateCtx,
} from "./validate-core.js";

// [LAW:single-enforcer] Structural validation of the `helpers` block: an object
// whose every value is a string template body. Null-prototype record so a helper
// named "__proto__"/"constructor" is an ordinary own property, matching actions.
export function validateHelpers(
  ctx: ValidateCtx,
  raw: unknown,
): Record<string, string> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "helpers",
      message: `helpers must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["helpers"]),
    });
    return {};
  }
  const out: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, body] of Object.entries(raw)) {
    if (typeof body !== "string") {
      ctx.issues.push({
        path: `helpers.${name}`,
        message: `helpers.${name} must be a string template body, got ${describeValue(body)}`,
        line: findKeyLine(ctx.source, ["helpers", name]),
      });
      continue;
    }
    out[name] = body;
  }
  return out;
}
