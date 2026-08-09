// [LAW:types-are-the-program] The action-table schema. An ActionDecl is
// discriminated by exactly-one-of set/persist/copy/open/reset; a `set` or
// `persist` adds exactly-one value SOURCE (to/from/min-max-by/int — `persist`
// excludes `int`). The proof here is what lets every downstream consumer
// (renderAction, deriveActionValidators, deriveConfigActionValidators) match
// on the present key with no fallthrough. Whether a `{{ action "name" }}`
// reference resolves is a cross-ref concern. This file changes when the
// action vocabulary changes.
//
// [LAW:no-mode-explosion] Unlike cache (single-key value-arms → oneOfPresent) and
// variables (tag-by-field-value → taggedUnion), an action's arms are multi-key
// RECORDS: a `set`/`persist` carries the discriminator plus a value-source group
// (`to` | `from` | `min`/`max`/`by` | `int`). A single key never selects an arm, so
// the shared present-key engine doesn't fit — bending it to would mean per-arm
// sibling allow-lists and bespoke unknown-key messages bolted on as modes. Instead
// the leaf machinery is shared (`fields` + `refine` + field specs carry every arm's
// shape and cross-field invariant as DATA, parameterized by discriminator name so
// `set` and `persist` share one field-map definition) and this file owns only the
// thin total present-key dispatch — the irreducible union eliminator.

import {
  ACTION_KEYS,
  type ActionDecl,
  type ActionKey,
  type OptionDomain,
} from "../action.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  fields,
  isPlainObject,
  objectJson,
  refine,
  requireString,
  type ArmParse,
  type FieldSpec,
  type FieldSpecMap,
  type JsonNode,
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
// one template-arm shape (their key names the only difference); set/persist
// delegate to their value-source sub-union (the SAME field shapes, a different
// discriminator key — see valueSourceAction); reset is copy/open's plain-string
// sibling. The present key indexes this map — the eliminator never branches on
// the key name.
const ACTION_ARMS: Record<ActionKey, ArmParse<ActionDecl>> = {
  set: (ctx, path, raw) =>
    valueSourceAction(
      ctx,
      path,
      raw,
      "set",
      SET_ARMS,
      "the SessionState key to write",
    ),
  persist: (ctx, path, raw) =>
    valueSourceAction(
      ctx,
      path,
      raw,
      "persist",
      PERSIST_ARMS,
      "the config globals field to write",
    ),
  copy: templateArm("copy"),
  open: templateArm("open"),
  reset: resetArm,
};

// [LAW:one-source-of-truth] A copy/open action emits the closed single-key
// object its arm validates — symmetric to `templateArm(key)`'s parse.
function templateArmJson(key: "copy" | "open" | "reset"): JsonNode {
  return {
    type: "object",
    properties: { [key]: { type: "string" } },
    required: [key],
    additionalProperties: false,
  };
}

// [LAW:one-source-of-truth] One ActionDecl's schema: the set/persist sub-unions
// (each arm's `json`, derived from SET_ARMS/PERSIST_ARMS) joined with
// copy/open/reset — the SAME members `validateActionDecl` dispatches over. The
// `actions` block is a name → ActionDecl map, symmetric to `validateActions`.
function actionDeclJson(): JsonNode {
  return {
    anyOf: [
      ...SET_ARMS.map((arm) => arm.json),
      ...PERSIST_ARMS.map((arm) => arm.json),
      templateArmJson("copy"),
      templateArmJson("open"),
      templateArmJson("reset"),
    ],
  };
}

export function actionsJson(): JsonNode {
  return { type: "object", additionalProperties: actionDeclJson() };
}

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

// [LAW:one-type-per-behavior] `reset` is copy/open's shape (a single required
// string, no other keys) but the string is a KEY (a config globals field name),
// not a template — no Go-template parsing happens for it, so it reuses the
// slash-free/non-empty shape `set`/`persist` keys share rather than
// requireString's bare-presence check. A `function` declaration (not a const
// arrow) so it is hoisted — ACTION_ARMS above references it directly, not
// through a deferred closure.
function resetArm(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionDecl | null {
  for (const k of Object.keys(raw)) {
    if (k !== "reset")
      issue(
        ctx,
        `${path}.${k}`,
        `Unknown key "${k}" on a reset action. Expected only: reset`,
      );
  }
  const key = slashFreeString(
    ctx,
    path,
    "reset",
    raw,
    `reset key must be non-empty (the config globals field to clear)`,
    (v) => `reset key "${v}" contains "/" — keys must be slash-free`,
  );
  return key === null ? null : { reset: key };
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

// [LAW:dataflow-not-control-flow] The discriminator key ("set" or "persist")
// is validated once for every value source (it is shared across all arms of
// that discriminator), before the source is detected — so a bad key and an
// ambiguous source both surface in one pass. It is therefore NOT a field of
// any arm's `fields` map; the arm parses only the value-source payload, and
// the dispatcher re-attaches the discriminator.
function validateValueSourceKey(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  discriminator: "set" | "persist",
  keyNoun: string,
): string | null {
  return slashFreeString(
    ctx,
    path,
    discriminator,
    raw,
    `${discriminator} key must be non-empty (${keyNoun})`,
    (v) => `${discriminator} key "${v}" contains "/" — keys must be slash-free`,
  );
}

// [LAW:types-are-the-program] Each value source's payload as a field map — the
// non-`set` keys that source carries. `fields` runs every spec (reporting all
// issues) and fails the arm when a required field is absent or invalid; `refine`
// adds the cross-field invariants `fields` cannot express. The reconstructed
// payload IS the member minus `set`, which the dispatcher re-attaches.
const TO_FIELDS: FieldSpecMap<{ to: string }> = { to: setLiteralSpec() };
const FROM_FIELDS: FieldSpecMap<{ from: OptionDomain }> = { from: fromSpec() };
const BOUNDED_FIELDS: FieldSpecMap<{ min: number; max: number; by: number }> = {
  min: requireIntSpec(),
  max: requireIntSpec(),
  by: requireIntSpec(),
};
const INT_FIELDS: FieldSpecMap<{ int: true }> = { int: intMarkerSpec() };
const CYCLE_FIELDS: FieldSpecMap<{ cycle: readonly string[] }> = {
  cycle: cycleSpec(),
};

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

// [LAW:types-are-the-program] A value-source arm is its payload field map plus
// its refinements; `detect` (the non-discriminator keys whose presence
// selects it), `allowed` (those keys plus the discriminator, the unknown-key
// allow-list), and `label` (the source name in the exactly-one message — the
// detect keys joined by "/") all DERIVE from the field map, so the field set
// is the single source for what the arm parses, permits, and is named by.
// Parameterized by `discriminator` ("set" | "persist") so `set` and `persist`
// share the identical to/from/min-max-by/cycle shapes without duplicating
// their field maps — only the discriminator's NAME differs in the emitted
// object shape and the reconstructed member.
interface ValueSourceArm {
  readonly detect: readonly string[];
  readonly allowed: readonly string[];
  readonly label: string;
  // [LAW:one-source-of-truth] The arm's emit facet: the closed object schema
  // for this discriminator's value source — the discriminator key plus the
  // source's own fields, derived from the SAME field map `fields` validates.
  // Cross-field refinements (min<max, by≠0) are unexpressible in JSON Schema,
  // so only the structural shape is emitted.
  readonly json: JsonNode;
  readonly parse: ArmParse<Partial<ActionDecl>>;
}

function valueSourceArm<P extends object>(
  discriminator: "set" | "persist",
  fieldMap: FieldSpecMap<P>,
  ...checks: ReadonlyArray<Refinement<P>>
): ValueSourceArm {
  const detect = Object.keys(fieldMap);
  const inner: ArmParse<P> = (ctx, path, raw) =>
    fields(ctx, fieldMap, path, raw);
  const source = objectJson(fieldMap) as {
    properties: Record<string, JsonNode>;
    required?: readonly string[];
  };
  return {
    detect,
    allowed: [discriminator, ...detect],
    label: detect.join("/"),
    json: {
      type: "object",
      properties: { [discriminator]: { type: "string" }, ...source.properties },
      required: [discriminator, ...(source.required ?? [])],
      additionalProperties: false,
    },
    parse: (checks.length
      ? refine(inner, ...checks)
      : inner) as unknown as ArmParse<Partial<ActionDecl>>,
  };
}

// [LAW:dataflow-not-control-flow] The value-source arms in the order their
// labels appear in the exactly-one message. A `set` declares exactly one of
// these; the dispatcher counts presence over `detect` and reconstructs
// `{ set, ...payload }`.
const SET_ARMS: readonly ValueSourceArm[] = [
  valueSourceArm("set", TO_FIELDS),
  valueSourceArm("set", FROM_FIELDS),
  valueSourceArm("set", BOUNDED_FIELDS, minLessThanMax, byNonZero),
  valueSourceArm("set", INT_FIELDS),
  valueSourceArm("set", CYCLE_FIELDS),
];

// [LAW:one-type-per-behavior] `persist` mirrors `set` minus the `int` arm — a
// page cursor is a UI-only paging concept with no meaning as a persisted
// config default (see action.ts's ActionDecl comment).
const PERSIST_ARMS: readonly ValueSourceArm[] = [
  valueSourceArm("persist", TO_FIELDS),
  valueSourceArm("persist", FROM_FIELDS),
  valueSourceArm("persist", BOUNDED_FIELDS, minLessThanMax, byNonZero),
  valueSourceArm("persist", CYCLE_FIELDS),
];

const VALUE_SOURCE_MESSAGE = (discriminator: "set" | "persist") =>
  `a ${discriminator} action declares exactly one value source: "to" (a literal value), "from" (an option domain — a registered domain name like "themes"/"styles"/"looks", or an inline array of literal values), "min"/"max"/"by" (a bounded step)${discriminator === "set" ? `, "int" (an unbounded integer cursor)` : ""}, or "cycle" (an enumerated domain stepped in order)`;

// [LAW:dataflow-not-control-flow] The set/persist sub-union eliminator:
// validate the shared discriminator key, count which value sources are
// present, require exactly one, reject keys outside that arm's allow-list,
// parse the payload, reconstruct the member. The variability (which arms,
// each arm's fields/refinements/allow-list) is the `arms` data; the only
// branches are the presence-count and the null-threading both the key and
// the payload share.
function valueSourceAction(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  discriminator: "set" | "persist",
  arms: readonly ValueSourceArm[],
  keyNoun: string,
): ActionDecl | null {
  const stateKey = validateValueSourceKey(
    ctx,
    path,
    raw,
    discriminator,
    keyNoun,
  );

  const present = arms.filter((arm) => arm.detect.some((k) => k in raw));
  if (present.length !== 1) {
    issue(
      ctx,
      path,
      `${VALUE_SOURCE_MESSAGE(discriminator)}${
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
        `Unknown key "${k}" on this ${discriminator} action. Expected one of: ${arm.allowed.join(", ")}`,
      );
  }

  const payload = arm.parse(ctx, path, raw);
  return stateKey === null || payload === null
    ? null
    : ({ [discriminator]: stateKey, ...payload } as unknown as ActionDecl);
}

// [LAW:no-silent-fallbacks] A literal `to` and the `set` key share the
// non-empty/slash-free shape — the set-state wire rejects empty values and splits
// on "/", so either is undeliverable. The empty/slash messages are this arm's,
// the shape is the shared enforcer's.
function setLiteralSpec(): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string" },
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

// [LAW:types-are-the-program] `from` is either a NAME (a non-empty string,
// resolved against the option-domain registry) or an INLINE literal domain (a
// non-empty array of deliverable set-state values — the same non-empty/
// slash-free wire shape `to` and `cycle` members enforce, plus the same
// uniqueness `cycleSpec` requires: a duplicate has no successor-ambiguity
// concern here, but it would render the same picker cell twice for no
// benefit). This arm proves only the SHAPE; whether a named domain actually
// resolves needs the merged config's per-config domains (e.g. "looks"), so
// that check is a cross-reference concern (validateCrossReferences) —
// symmetric to how a layout node's segment ref or a `{{ action }}` ref
// resolves post-merge.
function fromSpec(): FieldSpec<OptionDomain> {
  return {
    required: true,
    json: {
      anyOf: [
        { type: "string", minLength: 1 },
        {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          uniqueItems: true,
        },
      ],
    },
    parse: (ctx, path, field, raw) => {
      const from = raw[field];
      const at = `${path}.${field}`;
      if (typeof from === "string") {
        if (from === "") {
          issue(ctx, at, `from must be a non-empty domain name`);
          return undefined;
        }
        return from;
      }
      if (Array.isArray(from) && from.every((m) => typeof m === "string")) {
        const members = from as string[];
        if (members.length === 0) {
          issue(
            ctx,
            at,
            `from must name a domain (a non-empty string) or declare an inline domain (a non-empty array of values)`,
          );
          return undefined;
        }
        if (members.some((m) => m === "")) {
          issue(
            ctx,
            at,
            `from array members must be non-empty — an empty value cannot be delivered on the set-state wire`,
          );
          return undefined;
        }
        const slashed = members.filter((m) => m.includes("/"));
        if (slashed.length > 0) {
          issue(
            ctx,
            at,
            `from array member(s) ${slashed.map((m) => `"${m}"`).join(", ")} contain "/" — set values must be slash-free`,
          );
          return undefined;
        }
        if (new Set(members).size !== members.length) {
          issue(
            ctx,
            at,
            `from array members must be unique — a duplicated value would render the same picker option twice`,
          );
          return undefined;
        }
        return members;
      }
      issue(
        ctx,
        at,
        `from must be a domain name (a string) or an inline domain (an array of strings), got ${describeValue(from)}`,
      );
      return undefined;
    },
  };
}

// [LAW:types-are-the-program] `cycle` is the enumerated domain a click steps
// through: at least two members (one member has no successor to step to — that
// is a literal `to`), each a deliverable set-state value (non-empty, slash-free
// — the same wire shape `to` enforces), no duplicates (the successor of a
// duplicated member is ambiguous). Members double as the derived allow-list
// gate, so a member this spec admits is a value the wire delivers, by
// construction.
function cycleSpec(): FieldSpec<readonly string[]> {
  return {
    required: true,
    json: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 2,
      uniqueItems: true,
    },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      const at = `${path}.${field}`;
      if (!Array.isArray(v) || v.some((m) => typeof m !== "string")) {
        issue(
          ctx,
          at,
          `cycle must be an array of strings (the enumerated values a click steps through), got ${describeType(v)}`,
        );
        return undefined;
      }
      const members = v as string[];
      if (members.length < 2) {
        issue(
          ctx,
          at,
          `cycle needs at least two members (one member has no successor — use a literal "to")`,
        );
        return undefined;
      }
      const empty = members.some((m) => m === "");
      const slashed = members.filter((m) => m.includes("/"));
      if (empty) {
        issue(
          ctx,
          at,
          `cycle members must be non-empty — an empty value cannot be delivered on the set-state wire`,
        );
        return undefined;
      }
      if (slashed.length > 0) {
        issue(
          ctx,
          at,
          `cycle member(s) ${slashed.map((m) => `"${m}"`).join(", ")} contain "/" — set values must be slash-free`,
        );
        return undefined;
      }
      if (new Set(members).size !== members.length) {
        issue(
          ctx,
          at,
          `cycle members must be unique — the successor of a duplicated member is ambiguous`,
        );
        return undefined;
      }
      return members;
    },
  };
}

// [LAW:no-silent-fallbacks] `int` is a marker, not a value — it declares the key
// an unbounded-integer cursor. Only the literal `true` is meaningful; anything
// else is a typo to surface, not silently coerce.
function intMarkerSpec(): FieldSpec<true> {
  return {
    required: true,
    json: { const: true },
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
    json: { type: "integer" },
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
