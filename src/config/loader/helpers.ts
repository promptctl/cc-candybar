import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  type ValidateCtx,
} from "./validate-core.js";

// [LAW:single-enforcer] Structural only; whether a body parses is render-time.
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
