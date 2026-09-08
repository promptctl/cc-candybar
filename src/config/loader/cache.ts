// [LAW:types-are-the-program] The cache-policy schema as DATA (CACHE_SCHEMA), interpreted by the tag-by-present-key engine; a new policy is a new arm.

import {
  CACHE_KEYS,
  SOURCES_REQUIRING_CACHE,
  type CacheDecl,
  type SourceKind,
  type TtlCacheDecl,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeValue,
  oneOfPresent,
  oneOfPresentJson,
  reject,
  type FieldSpec,
  type JsonNode,
  type OneOfPresentSchema,
  type ValidateCtx,
} from "./validate-core.js";

export function requireCache(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  kind: SourceKind,
): CacheDecl | null {
  if (raw.cache === undefined) {
    if (SOURCES_REQUIRING_CACHE.includes(kind)) {
      ctx.issues.push({
        path: `${path}.cache`,
        message: `${kind} variables must declare a cache policy (one of: ${CACHE_KEYS.join(", ")})`,
        line: findKeyLine(ctx.source, path.split(".")),
      });
      return null;
    }
    // Unreachable for optional kinds: those callers use optionalCache.
    return null;
  }
  return validateCache(ctx, `${path}.cache`, raw.cache);
}

export function optionalCache(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): CacheDecl | undefined {
  if (raw.cache === undefined) return undefined;
  const c = validateCache(ctx, `${path}.cache`, raw.cache);
  return c ?? undefined;
}

// [LAW:dataflow-not-control-flow] `kind` selects requiredness, so a per-kind variable schema declares its cache policy as data.
export function requireCacheSpec(kind: SourceKind): FieldSpec<CacheDecl> {
  return {
    required: true,
    json: cacheJson(),
    parse: (ctx, path, _field, raw) =>
      requireCache(ctx, path, raw, kind) ?? undefined,
  };
}

export function optionalCacheSpec(): FieldSpec<CacheDecl> {
  return {
    required: false,
    json: cacheJson(),
    parse: (ctx, path, _field, raw) => optionalCache(ctx, path, raw),
  };
}

// [LAW:types-are-the-program] Arm keys in CACHE_KEYS order. [LAW:one-source-of-truth] Each arm's `json` types the VALUE at its present key; the duration FORMAT stays a validator check because the loader's grammar is its only authority.
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
      json: { type: "string" },
      parse: (ctx, path, value) =>
        typeof value === "string" && value !== ""
          ? { watch_file: value }
          : reject(
              ctx,
              path,
              `cache.watch_file must be a non-empty path string, got ${describeValue(value)}`,
            ),
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

// [LAW:types-are-the-program] The ttl-only subset for kinds honoring no other invalidation; the arm is CACHE_SCHEMA's own, never a parallel grammar. [LAW:no-silent-failure] A non-ttl form is a load error, not a coercion.
const TTL_ONLY_CACHE_SCHEMA: OneOfPresentSchema<TtlCacheDecl> = {
  noun: "time-variable cache",
  arms: { ttl: CACHE_SCHEMA.arms.ttl },
};

export function ttlOnlyCacheSpec(): FieldSpec<TtlCacheDecl> {
  return {
    required: false,
    json: oneOfPresentJson(TTL_ONLY_CACHE_SCHEMA),
    parse: (ctx, path, _field, raw) =>
      raw.cache === undefined
        ? undefined
        : (oneOfPresent(
            ctx,
            TTL_ONLY_CACHE_SCHEMA,
            `${path}.cache`,
            raw.cache,
          ) ?? undefined),
  };
}

// [LAW:one-source-of-truth] The emitter derives from the SAME CACHE_SCHEMA the validator interprets.
export function cacheJson(): JsonNode {
  return oneOfPresentJson(CACHE_SCHEMA);
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
function isValidDuration(s: string): boolean {
  return DURATION_RE.test(s);
}
