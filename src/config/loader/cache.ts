// [LAW:types-are-the-program] The cache-policy schema: a CacheDecl is exactly one
// of ttl / watch_file / depends_on / key / never, declared as DATA (CACHE_SCHEMA)
// and interpreted by the tag-by-present-key engine (oneOfPresent).
// requireCache gates presence by source kind. This file changes when
// the cache vocabulary changes — add an arm to CACHE_SCHEMA and CacheDecl.

import { CACHE_KEYS, type CacheDecl, type SourceKind } from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  absolutePathProblem,
  describeValue,
  oneOfPresent,
  oneOfPresentJson,
  reject,
  type FieldSpec,
  type JsonNode,
  type OneOfPresentSchema,
  type ValidateCtx,
} from "./validate-core.js";

// [LAW:types-are-the-program] The kinds whose source the daemon re-reads on a
// policy only the author can choose (no sensible default) — the field maps that
// call requireCacheSpec are the whole list, so the parameter type is the set.
type PolicySourceKind = Extract<SourceKind, "file" | "shell">;

export function requireCache(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  kind: PolicySourceKind,
): CacheDecl | null {
  if (raw.cache === undefined) {
    ctx.issues.push({
      path: `${path}.cache`,
      message: `${kind} variables must declare a cache policy (one of: ${CACHE_KEYS.join(", ")})`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  return validateCache(ctx, `${path}.cache`, raw.cache);
}

// [LAW:dataflow-not-control-flow] The `cache` field as a record-field spec, so a
// per-kind variable schema declares its cache policy as DATA: file/shell require
// it (a missing cache reports the per-kind message and fails the arm); every
// other kind takes none. The field key is conventionally "cache", read directly
// by requireCache.
export function requireCacheSpec(kind: PolicySourceKind): FieldSpec<CacheDecl> {
  return {
    required: true,
    json: cacheJson(),
    parse: (ctx, path, _field, raw) =>
      requireCache(ctx, path, raw, kind) ?? undefined,
  };
}

// [LAW:types-are-the-program] The cache schema declared as DATA: arm keys in
// CACHE_KEYS order (the structural messages join them), each arm carrying its
// value-validation predicate and bespoke message. The literal "cache.<key>"
// prefix is the contract text, independent of the runtime path used for line.
// [LAW:one-source-of-truth] Each arm's `json` is the schema for the VALUE at its
// present key — duration/path/key are strings, depends_on a string array, never
// the literal true; the duration FORMAT (and non-empty) is a semantic check the
// validator keeps (a JSON Schema `pattern` could mirror it, but the loader's
// duration grammar is the single authority, so the schema stays at `type:string`).
const CACHE_SCHEMA: OneOfPresentSchema<CacheDecl> = {
  noun: "cache",
  arms: {
    ttl: {
      json: { type: "string" },
      parse: (ctx, path, value) =>
        typeof value === "string" && isValidDuration(value)
          ? { ttl: value }
          : reject(
              ctx,
              path,
              `cache.ttl must be a duration string like "5s", "100ms", "2m", "1h"; got ${describeValue(value)}`,
            ),
    },
    watch_file: {
      json: { type: "string", pattern: "^/" },
      parse: (ctx, path, value) => {
        if (typeof value !== "string")
          return reject(
            ctx,
            path,
            `cache.watch_file must be a path string, got ${describeValue(value)}`,
          );
        const problem = absolutePathProblem("cache.watch_file", value);
        return problem === null
          ? { watch_file: value }
          : reject(ctx, path, problem);
      },
    },
    depends_on: {
      json: { type: "array", items: { type: "string" } },
      parse: (ctx, path, value) =>
        Array.isArray(value) && value.every((v) => typeof v === "string")
          ? { depends_on: value as string[] }
          : reject(
              ctx,
              path,
              `cache.depends_on must be an array of variable-name strings, got ${describeValue(value)}`,
            ),
    },
    key: {
      json: { type: "string" },
      parse: (ctx, path, value) =>
        typeof value === "string" && value !== ""
          ? { key: value }
          : reject(
              ctx,
              path,
              `cache.key must be a non-empty template string, got ${describeValue(value)}`,
            ),
    },
    never: {
      json: { const: true },
      parse: (ctx, path, value) =>
        value === true
          ? { never: true }
          : reject(
              ctx,
              path,
              `cache.never must be the literal boolean true, got ${describeValue(value)}`,
            ),
    },
  },
};

function validateCache(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): CacheDecl | null {
  return oneOfPresent(ctx, CACHE_SCHEMA, path, raw);
}

// [LAW:one-source-of-truth] The cache emitter derives from the SAME CACHE_SCHEMA
// the validator interprets — shared by the per-kind variable cache fields.
export function cacheJson(): JsonNode {
  return oneOfPresentJson(CACHE_SCHEMA);
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
function isValidDuration(s: string): boolean {
  return DURATION_RE.test(s);
}
