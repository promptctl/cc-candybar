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
  type OptionSource,
} from "../action.js";
import nodePath from "node:path";
import { findKeyLine } from "./diagnostics.js";
import {
  CHECKS,
  GLYPH_MARKS,
  MARKED_CHECKS,
  type Check,
  type GlyphMark,
} from "../../doctor/checks.js";
import {
  parseSlashLine,
  SLASH_LINE_PATTERN,
} from "../../claude-input/slash-line.js";
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
  home: ActionHome,
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
    const parsed = validateActionDecl(ctx, `actions.${name}`, decl, home);
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
  home: ActionHome,
): ActionDecl | null {
  if (!isPlainObject(raw)) {
    issue(
      ctx,
      path,
      `${path} must be an action object, got ${describeType(raw)}`,
    );
    return null;
  }
  // [LAW:no-silent-failure] The removed dual arm names its replacement, as
  // every removed grammar does, rather than the generic arity error below.
  if ("persistWhen" in raw) {
    issue(
      ctx,
      path,
      `${path}.persistWhen was removed: declare the \`set\` alone — a session pick is a draft until a \`{ save: true }\` action writes every unsaved setting to the config file`,
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
  return actionArms(home)[present[0] as ActionKey](ctx, path, raw);
}

// [LAW:types-are-the-program] Where an action table is declared: the directory
// of the file that declares it, which a `run` declared there runs in, or a
// text no file holds (the bundled default), named for the error a `run` there
// is — it has no directory to run in.
export type ActionHome = { readonly dir: string } | { readonly text: string };

// The home of a table parsed from `filePath`: a file's directory when it is
// one, else the text's name (a label in angle brackets names no file).
export function actionHomeOf(filePath: string): ActionHome {
  return nodePath.isAbsolute(filePath)
    ? { dir: nodePath.dirname(filePath) }
    : { text: filePath };
}

// [LAW:dataflow-not-control-flow] The top-level arm table as DATA: copy/open share
// one template-arm shape (their key names the only difference); set/persist
// delegate to their value-source sub-union (the SAME field shapes, a different
// discriminator key — see valueSourceAction); reset is copy/open's plain-string
// sibling. The present key indexes this map — the eliminator never branches on
// the key name.
const actionArms = (
  home: ActionHome,
): Record<ActionKey, ArmParse<ActionDecl>> => ({
  set: (ctx, path, raw) => valueSourceAction(ctx, path, raw, "set", SET_ARMS),
  persist: (ctx, path, raw) =>
    valueSourceAction(ctx, path, raw, "persist", PERSIST_ARMS),
  copy: templateArm("copy"),
  open: templateArm("open"),
  reset: resetArm,
  undo: markerArm("undo"),
  redo: markerArm("redo"),
  back: markerArm("back"),
  rewind: markerArm("rewind"),
  save: markerArm("save"),
  preset: presetArm,
  themeDefault: themeDefaultArm,
  doctor: doctorArm,
  slash: slashArm,
  run: runArm(home),
  do: doArm,
});

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
      markerArmJson("undo"),
      markerArmJson("redo"),
      markerArmJson("back"),
      markerArmJson("rewind"),
      markerArmJson("save"),
      ...presetArmJson(),
      THEME_DEFAULT_ARM_JSON,
      ...doctorArmJson(),
      SLASH_ARM_JSON,
      RUN_ARM_JSON,
      DO_ARM_JSON,
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
// arrow) so it is hoisted — actionArms above references it directly, not
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

// [LAW:one-type-per-behavior] `undo`/`redo`/`save` are copy/open/reset's shape
// one step further reduced: a single required key whose only legal VALUE is
// the literal `true` (mirrors intMarkerSpec — a marker, not data), because
// there is no key to name: the history they step is one stack per session, and
// the settings a save writes are the session's own drafts. `function`, not a
// const arrow, so actionArms above (built before this declaration in source
// order) can reference it directly via hoisting.
type MarkerKey = "undo" | "redo" | "back" | "rewind" | "save";
const MARKER_SUBJECT: Record<MarkerKey, string> = {
  undo: "it steps the session's settings history",
  redo: "it steps the session's settings history",
  back: "it steps the session's navigation history",
  rewind:
    "it steps the session's settings history back to where edit mode opened",
  save: "it saves the session's unsaved settings",
};
function markerArm(key: MarkerKey): ArmParse<ActionDecl> {
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
        `${key} must be the literal true (it takes no key — ${MARKER_SUBJECT[key]}), got ${describeValue(raw[key])}`,
      );
      return null;
    }
    return { [key]: true } as unknown as ActionDecl;
  };
}

// [LAW:one-source-of-truth] Mirrors templateArmJson's shape one level
// narrower: the value schema is `const: true`, not `type: string` — a
// marker action carries no data, on the wire or in the schema.
function markerArmJson(key: MarkerKey): JsonNode {
  return {
    type: "object",
    properties: { [key]: { const: true } },
    required: [key],
    additionalProperties: false,
  };
}

// [LAW:types-are-the-program] `preset` (brandon-save-undo-bwi.o6u) is the
// doctor's shape: `"save"` alone, or `"delete"` with the `name` it removes — a
// template, so its preset can be the one the bar is in. `function`, not a
// const arrow, so actionArms above can reference it directly via hoisting.
function presetArm(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionDecl | null {
  const verb = raw.preset;
  const allowed = verb === "save" ? ["preset"] : ["preset", "name"];
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k))
      issue(
        ctx,
        `${path}.${k}`,
        `Unknown key "${k}" on a preset action. Expected only: ${allowed.join(", ")}`,
      );
  }
  if (verb !== "save" && verb !== "delete") {
    issue(
      ctx,
      `${path}.preset`,
      `preset must be "save" or "delete", got ${describeValue(verb)}`,
    );
    return null;
  }
  if (verb === "save") return { preset: "save" };
  const name = requireString(ctx, path, raw, "name");
  return name === null ? null : { preset: "delete", name };
}

function presetArmJson(): readonly JsonNode[] {
  return [
    {
      type: "object",
      properties: { preset: { const: "save" } },
      required: ["preset"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { preset: { const: "delete" }, name: { type: "string" } },
      required: ["preset", "name"],
      additionalProperties: false,
    },
  ];
}

// [LAW:types-are-the-program] `themeDefault` (candybar-theme-colours-6fq5.ix8)
// is `preset: "save"`'s shape with nothing beside it: one verb, `"save"`, and
// no other key — which theme and which look are the daemon's to read at click
// time. `function`, not a const arrow, so actionArms above can reference it
// directly via hoisting.
function themeDefaultArm(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionDecl | null {
  for (const k of Object.keys(raw)) {
    if (k !== "themeDefault")
      issue(
        ctx,
        `${path}.${k}`,
        `Unknown key "${k}" on a themeDefault action. Expected only: themeDefault`,
      );
  }
  if (raw.themeDefault !== "save") {
    issue(
      ctx,
      `${path}.themeDefault`,
      `themeDefault must be "save" (it saves the look the session draws as the active theme's default), got ${describeValue(raw.themeDefault)}`,
    );
    return null;
  }
  return { themeDefault: "save" };
}

const THEME_DEFAULT_ARM_JSON: JsonNode = {
  type: "object",
  properties: { themeDefault: { const: "save" } },
  required: ["themeDefault"],
  additionalProperties: false,
};

// [LAW:types-are-the-program] `doctor` (brandon-doctor-b6a) is a three-member
// enum on its own key — `"run"` alone, `"fix"` with the `check` it repairs,
// or `"mark"` with the `check` whose glyphs were looked at and the `mark`
// made on them. The check name is gated HERE against `CHECKS`
// (src/doctor/checks.ts), the same list the daemon's doctor verbs gate the
// wire against, so an authored `[fix]` over a check that does not exist is a
// load error naming the ones that do, never a click-time BAD_REQUEST.
// `function`, not a const arrow, so actionArms above can reference it
// directly via hoisting.
const DOCTOR_KEYS: Readonly<Record<string, readonly string[]>> = {
  run: ["doctor"],
  fix: ["doctor", "check"],
  mark: ["doctor", "check", "mark"],
};

function doctorArm(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionDecl | null {
  const verb = raw.doctor;
  const known = typeof verb === "string" && Object.hasOwn(DOCTOR_KEYS, verb);
  // Every failing key is reported before returning, like the sibling arms —
  // against the verb's own keys, or every doctor key when the verb is bad.
  const allowed = known
    ? DOCTOR_KEYS[verb]!
    : [...new Set(Object.values(DOCTOR_KEYS).flat())];
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k))
      issue(
        ctx,
        `${path}.${k}`,
        `Unknown key "${k}" on a doctor action. Expected only: ${allowed.join(", ")}`,
      );
  }
  if (!known) {
    issue(
      ctx,
      `${path}.doctor`,
      `doctor must be ${Object.keys(DOCTOR_KEYS)
        .map((v) => `"${v}"`)
        .join(", ")}, got ${describeValue(verb)}`,
    );
    return null;
  }
  if (verb === "run") return { doctor: "run" };
  const check = raw.check;
  // A mark names a check that takes one; a fix may name any.
  const nameable = verb === "mark" ? MARKED_CHECKS : CHECKS;
  if (typeof check !== "string" || !nameable.some((c) => c.name === check)) {
    issue(
      ctx,
      `${path}.check`,
      `doctor ${verb} must name a check (have: ${nameable.map((c) => c.name).join(", ")}), got ${describeValue(check)}`,
    );
    return null;
  }
  if (verb === "fix") return { doctor: "fix", check };
  const mark = raw.mark;
  if (!(GLYPH_MARKS as readonly unknown[]).includes(mark)) {
    issue(
      ctx,
      `${path}.mark`,
      `doctor mark must be ${GLYPH_MARKS.map((m) => `"${m}"`).join(" or ")}, got ${describeValue(mark)}`,
    );
    return null;
  }
  return { doctor: "mark", check, mark: mark as GlyphMark };
}

// [LAW:parse-dont-validate] `slash` is the one place a line to type becomes a
// SlashLine (src/claude-input/slash-line.ts); the verb and the edge take
// nothing else. `function`, not a const arrow, so actionArms can reference it.
function slashArm(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionDecl | null {
  for (const k of Object.keys(raw)) {
    if (k !== "slash")
      issue(
        ctx,
        `${path}.${k}`,
        `Unknown key "${k}" on a slash action. Expected only: slash`,
      );
  }
  const parsed = parseSlashLine(raw.slash);
  if (parsed.kind === "refused") {
    issue(ctx, `${path}.slash`, parsed.reason);
    return null;
  }
  return { slash: parsed.line };
}

const SLASH_ARM_JSON: JsonNode = {
  type: "object",
  properties: { slash: { type: "string", pattern: SLASH_LINE_PATTERN } },
  required: ["slash"],
  additionalProperties: false,
};

// [LAW:types-are-the-program] `run` is a program and its arguments — one
// template each, with no shell between — the variables laid over the
// session's process environment, each value a template, and the declared
// sources the program writes. `env` and `refreshes` may be left out: none is
// an empty table. Whether each `refreshes` name is a declared source needs the
// merged config, so it is a cross-ref concern (validateDeclarations). The
// declaring file's directory is recorded here, as the directory the program
// runs in.
const RUN_KEYS = ["run", "env", "refreshes"];
// An environment variable's name as a shell spells one.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function runArm(home: ActionHome): ArmParse<ActionDecl> {
  return (ctx, path, raw) => {
    for (const k of Object.keys(raw)) {
      if (!RUN_KEYS.includes(k))
        issue(
          ctx,
          `${path}.${k}`,
          `Unknown key "${k}" on a run action. Expected only: ${RUN_KEYS.join(", ")}`,
        );
    }
    const before = ctx.issues.length;
    const run = raw.run;
    if (
      !Array.isArray(run) ||
      run.length === 0 ||
      run.some((item) => typeof item !== "string") ||
      run[0] === ""
    ) {
      issue(
        ctx,
        `${path}.run`,
        `run must list the program and its arguments, each a template string, the program first and not empty, got ${describeValue(run)}`,
      );
    }
    const env = raw.env ?? {};
    if (
      !isPlainObject(env) ||
      Object.entries(env).some(
        ([name, value]) => !ENV_NAME.test(name) || typeof value !== "string",
      )
    ) {
      issue(
        ctx,
        `${path}.env`,
        `env must map variable names (letters, digits and _, not starting with a digit) to template strings, got ${describeValue(env)}`,
      );
    }
    const refreshes = raw.refreshes ?? [];
    if (
      !Array.isArray(refreshes) ||
      refreshes.some((name) => typeof name !== "string" || name === "")
    ) {
      issue(
        ctx,
        `${path}.refreshes`,
        `refreshes must list the names of the sources the program writes, got ${describeValue(refreshes)}`,
      );
    }
    if (!("dir" in home)) {
      issue(
        ctx,
        `${path}.run`,
        `a run action runs in the directory of the file that declares it, and ${home.text} is no file`,
      );
    }
    if (ctx.issues.length > before || !("dir" in home)) return null;
    return {
      run: run as [string, ...string[]],
      env: env as Record<string, string>,
      refreshes: refreshes as string[],
      cwd: home.dir,
    };
  };
}

const RUN_ARM_JSON: JsonNode = {
  type: "object",
  properties: {
    run: { type: "array", items: { type: "string" }, minItems: 1 },
    env: {
      type: "object",
      propertyNames: { pattern: ENV_NAME.source },
      additionalProperties: { type: "string" },
    },
    refreshes: { type: "array", items: { type: "string", minLength: 1 } },
  },
  required: ["run"],
  additionalProperties: false,
};

// [LAW:one-source-of-truth] One schema member per arm `doctorArm` parses, the
// check enums drawn from the same lists it names, the mark enum from
// GLYPH_MARKS.
function doctorArmJson(): readonly JsonNode[] {
  const names = (checks: readonly Check[]) => ({
    enum: checks.map((c) => c.name),
  });
  return [
    {
      type: "object",
      properties: { doctor: { const: "run" } },
      required: ["doctor"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { doctor: { const: "fix" }, check: names(CHECKS) },
      required: ["doctor", "check"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        doctor: { const: "mark" },
        check: names(MARKED_CHECKS),
        mark: { enum: [...GLYPH_MARKS] },
      },
      required: ["doctor", "check", "mark"],
      additionalProperties: false,
    },
  ];
}

// [LAW:types-are-the-program] `do` names the declared actions one click fires,
// head first. Two or more: one member is that action itself, and nothing is
// gained by the indirection. Whether each name resolves, and whether a
// follower can ride behind a head at all, needs the merged action table, so
// both are cross-ref concerns (validateCrossReferences). `function`, not a
// const arrow, so actionArms above can reference it directly via hoisting.
function doArm(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionDecl | null {
  for (const k of Object.keys(raw)) {
    if (k !== "do")
      issue(
        ctx,
        `${path}.${k}`,
        `Unknown key "${k}" on a do action. Expected only: do`,
      );
  }
  const members = raw.do;
  if (
    !Array.isArray(members) ||
    members.length < 2 ||
    members.some((m) => typeof m !== "string" || m === "")
  ) {
    issue(
      ctx,
      `${path}.do`,
      `do must list at least two action names (the first is the click's face, the rest ride along in the same click), got ${describeValue(members)}`,
    );
    return null;
  }
  return { do: members as [string, ...string[]] };
}

const DO_ARM_JSON: JsonNode = {
  type: "object",
  properties: {
    do: { type: "array", items: { type: "string", minLength: 1 }, minItems: 2 },
  },
  required: ["do"],
  additionalProperties: false,
};

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

// [LAW:types-are-the-program] The key naming a value-source action's
// destination — `set` (SessionState) or `persist` (the config file) — with the
// noun its messages use.
type Discriminator = "set" | "persist";

const DISCRIMINATOR_NOUN: Readonly<Record<Discriminator, string>> = {
  set: "the SessionState key to write",
  persist: "the config globals field to write",
};

// [LAW:dataflow-not-control-flow] The destination key is validated once for
// every value source, before the source is detected — so a bad key and an
// ambiguous source both surface in one pass. It is therefore NOT a field of
// any arm's `fields` map; the arm parses only the value-source payload, and
// the dispatcher re-attaches it.
function validateDiscriminatorKey(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  discriminator: Discriminator,
): Record<string, string> | null {
  const noun = DISCRIMINATOR_NOUN[discriminator];
  const value = slashFreeString(
    ctx,
    path,
    discriminator,
    raw,
    `${discriminator} key must be non-empty (${noun})`,
    (v) => `${discriminator} key "${v}" contains "/" — keys must be slash-free`,
  );
  return value === null ? null : { [discriminator]: value };
}

// [LAW:one-source-of-truth] The wire verb name a discriminator's writes
// travel over — `set-state` for `set` (SessionState), `set-config` for
// `persist` (the config file). Threaded into the shared field specs below so
// their "cannot be delivered on the X wire" messages name the wire the value
// actually crosses, and the field/value noun ("set value" / "persist value")
// names the actual action kind, not always `set`.
function wireName(discriminator: Discriminator): string {
  return discriminator === "set" ? "set-state" : "set-config";
}

// [LAW:types-are-the-program] Each value source's payload as a field map — the
// non-discriminator keys that source carries. `fields` runs every spec
// (reporting all issues) and fails the arm when a required field is absent or
// invalid; `refine` adds the cross-field invariants `fields` cannot express.
// The reconstructed payload IS the member minus the discriminator, which the
// dispatcher re-attaches. Built once per discriminator (`set`/`persist` share
// field SHAPE but not error WORDING — see setLiteralSpec/fromSpec/cycleSpec).
const TO_FIELDS_SET: FieldSpecMap<{ to: string }> = {
  to: setLiteralSpec("set"),
};
const TO_FIELDS_PERSIST: FieldSpecMap<{ to: string }> = {
  to: setLiteralSpec("persist"),
};
const FROM_FIELDS_SET: FieldSpecMap<OptionSource> = {
  from: fromSpec("set"),
  labels: labelsSpec(),
};
const FROM_FIELDS_PERSIST: FieldSpecMap<OptionSource> = {
  from: fromSpec("persist"),
  labels: labelsSpec(),
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
const CYCLE_FIELDS_PERSIST: FieldSpecMap<{ cycle: readonly string[] }> = {
  cycle: cycleSpec("persist"),
};
// [LAW:one-type-per-behavior] brandon-layout-edit-2gc.1's two structural-edit
// arms — PERSIST-only (see action.ts's ActionDecl doc comment for why there
// is no `set` twin). Each field reuses layoutNameSpec: a segment/anchor name
// must be non-empty and free of both `/` (the click wire's own segment
// delimiter) and `:` (layout-ops.ts's op-token delimiter) — the SAME
// wire-safety diligence slashFreeString already applies to `to`/`cycle`
// members, one forbidden character wider.
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
// [LAW:one-type-per-behavior] `insertSegmentFrom`'s payload mirrors
// `insertSegment`'s verbatim except the segment name is a `from`-shaped
// OptionDomain (fromSpec, the SAME field `set`/`persist … from` already
// validate) instead of a literal layout name — the "to" vs "from" split every
// other value source already draws, one arm over.
const INSERT_SEGMENT_FROM_FIELDS: FieldSpecMap<{
  insertSegmentFrom: OptionDomain;
  anchor: string;
  relation: "before" | "after";
}> = {
  insertSegmentFrom: fromSpec("persist"),
  anchor: layoutNameSpec("anchor"),
  relation: relationSpec(),
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

// [LAW:no-mode-explosion] `detectKeys` narrows WHICH of an arm's fields the
// present-count dispatch keys off, independent of `allowed`/`label` (still
// the full field set — what the arm PERMITS and is NAMED by never changes).
// Every arm before insertSegmentFrom had a field set disjoint from every
// other arm's, so `Object.keys(fieldMap)` was a safe default for both jobs
// at once. insertSegmentFrom breaks that: it shares `anchor`/`relation` with
// insertSegment (same POSITION shape, different segment-name SOURCE), so
// dispatching on the full set would make an ordinary `insertSegment` action
// spuriously match both arms via those shared keys. Pass the true
// discriminator (the field no sibling arm carries) here; omit it when the
// field set already is disjoint from every sibling, as it is everywhere else.
function valueSourceArm<P extends object>(
  discriminator: Discriminator,
  fieldMap: FieldSpecMap<P>,
  checks: ReadonlyArray<Refinement<P>> = [],
  detectKeys?: readonly string[],
): ValueSourceArm {
  const fullKeys = Object.keys(fieldMap);
  const detect = detectKeys ?? fullKeys;
  const keys = [discriminator];
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

// [LAW:dataflow-not-control-flow] The value-source arms in the order their
// labels appear in the exactly-one message. A `set` declares exactly one of
// these; the dispatcher counts presence over `detect` and reconstructs
// `{ set, ...payload }`.
const SET_ARMS: readonly ValueSourceArm[] = [
  valueSourceArm("set", TO_FIELDS_SET),
  valueSourceArm("set", FROM_FIELDS_SET),
  valueSourceArm("set", BOUNDED_FIELDS, [minLessThanMax, byNonZero]),
  valueSourceArm("set", INT_FIELDS),
  valueSourceArm("set", CYCLE_FIELDS_SET),
];

// [LAW:one-type-per-behavior] `persist` mirrors `set` minus the `int` arm — a
// page cursor is a UI-only paging concept with no meaning as a persisted
// config default (see action.ts's ActionDecl comment). `removeSegment`/
// `insertSegment` are ADDITIONAL persist-only arms with no `set` counterpart.
const PERSIST_ARMS: readonly ValueSourceArm[] = [
  valueSourceArm("persist", TO_FIELDS_PERSIST),
  valueSourceArm("persist", FROM_FIELDS_PERSIST),
  valueSourceArm("persist", BOUNDED_FIELDS, [minLessThanMax, byNonZero]),
  valueSourceArm("persist", CYCLE_FIELDS_PERSIST),
  valueSourceArm("persist", REMOVE_SEGMENT_FIELDS),
  // [LAW:no-mode-explosion] Both insertSegment arms narrow detectKeys to
  // their own discriminating field — see valueSourceArm's own comment. They
  // share "anchor"/"relation" (same position shape, different segment-name
  // source), so dispatching on the full field set would make EITHER arm
  // spuriously match an action declaring the other.
  valueSourceArm("persist", INSERT_SEGMENT_FIELDS, [], ["insertSegment"]),
  valueSourceArm(
    "persist",
    INSERT_SEGMENT_FROM_FIELDS,
    [],
    ["insertSegmentFrom"],
  ),
];

// [LAW:one-source-of-truth] The clause list, not the joined string, is the
// data that varies per discriminator — the "or" belongs on the LAST clause
// only, and which clause is last differs between `set` (ends at cycle) and
// `persist` (ends at insertSegment), so building a list and joining it is
// what keeps that placement correct without a second copy of the sentence.
function valueSourceClauses(discriminator: Discriminator): string[] {
  const clauses = [
    `"to" (a literal value)`,
    `"from" (an option domain — a registered domain name like "themes"/"endcaps"/"styles", or an inline array of literal values)`,
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
  discriminator: Discriminator,
  arms: readonly ValueSourceArm[],
): ActionDecl | null {
  const keys = validateDiscriminatorKey(ctx, path, raw, discriminator);

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

// [LAW:no-silent-failure] A literal `to` and the discriminator key share
// the non-empty/slash-free shape — the wire rejects empty values and splits
// on "/", so either is undeliverable. The empty/slash messages are this
// arm's, the shape is the shared enforcer's. Built once per discriminator
// (see TO_FIELDS_SET/TO_FIELDS_PERSIST) so a `persist` action's message names
// "persist value" and the set-config wire, never `set`'s wording.
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

// [LAW:types-are-the-program] `from` is either a NAME (a non-empty string,
// resolved against the option-domain registry) or an INLINE literal domain (a
// non-empty array of deliverable wire values — the same non-empty/
// slash-free wire shape `to` and `cycle` members enforce, plus the same
// uniqueness `cycleSpec` requires: a duplicate has no successor-ambiguity
// concern here, but it would render the same picker cell twice for no
// benefit). This arm proves only the SHAPE; whether a named domain actually
// resolves needs the merged config's per-config domains (e.g. "styles"), so
// that check is a cross-reference concern (validateCrossReferences) —
// symmetric to how a layout node's segment ref or a `{{ action }}` ref
// resolves post-merge. Built once per discriminator, same reason as
// setLiteralSpec.
function labelsSpec(): FieldSpec<Readonly<Record<string, string>>> {
  return {
    required: false,
    json: {
      type: "object",
      additionalProperties: { type: "string", minLength: 1 },
    },
    parse: (ctx, path, field, raw) => {
      const labels = raw[field];
      if (labels === undefined) return undefined;
      if (
        typeof labels !== "object" ||
        labels === null ||
        Array.isArray(labels) ||
        Object.values(labels).some((l) => typeof l !== "string" || l === "")
      ) {
        issue(
          ctx,
          `${path}.${field}`,
          `${field} must map option values to non-empty display text`,
        );
        return undefined;
      }
      return labels as Readonly<Record<string, string>>;
    },
  };
}

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

// [LAW:types-are-the-program] `cycle` is the enumerated domain a click steps
// through: at least two members (one member has no successor to step to — that
// is a literal `to`), each a deliverable wire value (non-empty, slash-free
// — the same wire shape `to` enforces), no duplicates (the successor of a
// duplicated member is ambiguous). Members double as the derived allow-list
// gate, so a member this spec admits is a value the wire delivers, by
// construction. Built once per discriminator, same reason as setLiteralSpec.
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

// [LAW:no-silent-failure] `int` is a marker, not a value — it declares the key
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

// [LAW:one-source-of-truth] A layout op's segment-name field (removeSegment /
// insertSegment / anchor) is non-empty and free of BOTH wire-structural
// characters: `/` (the click wire's own multi-arg segment delimiter, the
// same restriction slashFreeString already enforces for `to`/`cycle`) and
// `:` (layout-ops.ts's op-token delimiter — a name containing it would make
// encodeLayoutOp's output ambiguous to decode). One spec, three callsites,
// so the two-character restriction can't drift between them.
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

// [LAW:types-are-the-program] `relation` is a closed two-value enum, not a
// free string — a typo (`"befor"`) is a load error, never a click-time
// surprise. Mirrors intMarkerSpec's "one legal literal" shape, widened to
// two.
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
