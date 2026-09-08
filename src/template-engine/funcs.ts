// [LAW:one-source-of-truth] Cast semantics live in var-system/types.ts.
// This module wraps them as FuncMap entries — it does not duplicate logic.
// [LAW:single-enforcer] The boundary gate (argTypes) lives at the engine
// dispatch site; the bodies here trust the runtime types they declared.

import { basename as pathBasename, dirname as pathDirname } from "path";
import type { FuncMap } from "@promptctl/go-template-js";
import {
  toNumber,
  toString,
  toBool,
  type VarValue,
} from "../var-system/types.js";
import {
  abbreviatePath,
  formatInteger,
  formatModelName,
  shortenModelName,
} from "../utils/formatters.js";
import { listResolvablePaletteNames, STRIP_STYLES } from "../themes/policy.js";
import { renderSparkline, parseSeries } from "./sparkline.js";

// [LAW:one-source-of-truth] The same lists the set-state validator consults, so
// rendered options and the gate cannot diverge. Both are static for a daemon's life.
const THEMES_LIST: readonly string[] = listResolvablePaletteNames();
const STYLES_LIST: readonly string[] = [...STRIP_STYLES];

// [LAW:single-enforcer] Numeric validation lives at ONE boundary, the engine's
// `int`/`float` argType gate, so a body below receives a clean `number` and needs
// no bigint guard of its own.

export function ccCandybarFuncs(): FuncMap {
  return {
    basename: {
      fn: (s: string) => pathBasename(s),
      argTypes: ["string"],
    },
    dirname: {
      fn: (s: string) => pathDirname(s),
      argTypes: ["string"],
    },

    // [LAW:decomposition] Composes over the directory template's already-collapsed output, never duplicating it.
    abbreviatePath: {
      fn: (s: string) => abbreviatePath(s),
      argTypes: ["string"],
    },

    // [LAW:single-enforcer] Casts delegate to var-system/types.ts; the "value"
    // argType because the engine gate cannot describe partial-cast semantics.
    int: {
      fn: (v: VarValue) => toNumber(v),
      argTypes: ["value"],
    },
    string: {
      fn: (v: VarValue) => toString(v),
      argTypes: ["value"],
    },
    bool: {
      fn: (v: VarValue) => toBool(v),
      argTypes: ["value"],
    },

    // [LAW:single-enforcer] The one URL-encoding function for click-verb URLs.
    urlEncode: {
      fn: (s: string) => encodeURIComponent(s),
      argTypes: ["string"],
    },

    // [LAW:dataflow-not-control-flow] A range over one of these lists IS the option
    // primitive: adding a value adds a cell, with no branch on how many there are.
    themes: {
      fn: () => THEMES_LIST,
      argTypes: [],
    },
    styles: {
      fn: () => STYLES_LIST,
      argTypes: [],
    },

    // [LAW:effects-at-boundaries] The series crosses the scalar var-system seam as a
    // delimited string, hence the "string" slot; the optional int caps the glyph count.
    sparkline: {
      fn: (series: string, width?: number) =>
        renderSparkline(parseSeries(series), width),
      argTypes: ["string", "int"],
    },
  };
}

// [LAW:one-source-of-truth] Do NOT migrate these to DSL helpers: each has no
// template-native expression. A helper writes to output and cannot RETURN a value,
// so minutesUntilReset's formula would be duplicated at every comparison site.
// [LAW:single-enforcer] Its "now" comes from the one injected `clock`.
export function formatterFuncs(clock: () => Date = () => new Date()): FuncMap {
  return {
    minutesUntilReset: {
      fn: (epochSeconds: number) =>
        Math.round(
          Math.max(0, epochSeconds * 1000 - clock().getTime()) / 60000,
        ),
      // [LAW:types-are-the-program] An epoch is integer-valued; the gate rejects the rest.
      argTypes: ["int"],
    },

    // [LAW:one-source-of-truth] toLocaleString reads the host locale; a regex helper would be a second, locale-blind producer.
    formatInteger: {
      fn: (n: number) => formatInteger(n),
      argTypes: ["int"],
    },

    // Shadows sprigMath's precision-aware round: block/weekly/context want integer rounding.
    round: {
      fn: (n: number) => Math.round(n),
      argTypes: ["float"],
    },

    // [LAW:one-source-of-truth] Regex normalizers over external model IDs; the DSL has no regex primitive to express them.
    formatModelName: {
      fn: (raw: string) => formatModelName(raw),
      argTypes: ["string"],
    },
    shortenModelName: {
      fn: (formatted: string) => shortenModelName(formatted),
      argTypes: ["string"],
    },
  };
}
