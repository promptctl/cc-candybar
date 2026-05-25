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
  formatCost,
  formatTokens,
  formatTokenCount,
  formatDuration,
  formatLongTimeRemaining,
  formatResponseTime,
  formatInteger,
  formatModelName,
  shortenModelName,
  minutesUntilReset,
} from "../utils/formatters.js";
import { getBudgetStatus } from "../utils/budget.js";

// Normalize an engine-supplied numeric argument. The "number" argType admits
// both number and bigint (per @promptctl/go-template-js); the underlying
// formatters take a JS number, so collapse bigint here. [LAW:single-enforcer]
// every formatter wrapper goes through this — no per-wrapper bigint check.
function num(v: number | bigint): number {
  return typeof v === "bigint" ? Number(v) : v;
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
  };
}

// [LAW:one-source-of-truth] Domain value formatters wrap src/utils/formatters.ts
// (and src/utils/budget.ts) without re-deriving the formatting rules. DSL
// templates that render usage/cost/time/locale-grouped values delegate here, so
// the DSL and the legacy SegmentRenderer share one definition of "how to
// display a token count" etc. — byte-parity holds by construction, not by
// the DSL re-implementing the rule and getting lucky.
//
// [LAW:dataflow-not-control-flow] Each entry is a thin pure call; the wrapper
// adds the engine FuncMap shape (argTypes + fn) and nothing else. No business
// logic, no defaulting, no null-coalescing — the underlying formatter's
// contract IS the DSL function's contract.
//
// Surfaced by chunk-7 segment migration (lit brandon-segment-dsl-migration-bzh.5):
// the usage/cost/time/locale family of built-in segments (session, today, block,
// weekly, context, metrics) could not reach dsl-parity without these.
export function formatterFuncs(): FuncMap {
  return {
    // ─── Cost / token value formatters ─────────────────────────────────
    formatCost: {
      fn: (n: number | bigint) => formatCost(num(n)),
      argTypes: ["number"],
    },
    formatTokens: {
      fn: (n: number | bigint) => formatTokens(num(n)),
      argTypes: ["number"],
    },
    formatTokenCount: {
      fn: (n: number | bigint) => formatTokenCount(num(n)),
      argTypes: ["number"],
    },

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

    // ─── Budget-status suffix (today's " 9%") ──────────────────────────
    // Returns the displayText field of getBudgetStatus — an empty string when
    // the inputs make the status non-displayable (no budget, negative cost),
    // a " <pct>%" / " +<pct>%" / " !<pct>%" suffix otherwise. The legacy
    // formatUsageWithBudget concatenates this same field unconditionally;
    // wrapping it preserves byte-parity (incl. the empty-string non-display
    // case) without the DSL re-implementing the warning-threshold logic.
    budgetStatus: {
      fn: (
        cost: number | bigint,
        budget: number | bigint,
        warningThreshold: number | bigint,
      ) =>
        getBudgetStatus(num(cost), num(budget), num(warningThreshold))
          .displayText,
      argTypes: ["number", "number", "number"],
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
