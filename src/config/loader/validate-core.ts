// [LAW:single-enforcer] The validation engine's primitives: the shared
// ValidateCtx every per-type validator threads, the field-combinators
// (requireString / optionalEnum / …) they compose from, and the type-describe
// helpers used in messages. Each per-type schema module (variables, segments,
// …) is a DECLARATION built from these; changing a primitive changes every
// validator uniformly. This file changes when the combinator vocabulary changes.

import { SOURCE_KINDS, type SourceKind } from "../dsl-types.js";
import { findKeyLine, type ConfigIssue } from "./diagnostics.js";

export interface ValidateCtx {
  readonly source: string;
  readonly issues: ConfigIssue[];
  readonly allowedPalettes: ReadonlySet<string>;
}

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function requireString(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  field: string,
): string | null {
  const v = raw[field];
  if (typeof v !== "string") {
    ctx.issues.push({
      path: `${path}.${field}`,
      message: `${path}.${field} must be a string, got ${describeType(v)}`,
      line: findKeyLine(ctx.source, [...path.split("."), field]),
    });
    return null;
  }
  return v;
}

export function optionalString(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  field: string,
): { default?: string } {
  const v = optionalStringField(ctx, path, raw, field);
  return v === undefined ? {} : { [field]: v };
}

// [LAW:types-are-the-program] Input-var defaults must match the declared
// `type` exactly — a string default on a number-typed input would silently
// coerce or throw on first render. Reject the mismatch at load time so the
// renderer can read `.default` as the declared type without re-checking.
export function optionalTypedDefault(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  type: "string" | "number" | "boolean",
): string | number | boolean | undefined {
  const v = raw.default;
  if (v === undefined) return undefined;
  const ok =
    (type === "string" && typeof v === "string") ||
    (type === "number" && typeof v === "number") ||
    (type === "boolean" && typeof v === "boolean");
  if (!ok) {
    ctx.issues.push({
      path: `${path}.default`,
      message: `default must be a ${type}, got ${describeType(v)}`,
      line: findKeyLine(ctx.source, [...path.split("."), "default"]),
    });
    return undefined;
  }
  return v as string | number | boolean;
}

export function optionalStringField(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = raw[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    ctx.issues.push({
      path: `${path}.${field}`,
      message: `${path}.${field} must be a string, got ${describeType(v)}`,
      line: findKeyLine(ctx.source, [...path.split("."), field]),
    });
    return undefined;
  }
  return v;
}

// [LAW:single-enforcer] One place validates a palette NAME, shared by globals
// and per-segment. An unknown name is a hard error, never a silent fallback —
// the renderer must never receive a name that won't resolve to a Palette.
export function validatePaletteName(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): string | undefined {
  const v = optionalStringField(ctx, path, raw, "palette");
  if (v === undefined) return undefined;
  if (!ctx.allowedPalettes.has(v)) {
    ctx.issues.push({
      path: `${path}.palette`,
      message: `Unknown palette "${v}". Expected one of: ${[...ctx.allowedPalettes].sort().join(", ")}`,
      line: findKeyLine(ctx.source, [...path.split("."), "palette"]),
    });
    return undefined;
  }
  return v;
}

export function optionalEnum<T extends string>(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const v = raw[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    ctx.issues.push({
      path: `${path}.${field}`,
      message: `${path}.${field} must be one of: ${allowed.join(", ")}; got ${describeValue(v)}`,
      line: findKeyLine(ctx.source, [...path.split("."), field]),
    });
    return undefined;
  }
  return v as T;
}

export function isSourceKind(s: string): s is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(s);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function describeValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  return String(v);
}
