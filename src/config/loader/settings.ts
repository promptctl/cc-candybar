// [LAW:types-are-the-program] Per-placement settings at the load boundary
// (brandon-segment-settings-i4n): a segment's `settings` DECLARATION, and the
// two fields a placement in `root` may carry — its `id` and its setting
// values. Structural only: whether a placement's value is one its segment
// declares, and inside that setting's domain, is a question about the MERGED
// config (a file may place a bundled segment), so cross-ref.ts asks it.
// This file changes when the setting grammar does.

import {
  inSettingDomain,
  THEME_SETTING,
  describeSettingDomain,
  type SettingDecl,
  type SettingValue,
} from "../dsl-types.js";
import { findKeyLine } from "./diagnostics.js";
import {
  describeType,
  describeValue,
  isPlainObject,
  type FieldSpec,
  type ValidateCtx,
} from "./validate-core.js";

// A setting's name is read in a template as `.settings.<name>`, so it must be
// a field name the template engine parses.
const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETTING_NAME_JSON = { pattern: SETTING_NAME.source };

const SETTING_VALUE_JSON = {
  anyOf: [{ type: "boolean" }, { type: "string" }, { type: "integer" }],
};

const SETTING_DECL_JSON = {
  type: "object",
  additionalProperties: false,
  required: ["label", "domain", "default"],
  properties: {
    label: { type: "string", pattern: "^[^\\n\\r]+$" },
    domain: {
      anyOf: [
        { const: "bool" },
        {
          type: "array",
          items: { type: "string", pattern: "^[^/\\n\\r]+$" },
          minItems: 1,
          uniqueItems: true,
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["min", "max"],
          properties: {
            min: { type: "integer" },
            max: { type: "integer" },
            step: { type: "integer", minimum: 1 },
            atLeast: { type: "string", ...SETTING_NAME_JSON },
          },
        },
      ],
    },
    default: SETTING_VALUE_JSON,
  },
};

const DECL_KEYS = ["label", "domain", "default"];
const RANGE_KEYS = ["min", "max", "step", "atLeast"];

function issue(ctx: ValidateCtx, path: string, message: string): undefined {
  ctx.issues.push({
    path,
    message,
    line: findKeyLine(ctx.source, path.split(".")),
  });
  return undefined;
}

// [LAW:parse-dont-validate] The authored domain, parsed into the arm of
// SettingDecl it names. `undefined` means an issue was pushed.
function parseDomain(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): SettingDecl["domain"] | undefined {
  if (raw === "bool") return "bool";
  if (Array.isArray(raw)) {
    const words = raw.filter((m): m is string => typeof m === "string");
    if (raw.length === 0 || words.length !== raw.length) {
      return issue(
        ctx,
        path,
        `a list domain must be a non-empty list of words, got ${JSON.stringify(raw)}`,
      );
    }
    if (new Set(words).size !== words.length) {
      return issue(
        ctx,
        path,
        `a list domain names each word once, got ${JSON.stringify(raw)}`,
      );
    }
    // [LAW:no-silent-failure] A word is a deliverable set-state value —
    // configure mode's control writes it on the wire, which rejects empty
    // values and splits on "/" — and display text spliced into a template
    // string, which a newline would leave unterminated. The rule preset names
    // keep (presets.ts), for the same two reasons.
    const unwritable = words.filter(
      (w) => w === "" || w.includes("/") || /[\n\r]/.test(w),
    );
    if (unwritable.length > 0) {
      return issue(
        ctx,
        path,
        `a list domain's words must be non-empty, slash-free, and newline-free — configure mode writes each on the set-state wire — got ${JSON.stringify(unwritable)}`,
      );
    }
    return words;
  }
  if (isPlainObject(raw)) {
    const { min, max, step = 1, atLeast } = raw;
    const extra = Object.keys(raw).filter((k) => !RANGE_KEYS.includes(k));
    if (
      extra.length === 0 &&
      Number.isInteger(min) &&
      Number.isInteger(max) &&
      (min as number) <= (max as number) &&
      Number.isInteger(step) &&
      (step as number) >= 1 &&
      (atLeast === undefined || typeof atLeast === "string")
    ) {
      return {
        min: min as number,
        max: max as number,
        step: step as number,
        ...(atLeast !== undefined && { atLeast }),
      };
    }
    return issue(
      ctx,
      path,
      `a range domain is { min, max, step?, atLeast? } with integers min ≤ max, a whole step ≥ 1, and atLeast naming another range setting, got ${JSON.stringify(raw)}`,
    );
  }
  return issue(
    ctx,
    path,
    `domain must be "bool", a list of words, or { min, max }, got ${describeValue(raw)}`,
  );
}

function parseSettingDecl(
  ctx: ValidateCtx,
  path: string,
  raw: unknown,
): SettingDecl | undefined {
  if (!isPlainObject(raw)) {
    return issue(
      ctx,
      path,
      `${path} must be { label, domain, default }, got ${describeType(raw)}`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!DECL_KEYS.includes(key)) {
      issue(
        ctx,
        `${path}.${key}`,
        `Unknown setting key "${key}". Expected one of: ${DECL_KEYS.join(", ")}`,
      );
    }
  }
  const { label } = raw;
  const labelOk =
    typeof label === "string" && label.length > 0 && !/[\n\r]/.test(label);
  if (!labelOk) {
    issue(
      ctx,
      `${path}.label`,
      `a setting needs a one-line, non-empty "label" — the name its control shows, spliced into a synthesized template string — got ${describeValue(label)}`,
    );
  }
  const domain = parseDomain(ctx, `${path}.domain`, raw.domain);
  if (!labelOk || domain === undefined) return undefined;
  // The arm is chosen by the parsed domain; the default is admitted only when
  // it is a member, which is what makes the arm's default type true.
  const decl = { label, domain, default: raw.default } as SettingDecl;
  if (!isSettingValue(raw.default) || !inSettingDomain(decl, raw.default)) {
    return issue(
      ctx,
      `${path}.default`,
      `default must be ${describeSettingDomain(decl)}, got ${describeValue(raw.default)}`,
    );
  }
  return decl;
}

export function isSettingValue(v: unknown): v is SettingValue {
  return (
    typeof v === "boolean" || typeof v === "string" || typeof v === "number"
  );
}

// A segment's `settings` block: name → declaration.
export function settingsDeclSpec(): FieldSpec<
  Readonly<Record<string, SettingDecl>>
> {
  return {
    required: false,
    json: {
      type: "object",
      propertyNames: {
        ...SETTING_NAME_JSON,
        not: { const: THEME_SETTING },
      },
      additionalProperties: SETTING_DECL_JSON,
    },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      const at = `${path}.${field}`;
      if (!isPlainObject(v)) {
        return issue(
          ctx,
          at,
          `${at} must be an object of name → { label, domain, default }, got ${describeType(v)}`,
        );
      }
      const out = Object.create(null) as Record<string, SettingDecl>;
      for (const [name, decl] of Object.entries(v)) {
        if (!SETTING_NAME.test(name)) {
          issue(
            ctx,
            `${at}.${name}`,
            `setting name "${name}" is read as .settings.${name} in a template, so it must be an identifier (letters, digits, _; not starting with a digit)`,
          );
          continue;
        }
        // [LAW:one-source-of-truth] Every placement already has `theme`
        // (settingsOf); a declaration of its own would be a second one.
        if (name === THEME_SETTING) {
          issue(
            ctx,
            `${at}.${name}`,
            `setting "${THEME_SETTING}" is one every placement already has — its default for this segment is segments.<name>.palette, and a placement sets its own with settings: { ${THEME_SETTING}: "<theme>" }`,
          );
          continue;
        }
        const parsed = parseSettingDecl(ctx, `${at}.${name}`, decl);
        if (parsed !== undefined) out[name] = parsed;
      }
      return out;
    },
  };
}

// A placement's `id`. It rides the click wire inside a layout-op token, whose
// delimiters are `/` and `:` (layout-ops.ts), so it may hold neither.
export function placementIdSpec(): FieldSpec<string> {
  return {
    required: false,
    json: { type: "string", minLength: 1, pattern: "^[^:/]+$" },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      if (typeof v === "string" && v.length > 0 && !/[:/]/.test(v)) return v;
      return issue(
        ctx,
        `${path}.${field}`,
        `a placement "id" must be a non-empty string without "/" or ":", got ${describeValue(v)}`,
      );
    },
  };
}

// A placement's setting values: name → value. Which names the segment
// declares, and each value's domain, are checked on the merged config.
export function placementSettingsSpec(): FieldSpec<
  Readonly<Record<string, SettingValue>>
> {
  return {
    required: false,
    json: {
      type: "object",
      propertyNames: SETTING_NAME_JSON,
      additionalProperties: SETTING_VALUE_JSON,
    },
    parse: (ctx, path, field, raw) => {
      const v = raw[field];
      if (v === undefined) return undefined;
      const at = `${path}.${field}`;
      if (!isPlainObject(v)) {
        return issue(
          ctx,
          at,
          `a placement's "settings" must be an object of setting name → value, got ${describeType(v)}`,
        );
      }
      const out = Object.create(null) as Record<string, SettingValue>;
      for (const [name, value] of Object.entries(v)) {
        if (isSettingValue(value)) out[name] = value;
        else
          issue(
            ctx,
            `${at}.${name}`,
            `setting "${name}" must be a boolean, a word, or a number, got ${describeType(value)}`,
          );
      }
      return out;
    },
  };
}
