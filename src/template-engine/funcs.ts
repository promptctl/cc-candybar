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
  formatDuration,
  formatLongTimeRemaining,
  formatResponseTime,
  formatInteger,
  formatModelName,
  shortenModelName,
  minutesUntilReset,
  formatTimeSince,
} from "../utils/formatters.js";
import { listResolvablePaletteNames, STYLE_ORDER } from "../themes/policy.js";

// [LAW:one-source-of-truth] The DSL `themes()` and `styles()` bindings
// project the SAME canonical sources the set-state validator consults
// (listResolvablePaletteNames / STYLE_ORDER). A picker (or a config that
// `range`s over themes() to emit OSC-8 cells) iterates the allow-list the
// validator will enforce on the resulting click — the list and the gate cannot
// diverge because there is no second list.
//
// Module-init caching is correct by construction: rich-js THEMES is a
// static import (no dynamic palette registration at runtime) and
// STYLE_ORDER is a const array. The "reactivity" requirement from the
// ticket is satisfied vacuously — the lists never change during a
// daemon lifetime, so a cached snapshot IS the current truth.
const THEMES_LIST: readonly string[] = listResolvablePaletteNames();
const STYLES_LIST: readonly string[] = [...STYLE_ORDER];

// Normalize an engine-supplied numeric argument. The "number" argType admits
// both number and bigint (per @promptctl/go-template-js); the underlying
// formatters take a JS number, so collapse bigint here. [LAW:single-enforcer]
// every formatter wrapper goes through this — no per-wrapper bigint check.
//
// [LAW:no-silent-fallbacks] A bigint outside JS's safe-integer range cannot
// round-trip through Number without silent precision loss (53-bit mantissa)
// or overflow to ±Infinity. Either would feed a wrong value into a formatter
// (e.g. formatDuration) and produce confidently-wrong output. Throw at the
// conversion boundary so the failure surfaces where the conversion happens,
// not deep inside a formatter doing math on a corrupted number.
function num(v: number | bigint): number {
  if (typeof v === "bigint") {
    if (
      v > BigInt(Number.MAX_SAFE_INTEGER) ||
      v < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new TypeError(
        `Numeric argument ${v}n is outside JS safe-integer range ` +
          `(|v| > Number.MAX_SAFE_INTEGER = ${Number.MAX_SAFE_INTEGER}); ` +
          `Number(v) would lose precision or overflow. ` +
          `Pass a value within ±Number.MAX_SAFE_INTEGER.`,
      );
    }
    return Number(v);
  }
  return v;
}

// cc-candybar-specific functions not already covered by sprig or Go builtins.
// The engine also includes sprigDefaults(), sprigStrings(), and sprigLists()
// which cover: default, trunc, lower, upper, replace, trim/trimPrefix/trimSuffix,
// split/join, contains/hasPrefix/hasSuffix, has.
// Go builtins cover: printf, eq/ne/lt/gt/le/ge, and/or/not.
export function ccCandybarFuncs(): FuncMap {
  return {
    // Path operations absent from sprig in this package.
    basename: {
      fn: (s: string) => pathBasename(s),
      argTypes: ["string"],
    },
    dirname: {
      fn: (s: string) => pathDirname(s),
      argTypes: ["string"],
    },

    // [LAW:single-enforcer] Type casts delegate to var-system/types.ts.
    // "value" argType: these funcs enforce their own constraints and emit
    // a useful TypeError on ambiguous input — no need for the engine gate
    // to pre-filter (it can't describe the partial-cast semantics anyway).
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

    // [LAW:single-enforcer] One URL-encoding function for click-verb URL
    // construction in templates. encodeURIComponent matches the legacy
    // src/segments/renderer.ts toolbar/tray renderers, so DSL-emitted
    // cc-candybar://verb/<value> URLs are byte-identical to legacy ones.
    // [LAW:types-are-the-program] Domain primitive surfaced by chunk-7/8
    // migration (vhi.3) — the proposal explicitly budgets "may add one or
    // two filters during migration." This is one of those.
    urlEncode: {
      fn: (s: string) => encodeURIComponent(s),
      argTypes: ["string"],
    },

    // [LAW:one-source-of-truth] themes() and styles() are zero-arg
    // projections of the daemon's canonical domain lists. A picker (or a
    // hand-authored `range`) expresses "options come from list Y" by
    // iterating these bindings; the same lists feed the set-state
    // validator's allow-list checks, so the rendered options are exactly
    // the values the next click will be allowed to write. No second
    // enumeration in user config.
    // [LAW:dataflow-not-control-flow] A range loop over a list IS the
    // option primitive — `{{ range themes }}…{{ end }}` produces one
    // rendered cell per allowed value. Adding a theme adds a cell;
    // removing a theme removes a cell; no template branch on "how many
    // themes are there."
    themes: {
      fn: () => THEMES_LIST,
      argTypes: [],
    },
    styles: {
      fn: () => STYLES_LIST,
      argTypes: [],
    },
  };
}

// [LAW:one-source-of-truth] Domain value formatters wrap src/utils/formatters.ts
// without re-deriving the formatting rules. DSL templates that render
// time/locale-grouped values delegate here, so every duration string in the
// bar passes through one formatting definition — drift between segments is
// unrepresentable.
//
// [LAW:dataflow-not-control-flow] Each entry is a thin pure call; the wrapper
// adds the engine FuncMap shape (argTypes + fn) and nothing else. No business
// logic, no defaulting, no null-coalescing — the underlying formatter's
// contract IS the DSL function's contract.
//
// The cost/token/budget family (formatCost, formatTokens, formatTokenCount,
// formatTokenBreakdown, budgetStatus) used to live here too; they moved to
// DSL helper templates (DEFAULT_DSL_CONFIG.helpers) so their display policy is
// data a user can override. What remains are formatters with no template-native
// expression yet (regex model-name parsing, locale grouping, time math).
export function formatterFuncs(): FuncMap {
  return {
    // ─── Duration / time formatters ────────────────────────────────────
    formatDuration: {
      fn: (s: number | bigint) => formatDuration(num(s)),
      argTypes: ["number"],
    },
    formatLongTimeRemaining: {
      fn: (m: number | bigint) => formatLongTimeRemaining(num(m)),
      argTypes: ["number"],
    },
    formatResponseTime: {
      fn: (s: number | bigint) => formatResponseTime(num(s)),
      argTypes: ["number"],
    },
    // Seconds-since-last-commit → compact "12m"/"3h"/"2d" for the custom git
    // segment's time-since-commit affordance.
    formatTimeSince: {
      fn: (s: number | bigint) => formatTimeSince(num(s)),
      argTypes: ["number"],
    },
    // Epoch-seconds → minutes until reset, used by the weekly segment so the
    // template can chain `formatLongTimeRemaining (minutesUntilReset .resets_at)`
    // exactly like the legacy renderer composes the two.
    minutesUntilReset: {
      fn: (epochSeconds: number | bigint) =>
        minutesUntilReset(num(epochSeconds)),
      argTypes: ["number"],
    },

    // ─── Locale-grouped integer (context's "50,000") ──────────────────
    formatInteger: {
      fn: (n: number | bigint) => formatInteger(num(n)),
      argTypes: ["number"],
    },

    // ─── Numeric helper (block/weekly's Math.round of pct) ────────────
    // [LAW:one-source-of-truth] Math.round is a JS built-in shared between
    // legacy and DSL — no wrapper indirection makes sense for it. The
    // formatters.ts module documents domain-meaningful rules; rounding is
    // not domain-meaningful, so it stays here.
    round: {
      fn: (n: number | bigint) => Math.round(num(n)),
      argTypes: ["number"],
    },

    // ─── Model-name normalizers (chunk-7 model dsl-pending → dsl-parity) ─
    // [LAW:one-source-of-truth] formatModelName / shortenModelName are regex-
    // based normalizers; the DSL function set has no regex primitive, so the
    // only honest way to express them is to wrap the canonical impls. The
    // model binding can then move from "echo display_name verbatim" (only
    // byte-parity for friendly names) to "echo normalized model name" (full
    // behavioral parity, including raw IDs like "claude-sonnet-4-6").
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
