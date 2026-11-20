// [LAW:types-are-the-program] An action declares exactly one action key.
// Set and persist also select one source for their value. Some sources span
// several fields, such as a bounded step's min, max and by. Each variant is a
// field map typed by its ActionDecl member: the map's keys are what the
// variant parses and permits, its specs are what the editor schema publishes,
// and a member that writes config cannot leave out its `layer` field.
//
// [LAW:no-mode-explosion] Unlike cache (single-key value arms, oneOfPresent)
// and variables (tag by field value, taggedUnion), a set/persist arm is a
// multi-key record that no single key selects, so this file owns the thin
// present-key dispatch over shared field specs.

import {
  ACTION_KEYS,
  type ActionDecl,
  type ActionKey,
  type OptionDomain,
  type RunAction,
} from "../action.js";
import {
  DEFAULT_WRITE_LAYER,
  LAYER_ROLES,
  type LayerChoice,
} from "../layer-role.js";
import nodePath from "node:path";
import { IDENTIFIER } from "../identifier.js";
import { findKeyLine } from "./diagnostics.js";
import {
  parseSlashLine,
  SLASH_LINE_PATTERN,
  type SlashLine,
} from "../../claude-input/slash-line.js";
import {
  describeType,
  describeValue,
  fields,
  isPlainObject,
  objectJson,
  record,
  refine,
  requireString,
  requireStringSpec,
  type ArmParse,
  type FieldSpec,
  type FieldSpecMap,
  type JsonNode,
  type Refinement,
  type ValidateCtx,
} from "./validate-core.js";
import { LAYOUT_NAME, WIRE_VALUE, type WireShape } from "./wire-shape.js";

// [LAW:locality-or-seam] The declaring file supplies each action's shape
// and a run's directory. References between actions and segments resolve
// after merging, when actions declared in another layer are visible.
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

// [LAW:dataflow-not-control-flow] The action key selects its parser.
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
  const key = actionKeyOf(ctx, path, raw);
  return key === null ? null : ACTION_ARMS[key].parse(ctx, path, raw, home);
}

// [LAW:parse-dont-validate] The one action key a record declares, or null
// with the issue that says which keys it found.
function actionKeyOf(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
): ActionKey | null {
  const [key, ...others] = ACTION_KEYS.filter((k) => k in raw);
  if (key !== undefined && others.length === 0) return key;
  issue(
    ctx,
    path,
    `action must declare exactly one of: ${ACTION_KEYS.join(", ")}${
      others.length > 0 ? ` (found: ${[key, ...others].join(", ")})` : ""
    }`,
  );
  return null;
}

// [LAW:types-are-the-program] Where an action table is declared: the directory
// of the file that declares it, which a `run` declared there runs in, or a
// text no file holds, named for the error a `run` there
// is — it has no directory to run in.
export type ActionHome =
  | { readonly dir: string | null }
  | { readonly text: string };

// The home of a table parsed from `filePath`: a file's directory when it is
// one, else the text's name (a label in angle brackets names no file).
export function actionHomeOf(filePath: string): ActionHome {
  // The bundled config has no file: its runs go in the user's home, which the
  // daemon knows and this parse, at import, does not.
  if (filePath === "<default>") return { dir: null };
  return nodePath.isAbsolute(filePath)
    ? { dir: nodePath.dirname(filePath) }
    : { text: filePath };
}

export function actionsJson(): JsonNode {
  const anyOf = ACTION_KEYS.flatMap((key) => ACTION_ARMS[key].variants);
  return { type: "object", additionalProperties: { anyOf } };
}

// ─── The arms ────────────────────────────────────────────────────────────────

// The ActionDecl member that declares every key in `Keys`.
type Member<Keys extends string> = Extract<
  ActionDecl,
  Readonly<Record<Keys, unknown>>
>;

interface ActionSyntax {
  readonly parse: (
    ctx: ValidateCtx,
    path: string,
    raw: Record<string, unknown>,
    home: ActionHome,
  ) => ActionDecl | null;
  readonly variants: readonly JsonNode[];
}

// [LAW:single-enforcer] A closed record: its unknown keys, its fields and its
// cross-field refinements, read from one field map that also emits its schema.
function closedArm<M extends object>(
  key: ActionKey,
  fieldMap: FieldSpecMap<M>,
  checks: ReadonlyArray<Refinement<M>> = [],
): ArmParse<M> {
  return refine(
    (ctx, path, raw) =>
      record(ctx, { noun: `${key} action key`, fields: fieldMap }, path, raw),
    ...checks,
  );
}

function recordSyntax<M extends ActionDecl>(
  key: ActionKey,
  fieldMap: FieldSpecMap<M>,
): ActionSyntax {
  return { parse: closedArm(key, fieldMap), variants: [objectJson(fieldMap)] };
}

// [LAW:types-are-the-program] Every action that writes config names a layer of
// the session's chain; an author who leaves it out writes the user's. The
// default lands here, at the border, so every parsed write carries its layer.
function layerSpec<L extends LayerChoice>(
  choices: readonly L[],
): FieldSpec<L | typeof DEFAULT_WRITE_LAYER> {
  return {
    required: false,
    json: { enum: [...choices] },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return DEFAULT_WRITE_LAYER;
      const chosen = choices.find((choice) => choice === v);
      if (chosen === undefined)
        issue(
          ctx,
          `${path}.${field}`,
          `layer must be one of ${choices.join(", ")}, got ${describeValue(v)}`,
        );
      return chosen;
    },
  };
}

const WRITES_LAYER = layerSpec(LAYER_ROLES);
// Save alone may ask: it is the one write whose click binds no value of its
// own, so each link can bind one of the session's writable layers.
const SAVE_LAYER = layerSpec([...LAYER_ROLES, "ask"]);

// [LAW:single-enforcer] A required string in a wire shape: one test against the
// shape's pattern, the schema publishing the same pattern.
function wireSpec(
  shape: WireShape,
  message: (value: string) => string,
): FieldSpec<string> {
  return {
    required: true,
    json: shape.json,
    parse: (ctx, path, field, raw) => {
      const v = requireString(ctx, path, raw, field);
      if (v === null) return undefined;
      if (shape.pattern.test(v)) return v;
      issue(ctx, `${path}.${field}`, message(v));
      return undefined;
    },
  };
}

// A field whose one legal value is a literal: a marker's `true`, a verb.
function literalSpec<T extends string | true>(
  value: T,
  message: (got: unknown) => string,
): FieldSpec<T> {
  return {
    required: true,
    json: { const: value },
    parse: (ctx, path, field, raw) => {
      if (raw[field] === value) return value;
      issue(ctx, `${path}.${field}`, message(raw[field]));
      return undefined;
    },
  };
}

// [LAW:one-type-per-behavior] `undo`/`redo`/`back`/`rewind`/`save` are markers:
// a single key whose only legal value is `true`, because there is no key to
// name — the history they step is one stack per session, and the settings a
// save writes are the session's own drafts.
type MarkerKey = "undo" | "redo" | "back" | "rewind" | "save";
const MARKER_SUBJECT: Record<MarkerKey, string> = {
  undo: "it steps the session's settings history",
  redo: "it steps the session's settings history",
  back: "it steps the session's navigation history",
  rewind:
    "it steps the session's settings history back to where edit mode opened",
  save: "it saves the session's unsaved settings",
};
function markerSpec(key: MarkerKey): FieldSpec<true> {
  return literalSpec(
    true,
    (got) =>
      `${key} must be the literal true (it takes no key — ${MARKER_SUBJECT[key]}), got ${describeValue(got)}`,
  );
}

// [LAW:types-are-the-program] `reset` clears a config globals field — a key,
// not a template, so it takes the wire shape the set and persist keys take.
const RESET_FIELDS: FieldSpecMap<Member<"reset">> = {
  reset: wireSpec(
    WIRE_VALUE,
    (v) =>
      `reset key ${JSON.stringify(v)} must be ${WIRE_VALUE.rule} (the config globals field to clear)`,
  ),
  layer: WRITES_LAYER,
};

// [LAW:types-are-the-program] `preset` is `"save"` alone, or `"delete"` with
// the `name` it removes — a template, so its preset can be the one the bar is
// in. The verb selects which record the action is.
const presetVerb = <V extends "save" | "delete">(verb: V) =>
  literalSpec(
    verb,
    (got) => `preset must be "save" or "delete", got ${describeValue(got)}`,
  );
const PRESET_SAVE: FieldSpecMap<Extract<ActionDecl, { preset: "save" }>> = {
  preset: presetVerb("save"),
  layer: WRITES_LAYER,
};
const PRESET_DELETE: FieldSpecMap<Extract<ActionDecl, { preset: "delete" }>> = {
  preset: presetVerb("delete"),
  name: requireStringSpec(),
  layer: WRITES_LAYER,
};
const parsePresetSave = closedArm("preset", PRESET_SAVE);
const parsePresetDelete = closedArm("preset", PRESET_DELETE);

// [LAW:types-are-the-program] `themeDefault` is `preset: "save"`'s shape with
// nothing beside it — which theme and which look are the daemon's to read at
// click time.
const THEME_DEFAULT_FIELDS: FieldSpecMap<Member<"themeDefault">> = {
  themeDefault: literalSpec(
    "save",
    (got) =>
      `themeDefault must be "save" (it saves the look the session draws as the active theme's default), got ${describeValue(got)}`,
  ),
  layer: WRITES_LAYER,
};

// [LAW:parse-dont-validate] `slash` is the one place a line to type becomes a
// SlashLine (src/claude-input/slash-line.ts); the verb and the edge take
// nothing else.
const SLASH_FIELDS: FieldSpecMap<Member<"slash">> = {
  slash: {
    required: true,
    json: { type: "string", pattern: SLASH_LINE_PATTERN },
    parse: (ctx, path, field, raw): SlashLine | undefined => {
      const parsed = parseSlashLine(raw[field]);
      if (parsed.kind === "line") return parsed.line;
      issue(ctx, `${path}.${field}`, parsed.reason);
      return undefined;
    },
  },
};

// [LAW:types-are-the-program] `run` is a program and its arguments — one
// template each, with no shell between — the variables laid over the session's
// process environment, each value a template, and the declared sources the
// program writes. Leaving out `env` or `refreshes` declares none. Whether each
// `refreshes` name is a declared source needs the merged config, so it is a
// cross-ref concern (validateDeclarations).
const RUN_FIELDS: FieldSpecMap<Omit<RunAction, "cwd">> = {
  run: {
    required: true,
    // The program comes first and is never empty; its arguments may be.
    json: {
      type: "array",
      items: [{ type: "string", minLength: 1 }],
      additionalItems: { type: "string" },
      minItems: 1,
    },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (Array.isArray(v) && v.every(isString)) {
        const [program, ...args] = v;
        if (program !== undefined && program !== "") return [program, ...args];
      }
      issue(
        ctx,
        `${path}.${field}`,
        `run must list the program and its arguments, each a template string, the program first and not empty, got ${describeValue(v)}`,
      );
      return undefined;
    },
  },
  env: {
    required: false,
    json: {
      type: "object",
      propertyNames: { pattern: IDENTIFIER.source },
      additionalProperties: { type: "string" },
    },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return {};
      const table: Record<string, string> = {};
      const entries = isPlainObject(v) ? Object.entries(v) : null;
      for (const [name, value] of entries ?? [])
        if (IDENTIFIER.test(name) && typeof value === "string")
          table[name] = value;
      if (entries !== null && Object.keys(table).length === entries.length)
        return table;
      issue(
        ctx,
        `${path}.${field}`,
        `env must map variable names (letters, digits and _, not starting with a digit) to template strings, got ${describeValue(v)}`,
      );
      return undefined;
    },
  },
  refreshes: {
    required: false,
    json: { type: "array", items: { type: "string", minLength: 1 } },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return [];
      if (Array.isArray(v) && v.every(isString) && !v.includes("")) return v;
      issue(
        ctx,
        `${path}.${field}`,
        `refreshes must list the names of the sources the program writes, got ${describeValue(v)}`,
      );
      return undefined;
    },
  },
};
const parseRun = closedArm<Omit<RunAction, "cwd">>("run", RUN_FIELDS);

// The declaring file's directory is where the program runs.
function runParse(
  ctx: ValidateCtx,
  path: string,
  raw: Record<string, unknown>,
  home: ActionHome,
): RunAction | null {
  const parsed = parseRun(ctx, path, raw);
  if ("text" in home) {
    issue(
      ctx,
      `${path}.run`,
      `a run action runs in the directory of the file that declares it, and ${home.text} is no file`,
    );
    return null;
  }
  return parsed === null ? null : { ...parsed, cwd: home.dir };
}

// [LAW:types-are-the-program] `do` names the declared actions one click fires,
// head first. Two or more: one member is that action itself, and nothing is
// gained by the indirection. Whether each name resolves, and whether a
// follower can ride behind a head at all, needs the merged action table, so
// both are cross-ref concerns (validateCrossReferences).
const DO_FIELDS: FieldSpecMap<Member<"do">> = {
  do: {
    required: true,
    json: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 2,
    },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (Array.isArray(v) && v.every(isString) && !v.includes("")) {
        const [head, second, ...rest] = v;
        if (head !== undefined && second !== undefined)
          return [head, second, ...rest];
      }
      issue(
        ctx,
        `${path}.${field}`,
        `do must list at least two action names (the first is the click's face, the rest ride along in the same click), got ${describeValue(v)}`,
      );
      return undefined;
    },
  },
};

function isString(v: unknown): v is string {
  return typeof v === "string";
}

// ─── The `set` and `persist` value sources ───────────────────────────────────

// [LAW:types-are-the-program] The key naming a value-source action's
// destination — `set` (SessionState) or `persist` (the config file).
type Discriminator = "set" | "persist";

// [LAW:one-source-of-truth] Each destination's own fields — its key, and for
// a config write its layer — with the noun its key's message uses and the wire
// its writes travel over, so a value's message names the wire it crosses.
const DESTINATION = {
  set: { noun: "the SessionState key to write", wire: "set-state" },
  persist: { noun: "the config globals field to write", wire: "set-config" },
} as const satisfies Record<Discriminator, { noun: string; wire: string }>;

function destinationKeySpec(discriminator: Discriminator): FieldSpec<string> {
  return wireSpec(
    WIRE_VALUE,
    (v) =>
      `${discriminator} key ${JSON.stringify(v)} must be ${WIRE_VALUE.rule} (${DESTINATION[discriminator].noun})`,
  );
}

const SET_DESTINATION: FieldSpecMap<{ set: string }> = {
  set: destinationKeySpec("set"),
};
const PERSIST_DESTINATION: FieldSpecMap<
  Pick<Member<"persist">, "persist" | "layer">
> = { persist: destinationKeySpec("persist"), layer: WRITES_LAYER };

// [LAW:no-silent-failure] A literal `to` is undeliverable when empty or
// slash-bearing: the wire refuses an empty value and splits on "/".
function toValueSpec(discriminator: Discriminator): FieldSpec<string> {
  return wireSpec(
    WIRE_VALUE,
    (v) =>
      `${discriminator} value ${JSON.stringify(v)} must be ${WIRE_VALUE.rule} — the ${DESTINATION[discriminator].wire} wire refuses an empty value and splits on "/"`,
  );
}

// [LAW:types-are-the-program] `from` is either a NAME (a non-empty string,
// resolved against the option-domain registry) or an INLINE literal domain: a
// non-empty array of unique values in the member shape, which for a layout op
// is a segment name. This proves only the SHAPE; whether a named domain
// resolves needs the merged config's per-config domains, so that check is a
// cross-reference concern (validateCrossReferences).
function fromSpec(
  discriminator: Discriminator,
  member: WireShape,
): FieldSpec<OptionDomain> {
  return {
    required: true,
    json: {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "array", items: member.json, minItems: 1, uniqueItems: true },
      ],
    },
    parse: (ctx, path, field, raw) => {
      const from = raw[field];
      const at = `${path}.${field}`;
      if (typeof from === "string" && from !== "") return from;
      if (Array.isArray(from) && from.length > 0 && from.every(isString)) {
        const unwritable = from.filter((m) => !member.pattern.test(m));
        if (unwritable.length > 0) {
          issue(
            ctx,
            at,
            `${field} array members must be ${member.rule} — the ${DESTINATION[discriminator].wire} wire carries each — got ${JSON.stringify(unwritable)}`,
          );
          return undefined;
        }
        if (new Set(from).size === from.length) return from;
        issue(
          ctx,
          at,
          `${field} array members must be unique — a duplicated value would render the same picker option twice`,
        );
        return undefined;
      }
      issue(
        ctx,
        at,
        `${field} must name a domain (a non-empty string) or declare an inline domain (a non-empty array of strings), got ${describeValue(from)}`,
      );
      return undefined;
    },
  };
}

// [LAW:types-are-the-program] `cycle` is the enumerated domain a click steps
// through: at least two members (one member has no successor to step to — that
// is a literal `to`), each a deliverable wire value, no duplicates (the
// successor of a duplicated member is ambiguous). Members double as the derived
// allow-list gate, so a member this spec admits is a value the wire delivers.
function cycleSpec(discriminator: Discriminator): FieldSpec<readonly string[]> {
  return {
    required: true,
    json: {
      type: "array",
      items: WIRE_VALUE.json,
      minItems: 2,
      uniqueItems: true,
    },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      const at = `${path}.${field}`;
      if (!Array.isArray(v) || !v.every(isString)) {
        issue(
          ctx,
          at,
          `cycle must be an array of strings (the enumerated values a click steps through), got ${describeType(v)}`,
        );
        return undefined;
      }
      if (v.length < 2) {
        issue(
          ctx,
          at,
          `cycle needs at least two members (one member has no successor — use a literal "to")`,
        );
        return undefined;
      }
      const unwritable = v.filter((m) => !WIRE_VALUE.pattern.test(m));
      if (unwritable.length > 0) {
        issue(
          ctx,
          at,
          `cycle members must be ${WIRE_VALUE.rule} — the ${DESTINATION[discriminator].wire} wire carries each — got ${JSON.stringify(unwritable)}`,
        );
        return undefined;
      }
      if (new Set(v).size !== v.length) {
        issue(
          ctx,
          at,
          `cycle members must be unique — the successor of a duplicated member is ambiguous`,
        );
        return undefined;
      }
      return v;
    },
  };
}

// [LAW:no-silent-failure] `int` is a marker, not a value — it declares the key
// an unbounded-integer cursor. Only the literal `true` is meaningful.
const INT_MARKER = literalSpec(
  true,
  (got) =>
    `int must be the literal true (declares the key an unbounded integer cursor — a paged picker's page key), got ${describeValue(got)}`,
);

// [LAW:types-are-the-program] A required integer field — the field key (min /
// max) comes from the map, the message names it.
function requireIntSpec(): FieldSpec<number> {
  return {
    required: true,
    json: { type: "integer" },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (typeof v === "number" && Number.isInteger(v)) return v;
      issue(
        ctx,
        `${path}.${field}`,
        `${field} must be an integer, got ${describeValue(v)}`,
      );
      return undefined;
    },
  };
}

// [LAW:types-are-the-program] `by` is the per-click increment of a bounded
// step: an integer that is never the one value that moves nothing. Unlike a
// stepper widget's positive `step`, the sign carries the direction.
const STILL = 0;
const STEP: FieldSpec<number> = {
  required: true,
  json: { type: "integer", not: { const: STILL } },
  parse: (ctx, path, field, raw) => {
    const v = requireIntSpec().parse(ctx, path, field, raw);
    if (v !== STILL) return v;
    issue(
      ctx,
      `${path}.${field}`,
      `${field} must be a non-zero integer (the per-click increment; negative steps down)`,
    );
    return undefined;
  },
};

// [LAW:types-are-the-program] A bounded step's domain relates two fields,
// min < max, so it is the one refinement a field spec cannot express.
const minLessThanMax: Refinement<{ min: number; max: number }> = {
  ok: (v) => v.min < v.max,
  issue: (v) => ({
    field: "min",
    message: `min (${v.min}) must be less than max (${v.max})`,
  }),
};

// [LAW:one-source-of-truth] A layout op's segment name (removeSegment /
// insertSegment / anchor) is spliced into the op token, so it takes the
// layout-name shape.
function layoutNameSpec(): FieldSpec<string> {
  return wireSpec(
    LAYOUT_NAME,
    (v) =>
      `segment name ${JSON.stringify(v)} in a layout op must be ${LAYOUT_NAME.rule} (the click wire's own delimiter and layout-ops.ts's op-token delimiter)`,
  );
}

// [LAW:types-are-the-program] `relation` is a closed two-value enum, not a
// free string — a typo (`"befor"`) is a load error, never a click-time
// surprise.
const RELATION: FieldSpec<"before" | "after"> = {
  required: true,
  json: { enum: ["before", "after"] },
  parse: (ctx, path, field, raw) => {
    const v = raw[field];
    if (v === "before" || v === "after") return v;
    issue(
      ctx,
      `${path}.${field}`,
      `relation must be "before" or "after", got ${describeValue(v)}`,
    );
    return undefined;
  },
};

// [LAW:types-are-the-program] A value-source arm: its member's whole field map
// (destination fields plus the source's own), the source keys whose presence
// selects it, and its cross-field refinements. Its name in the exactly-one
// message is its source keys joined by "/".
interface ValueSourceArm {
  readonly detect: readonly string[];
  readonly label: string;
  readonly about: string;
  readonly json: JsonNode;
  readonly parse: ArmParse<ActionDecl>;
}

// [LAW:no-mode-explosion] `detect` defaults to every source key. Both
// insertSegment arms narrow it to their own segment key, because they share
// `anchor`/`relation` and either would otherwise match the other's action.
function valueSourceArm<M extends ActionDecl>(
  discriminator: Discriminator,
  destination: FieldSpecMap<object>,
  fieldMap: FieldSpecMap<M>,
  about: string,
  options: {
    readonly checks?: ReadonlyArray<Refinement<M>>;
    readonly detect?: readonly string[];
  } = {},
): ValueSourceArm {
  const source = Object.keys(fieldMap).filter((k) => !(k in destination));
  return {
    detect: options.detect ?? source,
    label: source.join("/"),
    about,
    json: objectJson(fieldMap),
    parse: closedArm(discriminator, fieldMap, options.checks),
  };
}

// What each value source does, as the exactly-one message names it.
const ABOUT = {
  to: "a literal value",
  from: 'an option domain — a registered domain name like "themes"/"endcaps"/"styles", or an inline array of literal values',
  bounded: "a bounded step",
  int: "an unbounded integer cursor",
  cycle: "an enumerated domain stepped in order",
} as const;

const SET_ARMS: readonly ValueSourceArm[] = [
  valueSourceArm<Member<"set" | "to">>(
    "set",
    SET_DESTINATION,
    { ...SET_DESTINATION, to: toValueSpec("set") },
    ABOUT.to,
  ),
  valueSourceArm<Member<"set" | "from">>(
    "set",
    SET_DESTINATION,
    { ...SET_DESTINATION, from: fromSpec("set", WIRE_VALUE) },
    ABOUT.from,
  ),
  valueSourceArm<Member<"set" | "min">>(
    "set",
    SET_DESTINATION,
    {
      ...SET_DESTINATION,
      min: requireIntSpec(),
      max: requireIntSpec(),
      by: STEP,
    },
    ABOUT.bounded,
    { checks: [minLessThanMax] },
  ),
  valueSourceArm<Member<"set" | "int">>(
    "set",
    SET_DESTINATION,
    { ...SET_DESTINATION, int: INT_MARKER },
    ABOUT.int,
  ),
  valueSourceArm<Member<"set" | "cycle">>(
    "set",
    SET_DESTINATION,
    { ...SET_DESTINATION, cycle: cycleSpec("set") },
    ABOUT.cycle,
  ),
];

// [LAW:one-type-per-behavior] `persist` mirrors `set` minus the `int` arm — a
// page cursor is a UI-only paging concept with no meaning as a persisted
// config default. `removeSegment`/`insertSegment`/`insertSegmentFrom` are
// persist-only layout edits with no `set` counterpart.
const PERSIST_ARMS: readonly ValueSourceArm[] = [
  valueSourceArm<Member<"persist" | "to">>(
    "persist",
    PERSIST_DESTINATION,
    { ...PERSIST_DESTINATION, to: toValueSpec("persist") },
    ABOUT.to,
  ),
  valueSourceArm<Member<"persist" | "from">>(
    "persist",
    PERSIST_DESTINATION,
    { ...PERSIST_DESTINATION, from: fromSpec("persist", WIRE_VALUE) },
    ABOUT.from,
  ),
  valueSourceArm<Member<"persist" | "min">>(
    "persist",
    PERSIST_DESTINATION,
    {
      ...PERSIST_DESTINATION,
      min: requireIntSpec(),
      max: requireIntSpec(),
      by: STEP,
    },
    ABOUT.bounded,
    { checks: [minLessThanMax] },
  ),
  valueSourceArm<Member<"persist" | "cycle">>(
    "persist",
    PERSIST_DESTINATION,
    { ...PERSIST_DESTINATION, cycle: cycleSpec("persist") },
    ABOUT.cycle,
  ),
  valueSourceArm<Member<"persist" | "removeSegment">>(
    "persist",
    PERSIST_DESTINATION,
    { ...PERSIST_DESTINATION, removeSegment: layoutNameSpec() },
    "remove a named segment from the layout",
  ),
  valueSourceArm<Member<"persist" | "insertSegment">>(
    "persist",
    PERSIST_DESTINATION,
    {
      ...PERSIST_DESTINATION,
      insertSegment: layoutNameSpec(),
      anchor: layoutNameSpec(),
      relation: RELATION,
    },
    "insert a named segment before/after an existing one",
    { detect: ["insertSegment"] },
  ),
  // `insertSegmentFrom` is insertSegment with the segment picked from an
  // option domain, so an inline domain's members are segment names.
  valueSourceArm<Member<"persist" | "insertSegmentFrom">>(
    "persist",
    PERSIST_DESTINATION,
    {
      ...PERSIST_DESTINATION,
      insertSegmentFrom: fromSpec("persist", LAYOUT_NAME),
      anchor: layoutNameSpec(),
      relation: RELATION,
    },
    "insert a segment PICKED from an option domain before/after an existing one",
    { detect: ["insertSegmentFrom"] },
  ),
];

// [LAW:dataflow-not-control-flow] The set/persist sub-union eliminator: count
// which value sources are present, require exactly one, and parse that arm's
// closed record. When no single source is present, the destination's own
// fields are still checked, so a bad key and a missing source surface in one
// pass.
function valueSyntax(
  discriminator: Discriminator,
  destination: FieldSpecMap<object>,
  arms: readonly ValueSourceArm[],
): ActionSyntax {
  return {
    variants: arms.map((arm) => arm.json),
    parse: (ctx, path, raw) => {
      const present = arms.filter((arm) => arm.detect.some((k) => k in raw));
      const [arm, ...others] = present;
      if (arm !== undefined && others.length === 0)
        return arm.parse(ctx, path, raw);
      fields(ctx, destination, path, raw);
      issue(
        ctx,
        path,
        `a ${discriminator} action declares exactly one value source: ${sourceList(arms)}${
          others.length > 0
            ? ` — found: ${present.map((a) => a.label).join(", ")}`
            : ""
        }`,
      );
      return null;
    },
  };
}

function sourceList(arms: readonly ValueSourceArm[]): string {
  const names = arms.map(
    (arm) => `"${arm.label.split("/").join('"/"')}" (${arm.about})`,
  );
  const last = names[names.length - 1];
  return names.length < 2
    ? (last ?? "")
    : `${names.slice(0, -1).join(", ")}, or ${last}`;
}

// [LAW:single-enforcer] One entry per action joins its parser to every shape
// an editor can suggest; both read the same field maps. Only a run needs the
// declaring file's directory.
const ACTION_ARMS: Record<ActionKey, ActionSyntax> = {
  set: valueSyntax("set", SET_DESTINATION, SET_ARMS),
  persist: valueSyntax("persist", PERSIST_DESTINATION, PERSIST_ARMS),
  // copy and open each take one required template string.
  copy: recordSyntax<Member<"copy">>("copy", { copy: requireStringSpec() }),
  open: recordSyntax<Member<"open">>("open", { open: requireStringSpec() }),
  reset: recordSyntax("reset", RESET_FIELDS),
  undo: recordSyntax<Member<"undo">>("undo", { undo: markerSpec("undo") }),
  redo: recordSyntax<Member<"redo">>("redo", { redo: markerSpec("redo") }),
  back: recordSyntax<Member<"back">>("back", { back: markerSpec("back") }),
  rewind: recordSyntax<Member<"rewind">>("rewind", {
    rewind: markerSpec("rewind"),
  }),
  save: recordSyntax<Member<"save">>("save", {
    save: markerSpec("save"),
    layer: SAVE_LAYER,
  }),
  preset: {
    parse: (ctx, path, raw) =>
      (raw.preset === "delete" ? parsePresetDelete : parsePresetSave)(
        ctx,
        path,
        raw,
      ),
    variants: [objectJson(PRESET_SAVE), objectJson(PRESET_DELETE)],
  },
  themeDefault: recordSyntax("themeDefault", THEME_DEFAULT_FIELDS),
  slash: recordSyntax("slash", SLASH_FIELDS),
  run: {
    parse: runParse,
    variants: [objectJson(RUN_FIELDS)],
  },
  do: recordSyntax("do", DO_FIELDS),
};
