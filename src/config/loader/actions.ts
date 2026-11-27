// [LAW:one-source-of-truth] An authored action is a closed record. Its fields
// determine parsing, the editor schema and the keys offered in diagnostics.
import nodePath from "node:path";
import {
  LAYER_CHOICES,
  type ActionDecl,
  type ActionKey,
  type OptionDomain,
} from "../action.js";
import { DEFAULT_WRITE_LAYER } from "../layer-role.js";
import {
  parseOneDelivered,
  PLAIN_CLICK,
  type GestureName,
} from "../../click/gesture.js";
import { clickValue, layoutComponent } from "../../click/wire-value.js";
import { findKeyLine } from "./diagnostics.js";
import {
  parseSlashLine,
  SLASH_LINE_PATTERN,
  type SlashLine,
} from "../../claude-input/slash-line.js";
import {
  describeType,
  describeValue,
  ENV_NAME,
  fields,
  isPlainObject,
  objectJson,
  type FieldSpec,
  type FieldSpecMap,
  type JsonNode,
  type ValidateCtx,
} from "./validate-core.js";

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

// [LAW:parse-dont-validate] An action's `on:` as canonical gestures, each
// naming the action it runs. Whether those names resolve is a cross-ref
// concern, as for a `do` member.
function validateGestures(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): Record<GestureName, string> | null {
  if (!isPlainObject(raw)) {
    issue(
      ctx,
      `${path}.on`,
      `${path}.on must map gestures to action names, got ${describeType(raw)}`,
    );
    return null;
  }
  const out: Record<GestureName, string> = Object.create(null) as Record<
    GestureName,
    string
  >;
  let valid = true;
  for (const [spelling, target] of Object.entries(raw)) {
    const at = `${path}.on.${spelling}`;
    // `hover` is a binding too: what a click means on a surface that cannot
    // see the pointer move, in the statusline's hover mode.
    const gesture = parseOneDelivered(spelling);
    if (gesture.kind === "failed") {
      issue(ctx, at, gesture.reason);
      valid = false;
      continue;
    }
    const name = gesture.value;
    if (name === PLAIN_CLICK) {
      issue(
        ctx,
        at,
        `"${spelling}" is the plain click, which is the action's own effects: declare them on the action`,
      );
      valid = false;
    } else if (name in out) {
      issue(ctx, at, `"${spelling}" is the gesture ${name}, bound twice`);
      valid = false;
    } else if (typeof target !== "string" || target === "") {
      issue(
        ctx,
        at,
        `${at} must name a declared action, got ${describeValue(target)}`,
      );
      valid = false;
    } else out[name] = target;
  }
  return valid ? out : null;
}

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

// A present value produces a typed field or a field issue. Absent values are
// handled by the field's presence policy before the parser sees input.
type Value<T> = { value: T } | { error: string };
function required<T>(
  json: JsonNode,
  read: (raw: unknown, name: string) => Value<T>,
): FieldSpec<T> {
  return {
    required: true,
    json,
    parse(ctx, path, name, raw) {
      const parsed = read(raw[name], name);
      if ("value" in parsed) return parsed.value;
      issue(ctx, path + "." + name, parsed.error);
      return undefined;
    },
  };
}
function defaulted<T>(spec: FieldSpec<T>, fallback: () => T): FieldSpec<T> {
  return {
    ...spec,
    required: false,
    parse: (ctx, path, name, raw) =>
      Object.hasOwn(raw, name) ? spec.parse(ctx, path, name, raw) : fallback(),
  };
}
const text = required<string>({ type: "string" }, (raw, name) =>
  typeof raw === "string"
    ? { value: raw }
    : { error: `${name} must be a string, got ${describeValue(raw)}` },
);
function choice<const T extends string | boolean>(
  values: readonly T[],
  requirement: string,
) {
  return required<T>({ enum: values }, (raw, name) =>
    values.some((value) => value === raw)
      ? { value: raw as T }
      : { error: `${name} ${requirement}, got ${describeValue(raw)}` },
  );
}
function wireField(shape: typeof clickValue, subject?: string) {
  return required<string>(shape.json, (raw, name) => {
    const value = shape.parse(raw);
    return value === null
      ? { error: `${subject ?? name} ${shape.rule}, got ${describeValue(raw)}` }
      : { value };
  });
}
function words(
  minItems: number,
  shape: typeof clickValue,
  end: string,
): FieldSpec<readonly string[]> {
  return required<readonly string[]>(
    { type: "array", items: shape.json, minItems, uniqueItems: true },
    (raw, name) => {
      if (
        !Array.isArray(raw) ||
        !raw.every((word): word is string => typeof word === "string")
      )
        return {
          error: `${name} must be an array of strings, got ${describeValue(raw)}`,
        };
      if (raw.length < minItems)
        return {
          error:
            minItems === 2
              ? `${name} needs at least two members`
              : `${name} must declare a non-empty array of values`,
        };
      const refused = raw.find((word) => shape.parse(word) === null);
      if (refused !== undefined)
        return {
          error: `${name} members ${shape.rule} on the ${end} wire, got ${describeValue(refused)}`,
        };
      if (new Set(raw).size !== raw.length)
        return { error: `${name} array members must be unique` };
      return { value: raw };
    },
  );
}
function domain(
  shape: typeof clickValue,
  end: string,
): FieldSpec<OptionDomain> {
  const list = words(1, shape, end);
  return {
    required: true,
    json: { anyOf: [{ type: "string", minLength: 1 }, list.json] },
    parse(ctx, path, name, raw) {
      const v = raw[name];
      if (typeof v !== "string") return list.parse(ctx, path, name, raw);
      if (v !== "") return v;
      issue(ctx, path + "." + name, `${name} must be a non-empty domain name`);
      return undefined;
    },
  };
}
const integer = required<number>({ type: "integer" }, (v, name) =>
  typeof v === "number" && Number.isInteger(v)
    ? { value: v }
    : { error: `${name} must be an integer, got ${describeValue(v)}` },
);
const increment = required<number>(
  { type: "integer", not: { const: 0 } },
  (v, name) =>
    typeof v === "number" && Number.isInteger(v) && v !== 0
      ? { value: v }
      : { error: `${name} must be a non-zero integer` },
);
const gestures: FieldSpec<Record<GestureName, string>> = {
  required: false,
  json: {
    type: "object",
    additionalProperties: { type: "string", minLength: 1 },
  },
  parse(ctx, path, name, raw) {
    return Object.hasOwn(raw, name)
      ? (validateGestures(ctx, path, raw[name]) ?? undefined)
      : undefined;
  },
};
const program = required<readonly [string, ...string[]]>(
  {
    type: "array",
    minItems: 1,
    items: [{ type: "string", minLength: 1 }],
    additionalItems: { type: "string" },
  },
  (v) =>
    Array.isArray(v) &&
    typeof v[0] === "string" &&
    v[0] !== "" &&
    v.every((x) => typeof x === "string")
      ? { value: [v[0], ...v.slice(1)] }
      : {
          error: `run must list the program and its arguments, each a template string, the program first and not empty, got ${describeValue(v)}`,
        },
);
const environment = required<Record<string, string>>(
  {
    type: "object",
    propertyNames: { pattern: ENV_NAME.source },
    additionalProperties: { type: "string" },
  },
  (v) =>
    isPlainObject(v) &&
    Object.entries(v).every(
      ([k, val]) => ENV_NAME.test(k) && typeof val === "string",
    )
      ? { value: v as Record<string, string> }
      : {
          error: `env must map variable names to template strings, got ${describeValue(v)}`,
        },
);
const refresh = required<string[]>(
  { type: "array", items: { type: "string", minLength: 1 } },
  (v) =>
    Array.isArray(v) &&
    v.every((item): item is string => typeof item === "string" && item !== "")
      ? { value: v }
      : {
          error: `refreshes must list the names of the sources the program writes, got ${describeValue(v)}`,
        },
);
const composition = required<readonly [string, ...string[]]>(
  { type: "array", minItems: 2, items: { type: "string", minLength: 1 } },
  (v) =>
    Array.isArray(v) &&
    v.length >= 2 &&
    v.every((item): item is string => typeof item === "string" && item !== "")
      ? { value: [v[0]!, ...v.slice(1)] }
      : {
          error: `do must list at least two action names, got ${describeValue(v)}`,
        },
);
const slash = required<SlashLine>(
  { type: "string", pattern: SLASH_LINE_PATTERN },
  (v) => {
    const parsed = parseSlashLine(v);
    return parsed.kind === "refused"
      ? { error: parsed.reason }
      : { value: parsed.line };
  },
);

interface Arm {
  readonly json: JsonNode;
  parse(
    ctx: ValidateCtx,
    path: string,
    raw: Record<string, unknown>,
    home: ActionHome,
  ): ActionDecl | null;
}
type Specs = Record<string, FieldSpec<unknown>>;
type Parsed<F extends Specs> = {
  [K in keyof F]: F[K] extends FieldSpec<infer V> ? V : never;
};
type Project<F extends Specs> = (
  p: Parsed<F>,
  ctx: ValidateCtx,
  path: string,
  home: ActionHome,
) => ActionDecl | null;

// Optional gesture bindings and the layer an action writes are checked even
// when its source or preset verb fails to select a record.
function sharedFields(key: ActionKey) {
  const layers = LAYER_CHOICES[key];
  const layer =
    layers &&
    defaulted(
      choice(layers, "must be one of " + layers.join(", ")),
      () => DEFAULT_WRITE_LAYER,
    );
  const declared: Specs = { on: gestures };
  if (layer) declared.layer = layer;
  return {
    declared,
    read(ctx: ValidateCtx, path: string, raw: Record<string, unknown>) {
      const on = gestures.parse(ctx, path, "on", raw);
      const resolved = layer?.parse(ctx, path, "layer", raw);
      return {
        ...(on && Object.keys(on).length ? { on } : {}),
        ...(resolved === undefined ? {} : { layer: resolved }),
      };
    },
  };
}

// FieldSpecMap checks the forward mapping from a domain type to its fields.
// Here declared specs are the input and the selected member has their values.
function mapOf<F extends Specs>(specs: F): FieldSpecMap<Parsed<F>> {
  return specs as unknown as FieldSpecMap<Parsed<F>>;
}

// [LAW:single-enforcer] Shared fields join the selected record before either
// interpreter runs. Unknown-key help therefore includes every authored key.
function arm<F extends Specs>(
  key: ActionKey,
  members: F,
  project: Project<F>,
  description?: string,
): Arm {
  const shared = sharedFields(key);
  const declared = { ...members, ...shared.declared };
  const keys = Object.keys(declared);
  return {
    json: {
      ...objectJson(mapOf(declared)),
      ...(description === undefined ? {} : { description }),
    },
    parse(ctx, path, raw, home) {
      const before = ctx.issues.length;
      for (const name of Object.keys(raw)) {
        if (Object.hasOwn(declared, name)) continue;
        issue(
          ctx,
          path + "." + name,
          name === "layer" && !Object.hasOwn(shared.declared, name)
            ? `a ${key} action writes no config, so it names no layer. Expected only: ${keys.join(", ")}`
            : `Unknown key "${name}" on a ${key} action. Expected only: ${keys.join(", ")}`,
        );
      }
      const extras = shared.read(ctx, path, raw);
      const body = fields<Parsed<F>>(ctx, mapOf(members), path, raw);
      if (body === null || ctx.issues.length !== before) return null;
      const action = project(body, ctx, path, home);
      // The writing member's layer has been parsed against its own choices.
      return action === null ? null : Object.assign({}, action, extras);
    },
  };
}
interface Family {
  readonly arms: readonly Arm[];
  select(
    raw: Record<string, unknown>,
    ctx: ValidateCtx,
    path: string,
  ): Arm | { error: string };
}
function sole(a: Arm): Family {
  return { arms: [a], select: () => a };
}
type MarkerKey = "undo" | "redo" | "back" | "rewind" | "save";
type Marker = { [K in MarkerKey]: Record<K, true> }[MarkerKey];
function marker(member: Marker) {
  const key = Object.keys(member)[0] as MarkerKey;
  return sole(
    arm(
      key,
      { [key]: choice([true], "must be the literal true") },
      () => member,
    ),
  );
}
function writes(key: "set" | "persist"): Family {
  const end = key === "set" ? "set-state" : "set-config";
  const destination = wireField(clickValue, key + " key");
  const address = (value: string) =>
    key === "set" ? { set: value } : { persist: value };
  function source<F extends Specs>(
    name: keyof F & string,
    specs: F,
    project: (p: Parsed<F>, destination: string) => ActionDecl,
    check?: (value: Parsed<F>) => string | null,
    description?: string,
  ) {
    return {
      name,
      arm: arm(
        key,
        { [key]: destination, ...specs },
        (p, ctx, path) => {
          const payload: Parsed<F> = p;
          const problem = check?.(payload);
          if (problem) {
            issue(ctx, path + "." + name, problem);
            return null;
          }
          // This computed property is the required string parsed by destination.
          return project(payload, p[key] as string);
        },
        description,
      ),
    };
  }
  const position = {
    anchor: wireField(layoutComponent),
    relation: choice(["before", "after"], 'must be "before" or "after"'),
  };
  const entries = [
    source("to", { to: wireField(clickValue, key + " value") }, (p, v) => ({
      ...address(v),
      to: p.to,
    })),
    source("from", { from: domain(clickValue, end) }, (p, v) => ({
      ...address(v),
      from: p.from,
    })),
    source(
      "min",
      { min: integer, max: integer, by: increment },
      (p, v) => ({ ...address(v), min: p.min, max: p.max, by: p.by }),
      (v) =>
        v.min < v.max
          ? null
          : `min (${v.min}) must be less than max (${v.max})`,
      "The loader requires min to be less than max.",
    ),
    source("cycle", { cycle: words(2, clickValue, end) }, (p, v) => ({
      ...address(v),
      cycle: p.cycle,
    })),
    ...(key === "set"
      ? [
          source(
            "int",
            { int: choice([true], "must be the literal true") },
            (p, set) => ({ set, int: p.int }),
          ),
        ]
      : [
          source(
            "removeSegment",
            { removeSegment: wireField(layoutComponent) },
            (p, persist) => ({ persist, ...p }),
          ),
          source(
            "insertSegment",
            { insertSegment: wireField(layoutComponent), ...position },
            (p, persist) => ({ persist, ...p }),
          ),
          source(
            "insertSegmentFrom",
            { insertSegmentFrom: domain(layoutComponent, end), ...position },
            (p, persist) => ({ persist, ...p }),
          ),
        ]),
  ];
  return {
    arms: entries.map((e) => e.arm),
    select(raw, ctx, path) {
      const found = entries.filter((e) => Object.hasOwn(raw, e.name));
      if (found.length === 1) return found[0]!.arm;
      destination.parse(ctx, path, key, raw);
      return {
        error: `a ${key} action declares exactly one value source: ${entries.map((e) => e.name).join(", ")}${found.length ? " — found: " + found.map((e) => e.name).join(", ") : ""}`,
      };
    },
  };
}
const presetVerbs = {
  save: arm("preset", { preset: choice(["save"], 'must be "save"') }, (p) => p),
  delete: arm(
    "preset",
    { preset: choice(["delete"], 'must be "delete"'), name: text },
    (p) => p,
  ),
};
const registry = {
  set: writes("set"),
  persist: writes("persist"),
  copy: sole(arm("copy", { copy: text }, (p) => p)),
  open: sole(arm("open", { open: text }, (p) => p)),
  reset: sole(
    arm("reset", { reset: wireField(clickValue, "reset key") }, (p) => p),
  ),
  undo: marker({ undo: true }),
  redo: marker({ redo: true }),
  back: marker({ back: true }),
  rewind: marker({ rewind: true }),
  save: marker({ save: true }),
  preset: {
    arms: Object.values(presetVerbs),
    select(raw) {
      const verb = raw.preset;
      return typeof verb === "string" && Object.hasOwn(presetVerbs, verb)
        ? presetVerbs[verb as keyof typeof presetVerbs]
        : {
            error: `preset must be ${Object.keys(presetVerbs)
              .map((name) => JSON.stringify(name))
              .join(" or ")}, got ${describeValue(verb)}`,
          };
    },
  },
  themeDefault: sole(
    arm(
      "themeDefault",
      { themeDefault: choice(["save"], 'must be "save"') },
      (p) => p,
    ),
  ),
  slash: sole(arm("slash", { slash }, (p) => p)),
  run: sole(
    arm(
      "run",
      {
        run: program,
        env: defaulted(environment, () => ({})),
        refreshes: defaulted(refresh, () => []),
      },
      (p, ctx, path, home) => {
        if ("dir" in home) return { ...p, cwd: home.dir };
        issue(
          ctx,
          path + ".run",
          `a run action runs in the directory of the file that declares it, and ${home.text} is no file`,
        );
        return null;
      },
    ),
  ),
  do: sole(arm("do", { do: composition }, (p) => p)),
} satisfies Record<ActionKey, Family>;
const keys = Object.keys(registry) as ActionKey[];

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
  if (Object.hasOwn(raw, "persistWhen")) {
    issue(
      ctx,
      path,
      `${path}.persistWhen was removed: declare the \`set\` alone — a session pick is a draft until a \`{ save: true }\` action writes every unsaved setting to the config file`,
    );
    return null;
  }
  const present = keys.filter((k) => Object.hasOwn(raw, k));
  if (present.length !== 1) {
    issue(
      ctx,
      path,
      `action must declare exactly one of: ${keys.join(", ")}${present.length > 1 ? " (found: " + present.join(", ") + ")" : ""}`,
    );
    return null;
  }
  const selected = registry[present[0]!].select(raw, ctx, path);
  if ("error" in selected) {
    sharedFields(present[0]!).read(ctx, path, raw);
    issue(ctx, path, selected.error);
    return null;
  }
  return selected.parse(ctx, path, raw, home);
}
export function actionsJson(): JsonNode {
  return {
    type: "object",
    additionalProperties: {
      anyOf: Object.values(registry).flatMap((f) => f.arms.map((a) => a.json)),
    },
  };
}
