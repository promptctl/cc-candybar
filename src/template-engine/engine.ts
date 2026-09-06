// [LAW:one-source-of-truth] One Engine instance covers all segment template
// evaluation. Callers parse their template once (engine.parse(src)) and call
// template.evaluate(scope) per render — the expensive parse step is not
// repeated per render cycle.
//
// Function registry (closed set for cc-candybar):
//  • Go builtins (always registered by the engine): printf, print, println,
//    eq/ne/lt/gt/le/ge, and/or/not, len, index, slice, call.
//  • sprigDefaults: default, empty, coalesce, ternary, fromJson, toJson.
//  • sprigStrings: trunc, lower, upper, replace, trim/trimPrefix/trimSuffix,
//    split/join, contains, hasPrefix, hasSuffix, and more string utils.
//  • sprigLists: has (membership test: `has "v" $list`).
//  • sprigMath: add, sub, mul, div, mod, floor, ceil, round, min, max,
//    seq, until (round here is shadowed by formatterFuncs' Math.round below).
//  • sprigDatetime(clock): now, date, ago, unixEpoch, dateInZone, dateModify,
//    toDate, duration — all reading "now" through the injected clock seam.
//  • sprigConversions: atoi, int, int64, float64, toString, toStrings
//    (int here is shadowed by ccCandybarFuncs' var-system cast below).
//  • sprigDicts: dict, get, set, keys, values, pick, omit, hasKey, merge —
//    `dict` lets a helper take multiple named inputs through its one dot arg.
//  • richTextFuncs: fg, bg, bold, italic, link, style (painting) PLUS the
//    palette-free color math (darken, lighten, mix, contrastOn, readableOn,
//    shiftHue, scaleChroma, scaleLightness, shiftLightness) — all from rich-js.
//    Naming a THEME color (`{{ color "primary" }}`) and asking for the current
//    segment's background (`{{ bgOf }}`) are segment-scoped, so they arrive
//    through `extraFuncs` from the DSL render layer, which is the only place
//    that knows which segment is rendering.
//  • ccCandybarFuncs: basename, dirname, int, string, bool, urlEncode,
//    themes, styles, sparkline.
//  • formatterFuncs: minutesUntilReset (clock-reading numeric primitive),
//    formatInteger, round, formatModelName, shortenModelName. (The cost/token/
//    budget AND duration/time-remaining formatters moved to DSL helper templates
//    — see DEFAULT_DSL_CONFIG.helpers.)

import {
  createEngine,
  type Engine,
  type FuncMap,
  sprigDefaults,
  sprigStrings,
  sprigLists,
  sprigMath,
  sprigDatetime,
  sprigConversions,
  sprigDicts,
} from "@promptctl/go-template-js";
import { richTextFuncs, RichText } from "@promptctl/rich-js";
import { ccCandybarFuncs, formatterFuncs } from "./funcs.js";

// [LAW:single-enforcer] fromString/toString are declared once here.
// richTextFuncs() provides the theme-independent vocabulary: painting, color
// math, attributes, links. It needs no configuration, so it is unconditional.
// [LAW:one-way-deps] `extraFuncs` is an INJECTED FuncMap (e.g. the action +
// picker feature funcs, built in render/action.ts + render/picker.ts). The
// generic engine never imports a specific feature — the caller hands it the
// capability as data, so the dependency runs caller → engine, never engine → feature.
// [LAW:one-type-per-behavior] extraFuncs? is a value, not a mode — one factory,
// one engine shape; the data (its presence) governs what's registered.
// [LAW:single-enforcer] `clock` is the one time source. It feeds sprigDatetime
// (the funcs that read "now") AND createEngine's clock option, so every
// time-dependent evaluation in this engine reads from one seam. Defaulted here
// so the default literal `() => new Date()` lives in exactly one place; callers
// that omit it (and forwarders passing `undefined`) inherit it unchanged.
export function createCcCandybarEngine(
  extraFuncs?: FuncMap,
  clock: () => Date = () => new Date(),
): Engine<RichText> {
  return createEngine<RichText>({
    fromString: (s) => new RichText(s),
    toString: (rt) => rt.plain,
    // A bare document in a template (`{{ .doc }}` for `{{ .doc.field }}`)
    // prints as Go prints a map, instead of leaking the object into the
    // fragments as if it were text.
    isT: (v): v is RichText => v instanceof RichText,
    clock,
    // [LAW:no-defensive-null-guards] missing fields must throw at the boundary,
    // not silently produce "<no value>". Callers (SourceRegistry, segments)
    // depend on MissingFieldError to drive varDefault / defaultEmptyValue.
    missingKey: "error",
    funcs: {
      ...sprigDefaults(),
      ...sprigStrings(),
      ...sprigLists(),
      ...sprigMath(),
      // [LAW:single-enforcer] one clock seam: the same source createEngine holds.
      ...sprigDatetime(clock),
      ...sprigConversions(),
      // [LAW:types-are-the-program] `dict` is the substrate primitive a helper
      // uses to receive more than one input through its single dot arg:
      // `{{ template "budgetStatus" (dict "cost" .x "budget" .y "warn" .z) }}`.
      // It makes a multi-input formatter's domain exactly {named scalars},
      // decoupled from any payload's nesting — no per-payload helper variant.
      ...sprigDicts(),
      ...richTextFuncs(),
      // Domain-specific overrides last (wins on collision with sprig aliases).
      // [LAW:one-source-of-truth] ccCandybarFuncs' `int` is the var-system cast
      // (toNumber over VarValue); it intentionally shadows sprigConversions' `int`
      // so a template's `int` keeps one meaning. Position is the override policy.
      ...ccCandybarFuncs(),
      // [LAW:one-source-of-truth] formatter funcs delegate to
      // src/utils/formatters.ts; minutesUntilReset reads the same `clock` seam.
      // The only sprig collision is `round`: formatterFuncs' Math.round shadows
      // sprigMath's precision-aware round, registered last so the domain meaning
      // wins (revisited by the bdi cleanup ticket).
      ...formatterFuncs(clock),
      // [LAW:locality-or-seam] Injected feature funcs (the daemon's per-config
      // engine supplies the `action` + `picker` funcs; resolver-less compile-only
      // paths do not). Last so a feature can override on collision.
      ...(extraFuncs ?? {}),
    },
  });
}
