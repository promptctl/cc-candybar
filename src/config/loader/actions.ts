// [LAW:types-are-the-program] Exactly-one-of set/persist/copy/open/reset + one SOURCE.
// [LAW:no-mode-explosion] Arms are multi-key RECORDS; this file owns only the dispatch.

import {
  ACTION_KEYS,
  PERSIST_WHEN,
  type ActionDecl,
  type ActionKey,
  type OptionDomain,
} from "../action.js";
import { findKeyLine } from "./diagnostics.js";
import { CHECKS, checkByName } from "../../doctor/checks.js";
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

// [LAW:locality-or-seam] Shape only; whether a ref resolves is a cross-ref concern.
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
  // [LAW:types-are-the-program] Null-prototype: "__proto__" is an own property.
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

// [LAW:single-enforcer] The one place that resolves a path to a source line.
function issue(ctx: ValidateCtx, path: string, message: string): void {
  ctx.issues.push({
    path,
    message,
    line: findKeyLine(ctx.source, path.split(".")),
  });
}

// [LAW:dataflow-not-control-flow] Each arm owns its siblings; this level rejects none.
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
  // [LAW:dataflow-not-control-flow] `persistWhen` is a dual's own discriminator.
  if (PERSIST_WHEN in raw) {
    return valueSourceAction(ctx, path, raw, "dual", DUAL_ARMS);
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

// [LAW:dataflow-not-control-flow] The arm table as DATA, indexed by present key.
const ACTION_ARMS: Record<ActionKey, ArmParse<ActionDecl>> = {
  set: (ctx, path, raw) => valueSourceAction(ctx, path, raw, "set", SET_ARMS),
  persist: (ctx, path, raw) =>
    valueSourceAction(ctx, path, raw, "persist", PERSIST_ARMS),
  copy: templateArm("copy"),
  open: templateArm("open"),
  reset: resetArm,
  undo: markerArm("undo"),
  redo: markerArm("redo"),
  doctor: doctorArm,
};

// [LAW:one-source-of-truth] Emits the closed object `templateArm(key)` validates.
function templateArmJson(key: "copy" | "open" | "reset"): JsonNode {
  return {
    type: "object",
    properties: { [key]: { type: "string" } },
    required: [key],
    additionalProperties: false,
  };
}

// [LAW:one-source-of-truth] The SAME members `validateActionDecl` dispatches over.
function actionDeclJson(): JsonNode {
  return {
    anyOf: [
      ...SET_ARMS.map((arm) => arm.json),
      ...PERSIST_ARMS.map((arm) => arm.json),
      ...DUAL_ARMS.map((arm) => arm.json),
      templateArmJson("copy"),
      templateArmJson("open"),
      templateArmJson("reset"),
      markerArmJson("undo"),
      markerArmJson("redo"),
      ...doctorArmJson(),
    ],
  };
}

export function actionsJson(): JsonNode {
  return { type: "object", additionalProperties: actionDeclJson() };
}

// [LAW:one-type-per-behavior] copy and open are one behavior parameterized by key.
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

// [LAW:one-type-per-behavior] A config globals KEY, not a template; hoisted for ACTION_ARMS.
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

// [LAW:one-type-per-behavior] A marker: the history is one stack per config file.
function markerArm(key: "undo" | "redo"): ArmParse<ActionDecl> {
  return (ctx, path, raw) => {
    for (const k of Object.keys(raw)) {
      if (k !== key)
        issue(
          ctx,
          `${path}.${k}`,
          `Unknown key "${k}" on a ${key} action. Expected only: ${key}`,
        );
    }
    if (raw[key] !== true) {
      issue(
        ctx,
        `${path}.${key}`,
        `${key} must be the literal true (it takes no key — it steps the history of the session's config file), got ${describeValue(raw[key])}`,
      );
      return null;
    }
    return { [key]: true } as unknown as ActionDecl;
  };
}

// [LAW:one-source-of-truth] A marker action carries no data, on the wire or here.
function markerArmJson(key: "undo" | "redo"): JsonNode {
  return {
    type: "object",
    properties: { [key]: { const: true } },
    required: [key],
    additionalProperties: false,
  };
}

// [LAW:types-are-the-program] Gated against the CHECKS the wire uses: unknown = load error.
function doctorArm(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionDecl | null {
  const verb = raw.doctor;
  const allowed = verb === "run" ? ["doctor"] : ["doctor", "check"];
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k))
      issue(
        ctx,
        `${path}.${k}`,
        `Unknown key "${k}" on a doctor action. Expected only: ${allowed.join(", ")}`,
      );
  }
  if (verb !== "run" && verb !== "fix") {
    issue(
      ctx,
      `${path}.doctor`,
      `doctor must be "run" or "fix", got ${describeValue(verb)}`,
    );
    return null;
  }
  if (verb === "run") return { doctor: "run" };
  const check = raw.check;
  if (typeof check !== "string" || checkByName(check) === undefined) {
    issue(
      ctx,
      `${path}.check`,
      `doctor fix must name a check (have: ${CHECKS.map((c) => c.name).join(", ")}), got ${describeValue(check)}`,
    );
    return null;
  }
  return { doctor: "fix", check };
}

// [LAW:one-source-of-truth] The two arms `doctorArm` parses, over the same CHECKS.
function doctorArmJson(): readonly JsonNode[] {
  return [
    {
      type: "object",
      properties: { doctor: { const: "run" } },
      required: ["doctor"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        doctor: { const: "fix" },
        check: { enum: CHECKS.map((c) => c.name) },
      },
      required: ["doctor", "check"],
      additionalProperties: false,
    },
  ];
}

// ─── The `set` value-source sub-union ────────────────────────────────────────

// [LAW:single-enforcer] The wire is a slash-delimited run, so either is undeliverable.
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

// [LAW:types-are-the-program] Which KEYS an action carries beside its value source.
// [LAW:dataflow-not-control-flow] A discriminator is a LIST of keys, folded over.
type Discriminator = "set" | "persist" | "dual";

const DISCRIMINATOR_KEYS: Readonly<
  Record<Discriminator, ReadonlyArray<readonly [string, string]>>
> = {
  set: [["set", "the SessionState key to write"]],
  persist: [["persist", "the config globals field to write"]],
  dual: [
    ["set", "the SessionState key written while persistWhen is off"],
    ["persist", "the config globals field written while persistWhen is on"],
    [
      PERSIST_WHEN,
      "the SessionState key whose boolean value chooses the destination",
    ],
  ],
};

// [LAW:dataflow-not-control-flow] Before the source is detected, so both surface at once.
// [LAW:no-silent-failure] Null when ANY key fails, so a partly-valid dual never lands.
function validateDiscriminatorKeys(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  discriminator: Discriminator,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  const keys = DISCRIMINATOR_KEYS[discriminator];
  let ok = true;
  for (const [key, noun] of keys) {
    // [LAW:no-silent-failure] Only a half-declared dual reaches here: give it the shape.
    if (!(key in raw)) {
      issue(
        ctx,
        path,
        `${key} is required here (${noun}) — a dual-destination action declares ${keys
          .map(([k]) => k)
          .join(", ")} together, plus one value source`,
      );
      ok = false;
      continue;
    }
    const value = slashFreeString(
      ctx,
      path,
      key,
      raw,
      `${key} key must be non-empty (${noun})`,
      (v) => `${key} key "${v}" contains "/" — keys must be slash-free`,
    );
    if (value === null) {
      ok = false;
      continue;
    }
    out[key] = value;
  }
  return ok ? out : null;
}

// [LAW:one-source-of-truth] Threaded into the shared specs so messages name the wire.
function wireName(discriminator: Discriminator): string {
  if (discriminator === "set") return "set-state";
  return discriminator === "persist" ? "set-config" : "set-state/set-config";
}

// [LAW:types-are-the-program] The member minus the discriminator the dispatcher re-attaches.
const TO_FIELDS_SET: FieldSpecMap<{ to: string }> = {
  to: setLiteralSpec("set"),
};
const TO_FIELDS_PERSIST: FieldSpecMap<{ to: string }> = {
  to: setLiteralSpec("persist"),
};
const FROM_FIELDS_SET: FieldSpecMap<{ from: OptionDomain }> = {
  from: fromSpec("set"),
};
const FROM_FIELDS_PERSIST: FieldSpecMap<{ from: OptionDomain }> = {
  from: fromSpec("persist"),
};
const BOUNDED_FIELDS: FieldSpecMap<{ min: number; max: number; by: number }> = {
  min: requireIntSpec(),
  max: requireIntSpec(),
  by: requireIntSpec(),
};
const INT_FIELDS: FieldSpecMap<{ int: true }> = { int: intMarkerSpec() };
const CYCLE_FIELDS_SET: FieldSpecMap<{ cycle: readonly string[] }> = {
  cycle: cycleSpec("set"),
};
const TO_FIELDS_DUAL: FieldSpecMap<{ to: string }> = {
  to: setLiteralSpec("dual"),
};
const FROM_FIELDS_DUAL: FieldSpecMap<{ from: OptionDomain }> = {
  from: fromSpec("dual"),
};
const CYCLE_FIELDS_DUAL: FieldSpecMap<{ cycle: readonly string[] }> = {
  cycle: cycleSpec("dual"),
};
const CYCLE_FIELDS_PERSIST: FieldSpecMap<{ cycle: readonly string[] }> = {
  cycle: cycleSpec("persist"),
};
// [LAW:one-type-per-behavior] The structural-edit arms are PERSIST-only.
const REMOVE_SEGMENT_FIELDS: FieldSpecMap<{ removeSegment: string }> = {
  removeSegment: layoutNameSpec("removeSegment"),
};
const INSERT_SEGMENT_FIELDS: FieldSpecMap<{
  insertSegment: string;
  anchor: string;
  relation: "before" | "after";
}> = {
  insertSegment: layoutNameSpec("insertSegment"),
  anchor: layoutNameSpec("anchor"),
  relation: relationSpec(),
};
// [LAW:one-type-per-behavior] `insertSegment`'s payload, segment name as a `from` domain.
const INSERT_SEGMENT_FROM_FIELDS: FieldSpecMap<{
  insertSegmentFrom: OptionDomain;
  anchor: string;
  relation: "before" | "after";
}> = {
  insertSegmentFrom: fromSpec("persist"),
  anchor: layoutNameSpec("anchor"),
  relation: relationSpec(),
};

// [LAW:types-are-the-program] The cross-field invariants `fields` cannot express.
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

// [LAW:types-are-the-program] `detect`/`allowed`/`label` all DERIVE from the field map.
interface ValueSourceArm {
  readonly detect: readonly string[];
  readonly allowed: readonly string[];
  readonly label: string;
  // [LAW:one-source-of-truth] The SAME field map `fields` validates, shape only.
  readonly json: JsonNode;
  readonly parse: ArmParse<Partial<ActionDecl>>;
}

// [LAW:no-mode-explosion] Pass `detectKeys` only when an arm shares fields with a sibling.
function valueSourceArm<P extends object>(
  discriminator: Discriminator,
  fieldMap: FieldSpecMap<P>,
  checks: ReadonlyArray<Refinement<P>> = [],
  detectKeys?: readonly string[],
): ValueSourceArm {
  const fullKeys = Object.keys(fieldMap);
  const detect = detectKeys ?? fullKeys;
  const keys = DISCRIMINATOR_KEYS[discriminator].map(([k]) => k);
  const inner: ArmParse<P> = (ctx, path, raw) =>
    fields(ctx, fieldMap, path, raw);
  const source = objectJson(fieldMap) as {
    properties: Record<string, JsonNode>;
    required?: readonly string[];
  };
  return {
    detect,
    allowed: [...keys, ...fullKeys],
    label: fullKeys.join("/"),
    json: {
      type: "object",
      properties: {
        ...Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
        ...source.properties,
      },
      required: [...keys, ...(source.required ?? [])],
      additionalProperties: false,
    },
    parse: (checks.length
      ? refine(inner, ...checks)
      : inner) as unknown as ArmParse<Partial<ActionDecl>>,
  };
}

// [LAW:dataflow-not-control-flow] Ordered as their labels appear in the message.
const SET_ARMS: readonly ValueSourceArm[] = [
  valueSourceArm("set", TO_FIELDS_SET),
  valueSourceArm("set", FROM_FIELDS_SET),
  valueSourceArm("set", BOUNDED_FIELDS, [minLessThanMax, byNonZero]),
  valueSourceArm("set", INT_FIELDS),
  valueSourceArm("set", CYCLE_FIELDS_SET),
];

// [LAW:one-type-per-behavior] `set` minus `int`, plus the persist-only structural edits.
const PERSIST_ARMS: readonly ValueSourceArm[] = [
  valueSourceArm("persist", TO_FIELDS_PERSIST),
  valueSourceArm("persist", FROM_FIELDS_PERSIST),
  valueSourceArm("persist", BOUNDED_FIELDS, [minLessThanMax, byNonZero]),
  valueSourceArm("persist", CYCLE_FIELDS_PERSIST),
  valueSourceArm("persist", REMOVE_SEGMENT_FIELDS),
  // [LAW:no-mode-explosion] They share "anchor"/"relation", so each must narrow detect.
  valueSourceArm("persist", INSERT_SEGMENT_FIELDS, [], ["insertSegment"]),
  valueSourceArm(
    "persist",
    INSERT_SEGMENT_FROM_FIELDS,
    [],
    ["insertSegmentFrom"],
  ),
];

// [LAW:one-type-per-behavior] Only value sources BOTH destinations share.
const DUAL_ARMS: readonly ValueSourceArm[] = [
  valueSourceArm("dual", TO_FIELDS_DUAL),
  valueSourceArm("dual", FROM_FIELDS_DUAL),
  valueSourceArm("dual", BOUNDED_FIELDS, [minLessThanMax, byNonZero]),
  valueSourceArm("dual", CYCLE_FIELDS_DUAL),
];

// [LAW:one-source-of-truth] The clause LIST varies; the "or" rides on whichever is last.
function valueSourceClauses(discriminator: Discriminator): string[] {
  const clauses = [
    `"to" (a literal value)`,
    `"from" (an option domain — a registered domain name like "themes"/"styles"/"looks", or an inline array of literal values)`,
    `"min"/"max"/"by" (a bounded step)`,
  ];
  if (discriminator === "set")
    clauses.push(`"int" (an unbounded integer cursor)`);
  clauses.push(`"cycle" (an enumerated domain stepped in order)`);
  if (discriminator === "persist") {
    clauses.push(
      `"removeSegment" (remove a named segment from the layout)`,
      `"insertSegment"/"anchor"/"relation" (insert a named segment before/after an existing one)`,
      `"insertSegmentFrom"/"anchor"/"relation" (insert a segment PICKED from an option domain before/after an existing one)`,
    );
  }
  return clauses;
}

function VALUE_SOURCE_MESSAGE(discriminator: Discriminator): string {
  const clauses = valueSourceClauses(discriminator);
  const last = clauses[clauses.length - 1]!;
  const list =
    clauses.length === 1
      ? last
      : `${clauses.slice(0, -1).join(", ")}, or ${last}`;
  return `a ${discriminator} action declares exactly one value source: ${list}`;
}

// [LAW:dataflow-not-control-flow] Variability lives in the `arms` data, not in branches.
function valueSourceAction(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  discriminator: Discriminator,
  arms: readonly ValueSourceArm[],
): ActionDecl | null {
  const keys = validateDiscriminatorKeys(ctx, path, raw, discriminator);

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
  return keys === null || payload === null
    ? null
    : ({ ...keys, ...payload } as unknown as ActionDecl);
}

// [LAW:no-silent-fallbacks] The wire rejects empty values and splits on "/".
function setLiteralSpec(discriminator: Discriminator): FieldSpec<string> {
  const wire = wireName(discriminator);
  return {
    required: true,
    json: { type: "string" },
    parse: (ctx, path, field, raw) =>
      slashFreeString(
        ctx,
        path,
        field,
        raw,
        `${discriminator} value must be non-empty — an empty value cannot be delivered on the ${wire} wire`,
        (v) =>
          `${discriminator} value "${v}" contains "/" — ${discriminator} values must be slash-free`,
      ) ?? undefined,
  };
}

// [LAW:types-are-the-program] A domain NAME or an INLINE array; shape, not resolution.
function fromSpec(discriminator: Discriminator): FieldSpec<OptionDomain> {
  const wire = wireName(discriminator);
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
          issue(ctx, at, `${field} must be a non-empty domain name`);
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
            `${field} must name a domain (a non-empty string) or declare an inline domain (a non-empty array of values)`,
          );
          return undefined;
        }
        if (members.some((m) => m === "")) {
          issue(
            ctx,
            at,
            `${field} array members must be non-empty — an empty value cannot be delivered on the ${wire} wire`,
          );
          return undefined;
        }
        const slashed = members.filter((m) => m.includes("/"));
        if (slashed.length > 0) {
          issue(
            ctx,
            at,
            `${field} array member(s) ${slashed.map((m) => `"${m}"`).join(", ")} contain "/" — ${discriminator} values must be slash-free`,
          );
          return undefined;
        }
        if (new Set(members).size !== members.length) {
          issue(
            ctx,
            at,
            `${field} array members must be unique — a duplicated value would render the same picker option twice`,
          );
          return undefined;
        }
        return members;
      }
      issue(
        ctx,
        at,
        `${field} must be a domain name (a string) or an inline domain (an array of strings), got ${describeValue(from)}`,
      );
      return undefined;
    },
  };
}

// [LAW:types-are-the-program] Two or more, unique; these members ARE the derived gate.
function cycleSpec(discriminator: Discriminator): FieldSpec<readonly string[]> {
  const wire = wireName(discriminator);
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
          `cycle members must be non-empty — an empty value cannot be delivered on the ${wire} wire`,
        );
        return undefined;
      }
      if (slashed.length > 0) {
        issue(
          ctx,
          at,
          `cycle member(s) ${slashed.map((m) => `"${m}"`).join(", ")} contain "/" — ${discriminator} values must be slash-free`,
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

// [LAW:no-silent-fallbacks] A marker, not a value; anything else is a typo.
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

// [LAW:one-source-of-truth] Free of `/` (click wire) and `:` (layout-ops); one spec.
function layoutNameSpec(field: string): FieldSpec<string> {
  return {
    required: true,
    json: { type: "string" },
    parse: (ctx, path, f, raw) => {
      const v = requireString(ctx, path, raw, f);
      if (v === null) return undefined;
      const at = `${path}.${f}`;
      if (v === "") {
        issue(ctx, at, `${field} must be non-empty (a segment name)`);
        return undefined;
      }
      if (v.includes("/") || v.includes(":")) {
        issue(
          ctx,
          at,
          `${field} "${v}" contains "/" or ":" — segment names in a layout op must be free of both (the click wire's own delimiter and layout-ops.ts's op-token delimiter)`,
        );
        return undefined;
      }
      return v;
    },
  };
}

// [LAW:types-are-the-program] A closed enum, so a typo is a load error.
function relationSpec(): FieldSpec<"before" | "after"> {
  return {
    required: true,
    json: { enum: ["before", "after"] },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v !== "before" && v !== "after") {
        issue(
          ctx,
          `${path}.${field}`,
          `relation must be "before" or "after", got ${describeValue(v)}`,
        );
        return undefined;
      }
      return v;
    },
  };
}

// [LAW:types-are-the-program] A required integer field; the key comes from the map.
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
