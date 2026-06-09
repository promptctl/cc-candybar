// [LAW:types-are-the-program] The action-table schema. An ActionDecl is
// discriminated by exactly-one-of set/copy/open; a `set` adds exactly-one value
// SOURCE (to/from/min-max-by/int). The proof here is what lets every downstream
// consumer (renderAction, deriveActionValidators) match on the present key with
// no fallthrough. Whether a `{{ action "name" }}` reference resolves is a
// cross-ref concern. This file changes when the action vocabulary changes.
//
// [LAW:no-mode-explosion] Unlike cache (single-key value-arms → oneOfPresent) and
// variables (tag-by-field-value → taggedUnion), an action's arms are multi-key
// RECORDS: a `set` carries `set` plus a value-source group (`to` | `from` |
// `min`/`max`/`by` | `int`). A single key never selects an arm, so the shared
// present-key engine doesn't fit — bending it to would mean per-arm sibling
// allow-lists and bespoke unknown-key messages bolted on as modes. Instead the
// leaf machinery is shared (`fields` + `refine` + field specs carry every arm's
// shape and cross-field invariant as DATA) and this file owns only the thin total
// present-key dispatch — the irreducible union eliminator.

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
  fields,
  isPlainObject,
  refine,
  requireString,
  type ArmParse,
  type FieldSpec,
  type FieldSpecMap,
  type Refinement,
  type ValidateCtx,
} from "./validate-core.js";

// [LAW:locality-or-seam] Structural validation of the `actions` block: each
// action is discriminated by which of set/copy/open is present, a `set` further
// by its value SOURCE (to | from | min/max/by | int). Whether a `{{ action
// "name" }}` reference resolves is a cross-ref concern (validateCrossReferences),
// which runs on the MERGED config so a segment can reference a default-provided
// action.
export function validateActions(
  ctx: ValidateCtx,
  raw: unknown,
): Record<string, ActionDecl> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    issue(
      ctx,
      "actions",
      `actions must be an object, got ${describeType(raw)}`,
    );
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

// [LAW:single-enforcer] One place pushes an issue with the resolved source line —
// the line derivation is mechanical from the path, so no callsite restates it.
function issue(ctx: ValidateCtx, path: string, message: string): void {
  ctx.issues.push({
    path,
    message,
    line: findKeyLine(ctx.source, path.split(".")),
  });
}

// [LAW:dataflow-not-control-flow] The top-level union eliminator: exactly one of
// set/copy/open is present, then dispatch the whole record to that arm via the
// arm table. The dispatch is a total projection over the present key (no
// fallthrough) — the only branch is the presence-count, which every union must
// discriminate somewhere. The set arm owns its own siblings (the value source),
// so this level rejects no keys generically.
function validateActionDecl(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): ActionDecl | null {
  if (!isPlainObject(raw)) {
    issue(
      ctx,
      path,
      `${path} must be an action object, got ${describeType(raw)}`,
    );
    return null;
  }
  const present = (ACTION_KEYS as readonly string[]).filter((k) => k in raw);
  if (present.length !== 1) {
    issue(
      ctx,
      path,
      `action must declare exactly one of: ${ACTION_KEYS.join(", ")}${
        present.length > 1 ? ` (found: ${present.join(", ")})` : ""
      }`,
    );
    return null;
  }
  return ACTION_ARMS[present[0] as ActionKey](ctx, path, raw);
}

// [LAW:dataflow-not-control-flow] The top-level arm table as DATA: copy/open share
// one template-arm shape (their key names the only difference); set delegates to
// its value-source sub-union. The present key indexes this map — the eliminator
// never branches on the key name.
const ACTION_ARMS: Record<ActionKey, ArmParse<ActionDecl>> = {
  set: validateSetAction,
  copy: templateArm("copy"),
  open: templateArm("open"),
};

// [LAW:one-type-per-behavior] copy and open are one behavior — a single required
// template string, no other keys — parameterized by the key. Both reject every
// sibling key (the arm's only legal key is its own) with the bespoke per-key
// message, then read the template.
function templateArm(key: "copy" | "open"): ArmParse<ActionDecl> {
  return (ctx, path, raw) => {
    for (const k of Object.keys(raw)) {
      if (k !== key)
        issue(
          ctx,
          `${path}.${k}`,
          `Unknown key "${k}" on a ${key} action. Expected only: ${key}`,
        );
    }
    const tmpl = requireString(ctx, path, raw, key);
    return tmpl === null ? null : ({ [key]: tmpl } as unknown as ActionDecl);
  };
}

// ─── The `set` value-source sub-union ────────────────────────────────────────

// [LAW:single-enforcer] A set-state URL path segment must be a non-empty,
// slash-free string — the set-state value is a slash-delimited
// <session>/<key>/<value> run, so an empty or slash-bearing segment is
// undeliverable. One validator, two callers (the `set` key and a literal `to`
// value), each supplying its bespoke message — the shape is enforced once, the
// wording stays per-use DATA. The codec itself is slash-safe; this is a
// deliberate upstream restriction so a slash-bearing key/value never reaches the
// wire, surfaced at load rather than thrown when validators register.
function slashFreeString(
  ctx: ValidateCtx,
  path: string,
  field: string,
  raw: Record<string, unknown>,
  emptyMessage: string,
  slashMessage: (value: string) => string,
): string | null {
  const v = requireString(ctx, path, raw, field);
  if (v === null) return null;
  const at = `${path}.${field}`;
  if (v === "") {
    issue(ctx, at, emptyMessage);
    return null;
  }
  if (v.includes("/")) {
    issue(ctx, at, slashMessage(v));
    return null;
  }
  return v;
}

// [LAW:dataflow-not-control-flow] The `set` key is validated once for every value
// source (it is shared across all set arms), before the source is detected — so a
// bad key and an ambiguous source both surface in one pass, matching the
// hand-rolled order. It is therefore NOT a field of any arm's `fields` map; the
// arm parses only the value-source payload, and the dispatcher re-attaches `set`.
function validateSetKey(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): string | null {
  return slashFreeString(
    ctx,
    path,
    "set",
    raw,
    `set key must be non-empty (the SessionState key to write)`,
    (v) => `set key "${v}" contains "/" — state keys must be slash-free`,
  );
}

// [LAW:types-are-the-program] Each value source's payload as a field map — the
// non-`set` keys that source carries. `fields` runs every spec (reporting all
// issues) and fails the arm when a required field is absent or invalid; `refine`
// adds the cross-field invariants `fields` cannot express. The reconstructed
// payload IS the member minus `set`, which the dispatcher re-attaches.
const TO_FIELDS: FieldSpecMap<{ to: string }> = { to: setLiteralSpec() };
const FROM_FIELDS: FieldSpecMap<{ from: OptionSource }> = { from: fromSpec() };
const BOUNDED_FIELDS: FieldSpecMap<{ min: number; max: number; by: number }> = {
  min: requireIntSpec(),
  max: requireIntSpec(),
  by: requireIntSpec(),
};
const INT_FIELDS: FieldSpecMap<{ int: true }> = { int: intMarkerSpec() };

// [LAW:types-are-the-program] A bounded step is fully described by an integer
// domain (min < max) and a non-zero integer increment (`by`; negative for a
// down-step). The validator derives the range [min,max] (the wire gate); the
// renderer wraps current ± by inside it. These two cross-field invariants are the
// refinements `fields` cannot express — relating two fields, not one — carried as
// DATA whose messages interpolate the assembled value. Unlike a stepper widget's
// positive `step`, `by` may be negative (the down affordance), so the check is
// non-zero, not positive.
interface BoundedPayload {
  min: number;
  max: number;
  by: number;
}
const minLessThanMax: Refinement<BoundedPayload> = {
  ok: (v) => v.min < v.max,
  issue: (v) => ({
    field: "min",
    message: `min (${v.min}) must be less than max (${v.max})`,
  }),
};
const byNonZero: Refinement<BoundedPayload> = {
  ok: (v) => v.by !== 0,
  issue: () => ({
    field: "by",
    message: `by must be a non-zero integer (the per-click increment; negative steps down)`,
  }),
};

// [LAW:types-are-the-program] A set arm is its payload field map plus its
// refinements; `detect` (the non-`set` keys whose presence selects it), `allowed`
// (those keys plus `set`, the unknown-key allow-list), and `label` (the source
// name in the exactly-one message — the detect keys joined by "/") all DERIVE from
// the field map, so the field set is the single source for what the arm parses,
// permits, and is named by.
interface SetArm {
  readonly detect: readonly string[];
  readonly allowed: readonly string[];
  readonly label: string;
  readonly parse: ArmParse<Partial<ActionDecl>>;
}

function setArm<P extends object>(
  fieldMap: FieldSpecMap<P>,
  ...checks: ReadonlyArray<Refinement<P>>
): SetArm {
  const detect = Object.keys(fieldMap);
  const inner: ArmParse<P> = (ctx, path, raw) =>
    fields(ctx, fieldMap, path, raw);
  return {
    detect,
    allowed: ["set", ...detect],
    label: detect.join("/"),
    parse: (checks.length
      ? refine(inner, ...checks)
      : inner) as unknown as ArmParse<Partial<ActionDecl>>,
  };
}

// [LAW:dataflow-not-control-flow] The value-source arms in the order their labels
// appear in the exactly-one message. A `set` declares exactly one of these; the
// dispatcher counts presence over `detect` and reconstructs `{ set, ...payload }`.
const SET_ARMS: readonly SetArm[] = [
  setArm(TO_FIELDS),
  setArm(FROM_FIELDS),
  setArm(BOUNDED_FIELDS, minLessThanMax, byNonZero),
  setArm(INT_FIELDS),
];

const VALUE_SOURCE_MESSAGE = `a set action declares exactly one value source: "to" (a literal value), "from" (an option domain: ${OPTION_SOURCES.join(
  "/",
)}), "min"/"max"/"by" (a bounded step), or "int" (an unbounded integer cursor)`;

// [LAW:dataflow-not-control-flow] The set sub-union eliminator: validate the
// shared `set` key, count which value sources are present, require exactly one,
// reject keys outside that arm's allow-list, parse the payload, reconstruct the
// member. The variability (which arms, each arm's fields/refinements/allow-list)
// is the SET_ARMS data; the only branches are the presence-count and the
// null-threading both the key and the payload share.
function validateSetAction(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionDecl | null {
  const stateKey = validateSetKey(ctx, path, raw);

  const present = SET_ARMS.filter((arm) => arm.detect.some((k) => k in raw));
  if (present.length !== 1) {
    issue(
      ctx,
      path,
      `${VALUE_SOURCE_MESSAGE}${
        present.length > 1
          ? ` — found: ${present.map((a) => a.label).join(", ")}`
          : ""
      }`,
    );
    return null;
  }
  const arm = present[0]!;

  for (const k of Object.keys(raw)) {
    if (!arm.allowed.includes(k))
      issue(
        ctx,
        `${path}.${k}`,
        `Unknown key "${k}" on this set action. Expected one of: ${arm.allowed.join(", ")}`,
      );
  }

  const payload = arm.parse(ctx, path, raw);
  return stateKey === null || payload === null
    ? null
    : ({ set: stateKey, ...payload } as unknown as ActionDecl);
}

// [LAW:no-silent-fallbacks] A literal `to` and the `set` key share the
// non-empty/slash-free shape — the set-state wire rejects empty values and splits
// on "/", so either is undeliverable. The empty/slash messages are this arm's,
// the shape is the shared enforcer's.
function setLiteralSpec(): FieldSpec<string> {
  return {
    required: true,
    parse: (ctx, path, field, raw) =>
      slashFreeString(
        ctx,
        path,
        field,
        raw,
        `set value must be non-empty — an empty value cannot be delivered on the set-state wire`,
        (v) => `set value "${v}" contains "/" — set values must be slash-free`,
      ) ?? undefined,
  };
}

// [LAW:types-are-the-program] `from` is a required member of the closed
// OPTION_SOURCES domain — the option set a picker ranges. A non-member is a hard
// error with the bespoke one-of message, never a silent fallback.
function fromSpec(): FieldSpec<OptionSource> {
  return {
    required: true,
    parse: (ctx, path, field, raw) => {
      const from = raw[field];
      if (
        typeof from !== "string" ||
        !(OPTION_SOURCES as readonly string[]).includes(from)
      ) {
        issue(
          ctx,
          `${path}.${field}`,
          `from must be one of: ${OPTION_SOURCES.join(", ")}, got ${describeValue(from)}`,
        );
        return undefined;
      }
      return from as OptionSource;
    },
  };
}

// [LAW:no-silent-fallbacks] `int` is a marker, not a value — it declares the key
// an unbounded-integer cursor. Only the literal `true` is meaningful; anything
// else is a typo to surface, not silently coerce.
function intMarkerSpec(): FieldSpec<true> {
  return {
    required: true,
    parse: (ctx, path, field, raw) => {
      if (raw[field] !== true) {
        issue(
          ctx,
          `${path}.${field}`,
          `int must be the literal true (declares the key an unbounded integer cursor — a paged picker's page key), got ${describeValue(raw[field])}`,
        );
        return undefined;
      }
      return true;
    },
  };
}

// [LAW:types-are-the-program] A required integer field — the field key (min / max
// / by) comes from the map, the message names it. A non-integer or absent value
// reports and fails the arm.
function requireIntSpec(): FieldSpec<number> {
  return {
    required: true,
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (typeof v !== "number" || !Number.isInteger(v)) {
        issue(
          ctx,
          `${path}.${field}`,
          `${field} must be an integer, got ${describeValue(v)}`,
        );
        return undefined;
      }
      return v;
    },
  };
}
