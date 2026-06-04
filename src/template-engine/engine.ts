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
//  • richTextFuncs: bold, italic, red, green, … (styling from rich-js).
//  • paletteFuncs (when resolver provided): primary, accent, palette, paletteOver, auto.
//  • ccCandybarFuncs: basename, dirname, int, string, bool, urlEncode.
//  • formatterFuncs: formatCost, formatTokens, formatTokenCount, formatDuration,
//    formatLongTimeRemaining, formatResponseTime, minutesUntilReset,
//    formatInteger, round, budgetStatus, formatModelName, shortenModelName.

import {
  createEngine,
  type Engine,
  type FuncMap,
  sprigDefaults,
  sprigStrings,
  sprigLists,
} from "@promptctl/go-template-js";
import type { PaletteResolver } from "@promptctl/rich-js";
import { richTextFuncs, RichText } from "@promptctl/rich-js";
import { paletteFuncs } from "@promptctl/rich-js/template-bindings";
import { ccCandybarFuncs, formatterFuncs } from "./funcs.js";

// [LAW:single-enforcer] fromString/toString are declared once here.
// richTextFuncs() provides style functions (bold, red, link, …).
// paletteFuncs(resolver) registers semantic palette functions when a theme
// resolver is provided — same engine instance, no second parse path.
// [LAW:one-way-deps] `extraFuncs` is an INJECTED FuncMap (e.g. the action +
// picker feature funcs, built in render/action.ts + render/picker.ts). The
// generic engine never imports a specific feature — the caller hands it the
// capability as data, so the dependency runs caller → engine, never engine → feature.
// [LAW:one-type-per-behavior] resolver?/extraFuncs? are values, not modes —
// one factory, one engine shape; the data (their presence) governs what's
// registered.
export function createCcCandybarEngine(
  resolver?: PaletteResolver,
  extraFuncs?: FuncMap,
): Engine<RichText> {
  return createEngine<RichText>({
    fromString: (s) => new RichText(s),
    toString: (rt) => rt.plain,
    // [LAW:no-defensive-null-guards] missing fields must throw at the boundary,
    // not silently produce "<no value>". Callers (SourceRegistry, segments)
    // depend on MissingFieldError to drive varDefault / defaultEmptyValue.
    missingKey: "error",
    funcs: {
      ...sprigDefaults(),
      ...sprigStrings(),
      ...sprigLists(),
      ...richTextFuncs(),
      ...(resolver !== undefined ? paletteFuncs(resolver) : {}),
      // Domain-specific overrides last (wins on collision with sprig aliases).
      ...ccCandybarFuncs(),
      // [LAW:one-source-of-truth] formatter wrappers delegate to
      // src/utils/formatters.ts (and src/utils/budget.ts); no name collides
      // with sprig or ccCandybarFuncs.
      ...formatterFuncs(),
      // [LAW:locality-or-seam] Injected feature funcs (the daemon's per-config
      // engine supplies the `action` + `picker` funcs; resolver-less compile-only
      // paths do not). Last so a feature can override on collision.
      ...(extraFuncs ?? {}),
    },
  });
}
