// [LAW:types-are-the-program] The `looks` schema: each look is a named rich-js
// ThemeKey — an ADAPTATION applied on top of whatever base theme is active (a
// transform, not a palette), so one look composes with every theme. The config
// spelling mirrors ThemeKey's field names VERBATIM (hueShift / chromaScale /
// lightnessScale / lightnessShift) and the parsed output IS a rich-js ThemeKey —
// no translation layer to drift, and a rich-js field rename fails this module's
// compile instead of silently diverging. [LAW:one-source-of-truth]
//
// The adaptation vocabulary is CAPPED at ThemeKey's four axes. Role remap (the
// old surface/button "role emphasis") is deferred; its exit plan is a future
// rich-js resolver-level role→role operation carried as an additive `roles`
// field here — growing the vocabulary means growing rich-js, never adding color
// math to cc-candybar.

import type { ThemeKey } from "@promptctl/rich-js";
import { IDENTITY } from "@promptctl/rich-js";
import {
  describeType,
  isPlainObject,
  optionalNumberSpec,
  record,
  recordJson,
  type JsonNode,
  type RecordSchema,
  type ValidateCtx,
} from "./validate-core.js";
import { findKeyLine } from "./diagnostics.js";

// [LAW:types-are-the-program] The AUTHORING shape: every axis optional, absent =
// identity. Distinct from ThemeKey (all fields required) so the record engine's
// omit-absent output is honestly typed; validateLooks normalizes each parsed
// spec onto IDENTITY, and past this module a partial look is unrepresentable.
interface LookSpec {
  readonly hueShift?: number;
  readonly chromaScale?: number;
  readonly lightnessScale?: number;
  readonly lightnessShift?: number;
}

// [LAW:one-source-of-truth] The four axes, declared once as DATA the record
// engine interprets for both validation and schema emit. chromaScale is a
// multiplier on saturation — negative chroma is not a color, so the one bound.
const LOOK_SCHEMA: RecordSchema<LookSpec> = {
  noun: "look key",
  fields: {
    hueShift: optionalNumberSpec(),
    chromaScale: optionalNumberSpec({ min: 0 }),
    lightnessScale: optionalNumberSpec(),
    lightnessShift: optionalNumberSpec(),
  },
};

// An absent looks block is handled by the caller (absence survives the parse);
// a non-object is a reported error recovering to empty — parseDslConfig throws
// once any issue exists, so the recovery value never renders.
export function validateLooks(
  ctx: ValidateCtx,
  raw: unknown,
): Readonly<Record<string, ThemeKey>> {
  if (!isPlainObject(raw)) {
    ctx.issues.push({
      path: "looks",
      message: `looks must be an object mapping look names to adaptation objects, got ${describeType(raw)}`,
      line: findKeyLine(ctx.source, ["looks"]),
    });
    return {};
  }
  const out: Record<string, ThemeKey> = {};
  for (const [name, value] of Object.entries(raw)) {
    // [LAW:no-silent-fallbacks] A look name is a deliverable set-state value —
    // a look picker writes it on the wire, which rejects empty values and
    // splits on "/". Rejecting the shape HERE surfaces the error on every
    // config load, not only once an action ranges the "looks" domain (the same
    // wire shape cycle members and `to` literals enforce in actions.ts).
    if (name === "" || name.includes("/")) {
      ctx.issues.push({
        path: `looks.${name}`,
        message: `look name ${JSON.stringify(name)} must be non-empty and slash-free — a look picker writes the name on the set-state wire, which rejects empty values and splits on "/"`,
        line: findKeyLine(ctx.source, ["looks", name]),
      });
      continue;
    }
    const parsed = record(ctx, LOOK_SCHEMA, `looks.${name}`, value);
    // [LAW:one-source-of-truth] Normalization onto IDENTITY is the single
    // "absent axis = identity" site — downstream consumers receive a total
    // ThemeKey and never re-default a missing axis.
    if (parsed !== null) out[name] = { ...IDENTITY, ...parsed };
  }
  return out;
}

// [LAW:one-source-of-truth] The schema emitter derives from the SAME declaration
// the validator interprets — a map of look names to the closed four-axis object.
export function looksJson(): JsonNode {
  return { type: "object", additionalProperties: recordJson(LOOK_SCHEMA) };
}
