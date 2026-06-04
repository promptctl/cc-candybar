// [LAW:types-are-the-program] The cache-policy schema: a CacheDecl is exactly one
// of ttl / watch_file / depends_on / key / never. requireCache/optionalCache gate
// presence by source kind; validateCache enforces exactly-one; validateCacheVariant
// narrows that one. This file changes when the cache vocabulary changes.

import {
  CACHE_KEYS,
  SOURCES_REQUIRING_CACHE,
  type CacheDecl,
  type CacheKey,
  type SourceKind,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
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
    // For kinds where cache is optional and absent, this path is unreachable
    // because callers use optionalCache; keep narrow.
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

function validateCache(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): CacheDecl | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `cache must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const present = Object.keys(raw).filter((k): k is CacheKey =>
    (CACHE_KEYS as readonly string[]).includes(k),
  );
  const unknown = Object.keys(raw).filter(
    (k) => !(CACHE_KEYS as readonly string[]).includes(k),
  );

  for (const k of unknown) {
    ctx.issues.push({
      path: `${path}.${k}`,
      message: `Unknown cache key "${k}". Expected exactly one of: ${CACHE_KEYS.join(", ")}`,
      line: findKeyLine(ctx.source, [...path.split("."), k]),
    });
  }

  if (present.length === 0) {
    ctx.issues.push({
      path,
      message: `cache must declare exactly one of: ${CACHE_KEYS.join(", ")}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  if (present.length > 1) {
    ctx.issues.push({
      path,
      message: `cache must declare exactly one of: ${CACHE_KEYS.join(", ")} (found: ${present.join(", ")})`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }

  const key = present[0]!;
  const value = raw[key];
  return validateCacheVariant(ctx, `${path}.${key}`, key, value);
}

function validateCacheVariant(
  ctx: ValidateCtx,
  path: string,
  key: CacheKey,
  value: unknown,
): CacheDecl | null {
  switch (key) {
    case "ttl":
      if (typeof value !== "string" || !isValidDuration(value)) {
        ctx.issues.push({
          path,
          message: `cache.ttl must be a duration string like "5s", "100ms", "2m", "1h"; got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { ttl: value };

    case "watch_file":
      if (typeof value !== "string" || value === "") {
        ctx.issues.push({
          path,
          message: `cache.watch_file must be a non-empty path string, got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { watch_file: value };

    case "depends_on":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        ctx.issues.push({
          path,
          message: `cache.depends_on must be an array of variable-name strings, got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { depends_on: value as string[] };

    case "key":
      if (typeof value !== "string" || value === "") {
        ctx.issues.push({
          path,
          message: `cache.key must be a non-empty template string, got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { key: value };

    case "never":
      if (value !== true) {
        ctx.issues.push({
          path,
          message: `cache.never must be the literal boolean true, got ${describeValue(value)}`,
          line: findKeyLine(ctx.source, path.split(".")),
        });
        return null;
      }
      return { never: true };
  }
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
function isValidDuration(s: string): boolean {
  return DURATION_RE.test(s);
}
