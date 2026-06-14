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
  formatInteger,
  formatModelName,
  shortenModelName,
} from "../utils/formatters.js";
import { listResolvablePaletteNames, STRIP_STYLES } from "../themes/policy.js";

// [LAW:one-source-of-truth] The DSL `themes()` and `styles()` bindings
// project the SAME canonical sources the set-state validator consults
// (listResolvablePaletteNames / STRIP_STYLES). A picker (or a config that
// `range`s over themes() to emit OSC-8 cells) iterates the allow-list the
// validator will enforce on the resulting click — the list and the gate cannot
// diverge because there is no second list.
//
// Module-init caching is correct by construction: rich-js THEMES is a
// static import (no dynamic palette registration at runtime) and
// STRIP_STYLES is a const array. The "reactivity" requirement from the
// ticket is satisfied vacuously — the lists never change during a
// daemon lifetime, so a cached snapshot IS the current truth.
const THEMES_LIST: readonly string[] = listResolvablePaletteNames();
const STYLES_LIST: readonly string[] = [...STRIP_STYLES];

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

// [LAW:one-source-of-truth] Domain value formatters. What remains after the
// formatting-as-data epic (bdi) are primitives with NO template-native
// expression — the bdi migration is complete. Do NOT migrate these to DSL
// helpers; each one is retained for a load-bearing reason:
//
//   minutesUntilReset — returns a NUMBER for comparisons and arithmetic
//     (`le (minutesUntilReset .x) 8`). A template helper writes to output
//     and cannot return a value, so a helper form would duplicate the formula
//     across every comparison site [LAW:one-source-of-truth].
//
//   formatInteger — locale-aware grouping via toLocaleString(). A regex
//     helper would be locale-blind (always comma+3), a second divergent
//     producer [LAW:one-source-of-truth]. The daemon inherits shell LANG/LC_*
//     from the Rust spawner so grouping honors the user's locale at runtime.
//
//   round — Math.round (half-away-from-zero) consumed in `{{ round .pct }}%`
//     segments. shadows sprigMath's precision-aware round intentionally:
//     block/weekly/context need integer-rounding, not decimal rounding.
//
//   formatModelName / shortenModelName — regex parsing of external model IDs
//     (named capture groups, version assembly, variant stripping). Trust-
//     boundary normalization, not display policy. No regex primitive in DSL.
//
// The display-formatting families moved to DSL helpers in DEFAULT_DSL_CONFIG:
// cost/token/budget (bdi.3), duration/time-remaining (bdi.4).
//
// [LAW:single-enforcer] minutesUntilReset reads "now" from the injected
// `clock` — the SAME seam createCcCandybarEngine threads to sprigDatetime
// (now/unixEpoch) and createEngine. One clock governs every time-dependent
// evaluation; tests inject a frozen clock for determinism.
export function formatterFuncs(clock: () => Date = () => new Date()): FuncMap {
  return {
    // Epoch-seconds → whole minutes until that instant, clamped at 0 for a past
    // expiry: round(max(0, epoch*1000 − now)/60000). Consumed by the block/weekly
    // segments (`formatLongTimeRemaining (minutesUntilReset .resetsAt)`) and the
    // cacheTimer warmth countdown (numeric `le` thresholds).
    minutesUntilReset: {
      fn: (epochSeconds: number | bigint) =>
        Math.round(
          Math.max(0, num(epochSeconds) * 1000 - clock().getTime()) / 60000,
        ),
      argTypes: ["number"],
    },

    // ─── Locale-grouped integer (context's "50,000") ──────────────────
    // [LAW:one-source-of-truth] bdi.5: deliberately RETAINED as a primitive
    // (not migrated to a DSL helper). toLocaleString reads the host locale the
    // daemon inherits, so grouping is locale-correct (en_US "50,000" /
    // de_DE "50.000"). A regex helper would be a second, locale-blind producer
    // of grouping policy — same parsing/formatting boundary that keeps
    // formatModelName here.
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
