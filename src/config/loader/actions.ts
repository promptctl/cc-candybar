// [LAW:types-are-the-program] The action-table schema. An ActionDecl is
// discriminated by exactly-one-of set/copy/open; a `set` adds exactly-one value
// SOURCE (to/from/min-max-by/int). The proof here is what lets every downstream
// consumer (renderAction, deriveActionValidators) match on the present key with
// no fallthrough. Whether a `{{ action "name" }}` reference resolves is a
// cross-ref concern. This file changes when the action vocabulary changes.

import {
  ACTION_KEYS,
  OPTION_SOURCES,
  type ActionDecl,
  type ActionKey,
  type OptionSource,
} from "../action.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  requireString,
  type ValidateCtx,
} from "./validate-core.js";

// [LAW:locality-or-seam] Structural validation of the `actions` block: each
// action is discriminated by which of set/copy/open is present, a `set` further
// by its value SOURCE (to | from | min/max/by). Whether a `{{ action "name" }}`
// reference resolves is a cross-ref concern (validateCrossReferences), which runs
// on the MERGED config so a segment can reference a default-provided action.
export function validateActions(
  ctx: ValidateCtx,
  raw: unknown,
): Record<string, ActionDecl> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "actions",
      message: `actions must be an object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["actions"]),
    });
    return {};
  }
  // [LAW:types-are-the-program] Null-prototype record for user-keyed data, so an
  // action named "__proto__"/"constructor" is an ordinary own property, never a
  // prototype-chain mutation — matching the widgets block and the compiled maps.
  const out: Record<string, ActionDecl> = Object.create(null) as Record<
    string,
    ActionDecl
  >;
  for (const [name, decl] of Object.entries(raw)) {
    const parsed = validateActionDecl(ctx, `actions.${name}`, decl);
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

// [LAW:types-are-the-program] Narrow `unknown` to one ActionDecl arm or record an
// issue. The top-level discriminator is exactly-one-of set/copy/open; a `set`
// adds exactly-one value SOURCE (to/from/min-max-by). The proof here is what lets
// every downstream consumer (renderAction, deriveActionValidators) match on the
// present key with no fallthrough.
function validateActionDecl(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): ActionDecl | null {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path,
      message: `${path} must be an action object, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  const present = (ACTION_KEYS as readonly string[]).filter((k) => k in raw);
  if (present.length !== 1) {
    ctx.issues.push({
      path,
      message: `action must declare exactly one of: ${ACTION_KEYS.join(", ")}${
        present.length > 1 ? ` (found: ${present.join(", ")})` : ""
      }`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  const key = present[0] as ActionKey;
  if (key === "copy" || key === "open") {
    for (const k of Object.keys(raw)) {
      if (k !== key) {
        ctx.issues.push({
          path: `${path}.${k}`,
          message: `Unknown key "${k}" on a ${key} action. Expected only: ${key}`,
          line: findKeyLine(ctx.source, [...path.split("."), k]),
        });
      }
    }
    const tmpl = requireString(ctx, path, raw, key);
    if (tmpl === null) return null;
    return key === "copy" ? { copy: tmpl } : { open: tmpl };
  }
  return validateSetAction(ctx, path, raw);
}

// [LAW:types-are-the-program] A `set` action's value SOURCE is exactly one of:
// `to` (literal), `from` (option domain), or `min`/`max`/`by` (bounded step).
// Discriminate by presence, require exactly one source, then narrow that arm —
// the same single-discriminator shape the CacheDecl and ActionDecl unions use.
function validateSetAction(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionDecl | null {
  const stateKey = validateSetKey(ctx, path, raw);

  // [LAW:dataflow-not-control-flow] Which value sources the object declares is a
  // VALUE (a filtered list), not a branch — exactly one is legal.
  const BOUNDED_KEYS = ["min", "max", "by"];
  const sources: string[] = [];
  if ("to" in raw) sources.push("to");
  if ("from" in raw) sources.push("from");
  if (BOUNDED_KEYS.some((k) => k in raw)) sources.push("min/max/by");
  if ("int" in raw) sources.push("int");
  if (sources.length !== 1) {
    ctx.issues.push({
      path,
      message: `a set action declares exactly one value source: "to" (a literal value), "from" (an option domain: ${OPTION_SOURCES.join(
        "/",
      )}), "min"/"max"/"by" (a bounded step), or "int" (an unbounded integer cursor)${
        sources.length > 1 ? ` — found: ${sources.join(", ")}` : ""
      }`,
      line: findKeyLine(ctx.source, path.split(".")),
    });
    return null;
  }
  const source = sources[0]!;
  const allowed =
    source === "to"
      ? ["set", "to"]
      : source === "from"
        ? ["set", "from"]
        : source === "int"
          ? ["set", "int"]
          : ["set", ...BOUNDED_KEYS];
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) {
      ctx.issues.push({
        path: `${path}.${k}`,
        message: `Unknown key "${k}" on this set action. Expected one of: ${allowed.join(", ")}`,
        line: findKeyLine(ctx.source, [...path.split("."), k]),
      });
    }
  }

  if (source === "to") {
    const to = validateSetLiteralValue(ctx, path, raw);
    return stateKey === null || to === null ? null : { set: stateKey, to };
  }
  if (source === "from") {
    const from = raw.from;
    if (
      typeof from !== "string" ||
      !(OPTION_SOURCES as readonly string[]).includes(from)
    ) {
      ctx.issues.push({
        path: `${path}.from`,
        message: `from must be one of: ${OPTION_SOURCES.join(", ")}, got ${describeValue(from)}`,
        line: findKeyLine(ctx.source, [...path.split("."), "from"]),
      });
      return null;
    }
    return stateKey === null
      ? null
      : { set: stateKey, from: from as OptionSource };
  }
  if (source === "int") {
    // [LAW:no-silent-fallbacks] `int` is a marker, not a value — it declares the
    // key as an unbounded-integer cursor. Only the literal `true` is meaningful;
    // anything else is a typo to surface, not silently coerce.
    if (raw.int !== true) {
      ctx.issues.push({
        path: `${path}.int`,
        message: `int must be the literal true (declares the key an unbounded integer cursor — a paged picker's page key), got ${describeValue(raw.int)}`,
        line: findKeyLine(ctx.source, [...path.split("."), "int"]),
      });
      return null;
    }
    return stateKey === null ? null : { set: stateKey, int: true };
  }
  const bounds = validateBoundedStep(ctx, path, raw);
  return stateKey === null || bounds === null
    ? null
    : { set: stateKey, ...bounds };
}

// [LAW:single-enforcer] A set action's key is a set-state URL path segment, so it
// must be a non-empty, slash-free string — the SAME shape a widget's `set` key
// and a widget's `state` key require. One check, surfaced at load with a clear
// message, not deferred to a throw when validators register.
function validateSetKey(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): string | null {
  const stateKey = requireString(ctx, path, raw, "set");
  if (stateKey === null) return null;
  if (stateKey === "") {
    ctx.issues.push({
      path: `${path}.set`,
      message: `set key must be non-empty (the SessionState key to write)`,
      line: findKeyLine(ctx.source, [...path.split("."), "set"]),
    });
    return null;
  }
  if (stateKey.includes("/")) {
    // [LAW:no-silent-fallbacks] State keys are restricted to slash-free by
    // policy: the set-state value is a slash-delimited <session>/<key>/<value>
    // run, and the loader + state-validator factories reject slash-bearing keys
    // upstream so one never reaches the wire (the segment codec itself is
    // slash-safe — this is a deliberate restriction, not a codec limitation).
    ctx.issues.push({
      path: `${path}.set`,
      message: `set key "${stateKey}" contains "/" — state keys must be slash-free`,
      line: findKeyLine(ctx.source, [...path.split("."), "set"]),
    });
    return null;
  }
  return stateKey;
}

// [LAW:no-silent-fallbacks] A literal `to` must be a non-empty, slash-free string
// — the set-state wire rejects empty values and splits on "/", so either is
// undeliverable. Reject at load, mirroring the widget `to` check.
function validateSetLiteralValue(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): string | null {
  const to = requireString(ctx, path, raw, "to");
  if (to === null) return null;
  if (to === "") {
    ctx.issues.push({
      path: `${path}.to`,
      message: `set value must be non-empty — an empty value cannot be delivered on the set-state wire`,
      line: findKeyLine(ctx.source, [...path.split("."), "to"]),
    });
    return null;
  }
  if (to.includes("/")) {
    // [LAW:no-silent-fallbacks] Set values are slash-free by the same upstream
    // policy as keys (see validateSetKey) — the segment codec is slash-safe, but
    // the loader + validators reject slash-bearing values so one never reaches
    // the wire. State the restriction, not a false codec detail.
    ctx.issues.push({
      path: `${path}.to`,
      message: `set value "${to}" contains "/" — set values must be slash-free`,
      line: findKeyLine(ctx.source, [...path.split("."), "to"]),
    });
    return null;
  }
  return to;
}

// [LAW:types-are-the-program] A bounded step is fully described by an integer
// domain (min < max) and a non-zero integer increment (`by`; negative for a
// down-step). The validator derives a range [min,max] from it (the wire gate);
// the renderer wraps current ± by inside those bounds. Validate the domain here
// so neither re-checks. Unlike a stepper widget's `step`, `by` may be negative
// (the down affordance), so the non-zero check replaces the positive check.
function validateBoundedStep(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): { min: number; max: number; by: number } | null {
  const intField = (field: string): number | null => {
    const v = raw[field];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      ctx.issues.push({
        path: `${path}.${field}`,
        message: `${field} must be an integer, got ${describeValue(v)}`,
        line: findKeyLine(ctx.source, [...path.split("."), field]),
      });
      return null;
    }
    return v;
  };
  const min = intField("min");
  const max = intField("max");
  const by = intField("by");
  if (min === null || max === null || by === null) return null;
  if (min >= max) {
    ctx.issues.push({
      path: `${path}.min`,
      message: `min (${min}) must be less than max (${max})`,
      line: findKeyLine(ctx.source, [...path.split("."), "min"]),
    });
    return null;
  }
  if (by === 0) {
    ctx.issues.push({
      path: `${path}.by`,
      message: `by must be a non-zero integer (the per-click increment; negative steps down)`,
      line: findKeyLine(ctx.source, [...path.split("."), "by"]),
    });
    return null;
  }
  return { min, max, by };
}
