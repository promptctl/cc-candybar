// [LAW:types-are-the-program] The variable schema: a VariableDecl is discriminated
// by `kind` (literal / input / env / file / shell / template / time / git / state),
// each arm declaring its own required + optional fields. validateVariableByKind is
// the single total switch over the discriminator. This file changes when a source
// kind's shape changes; adding a kind is one new arm here plus its runtime impl.

import {
  GIT_FIELDS,
  SOURCE_KINDS,
  type GitField,
  type SourceKind,
  type VariableDecl,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  isPlainObject,
  isSourceKind,
  optionalEnum,
  optionalString,
  optionalStringField,
  optionalTypedDefault,
  requireString,
  type ValidateCtx,
} from "./validate-core.js";
import { optionalCache, requireCache } from "./cache.js";

export function validateVariables(
  ctx: ValidateCtx,
  pathPrefix: string,
  raw: unknown,
): Record<string, VariableDecl> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: pathPrefix,
      message: `${pathPrefix} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, pathPrefix.split(".")),
    });
    return {};
  }

  const out: Record<string, VariableDecl> = {};
  for (const [name, decl] of Object.entries(raw)) {
    const path = `${pathPrefix}.${name}`;
    const parsed = validateVariable(ctx, path, decl);
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

function validateVariable(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): VariableDecl | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const rawKind = raw.kind;
  if (typeof rawKind !== "string") {
    ctx.issues.push({
      path: `${path}.kind`,
      message: `${path}.kind must be a string, got ${describeType(rawKind)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  if (!isSourceKind(rawKind)) {
    ctx.issues.push({
      path: `${path}.kind`,
      message: `Unknown source kind "${rawKind}". Expected one of: ${SOURCE_KINDS.join(", ")}`,
      line: findKeyLine(ctx.source, [...path.split("."), "kind"]),
    });
    return null;
  }

  // Cache: required for shell/file/git; optional for template/time; n/a for
  // literal/input/env. Per-kind dispatch handles the requirement.
  return validateVariableByKind(ctx, path, rawKind, raw);
}

function validateVariableByKind(
  ctx: ValidateCtx,
  path: string,
  kind: SourceKind,
  raw: Record<string, unknown>,
): VariableDecl | null {
  switch (kind) {
    case "literal": {
      const value = raw.value;
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        ctx.issues.push({
          path: `${path}.value`,
          message: `literal value must be string|number|boolean, got ${describeType(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return {
        kind: "literal",
        value,
        ...optionalString(ctx, path, raw, "default"),
      };
    }

    case "input": {
      const p = requireString(ctx, path, raw, "path");
      if (p === null) return null;
      // [LAW:types-are-the-program] Absent `type` keeps existing string-typed
      // declarations behaving exactly as before — the daemon's augmented
      // payload carries strings (`cwd`, `model`, `session_id`) at those paths,
      // and the default at the loader is "string" not "any".
      const t = optionalEnum(ctx, path, raw, "type", [
        "string",
        "number",
        "boolean",
      ] as const);
      const def = optionalTypedDefault(ctx, path, raw, t ?? "string");
      return {
        kind: "input",
        path: p,
        ...(t !== undefined && { type: t }),
        ...(def !== undefined && { default: def }),
      };
    }

    case "env": {
      const name = requireString(ctx, path, raw, "name");
      if (name === null) return null;
      return {
        kind: "env",
        name,
        ...optionalString(ctx, path, raw, "default"),
      };
    }

    case "file": {
      const filePath = requireString(ctx, path, raw, "path");
      const cache = requireCache(ctx, path, raw, kind);
      const readMode = optionalEnum(ctx, path, raw, "readMode", [
        "whole",
        "first-line",
      ] as const);
      const regex = optionalStringField(ctx, path, raw, "regex");
      const def = optionalStringField(ctx, path, raw, "default");
      if (filePath === null || cache === null) return null;
      return {
        kind: "file",
        path: filePath,
        ...(readMode !== undefined && { readMode }),
        ...(regex !== undefined && { regex }),
        cache,
        ...(def !== undefined && { default: def }),
      };
    }

    case "shell": {
      const command = requireString(ctx, path, raw, "command");
      const cache = requireCache(ctx, path, raw, kind);
      const regex = optionalStringField(ctx, path, raw, "regex");
      const def = optionalStringField(ctx, path, raw, "default");
      if (command === null || cache === null) return null;
      return {
        kind: "shell",
        command,
        ...(regex !== undefined && { regex }),
        cache,
        ...(def !== undefined && { default: def }),
      };
    }

    case "template": {
      const template = requireString(ctx, path, raw, "template");
      if (template === null) return null;
      const cache = optionalCache(ctx, path, raw);
      const def = optionalStringField(ctx, path, raw, "default");
      return {
        kind: "template",
        template,
        ...(cache !== undefined && { cache }),
        ...(def !== undefined && { default: def }),
      };
    }

    case "time": {
      const layout = requireString(ctx, path, raw, "layout");
      if (layout === null) return null;
      const cache = optionalCache(ctx, path, raw);
      const def = optionalStringField(ctx, path, raw, "default");
      return {
        kind: "time",
        layout,
        ...(cache !== undefined && { cache }),
        ...(def !== undefined && { default: def }),
      };
    }

    case "git": {
      const field = raw.field;
      if (
        typeof field !== "string" ||
        !GIT_FIELDS.includes(field as GitField)
      ) {
        ctx.issues.push({
          path: `${path}.field`,
          message: `git field must be one of: ${GIT_FIELDS.join(", ")}, got ${JSON.stringify(field)}`,
          line: findKeyLine(ctx.source, [...path.split("."), "field"]),
        });
        return null;
      }
      const cache = requireCache(ctx, path, raw, kind);
      const def = optionalStringField(ctx, path, raw, "default");
      if (cache === null) return null;
      return {
        kind: "git",
        field: field as GitField,
        cache,
        ...(def !== undefined && { default: def }),
      };
    }

    case "state": {
      const key = requireString(ctx, path, raw, "key");
      if (key === null) return null;
      const def = optionalStringField(ctx, path, raw, "default");
      return {
        kind: "state",
        key,
        ...(def !== undefined && { default: def }),
      };
    }
  }
}
