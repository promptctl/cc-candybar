// [LAW:verifiable-goals] bdi.5 acceptance: formatInteger is RESOLVED to a
// retained JS primitive (Option B), not migrated to a DSL define-template. This
// pins the chosen behavior across the enumerated boundary table on the same
// production path the shipped statusline uses (registerDslConfig → renderDsl,
// merged onto DEFAULT_DSL_CONFIG).
//
// WHY retained (the rejected alternative): formatInteger = n.toLocaleString(),
// whose grouping is locale-correct — it reads the host LANG/LC_* the daemon
// inherits (en_US → "50,000", de_DE → "50.000"). A locale-blind regex helper
// (`regexReplaceAll "\B(?=(\d{3})+(?!\d))" … ","`) is ALWAYS comma+3, a second
// divergent producer of grouping policy ([LAW:one-source-of-truth]) asserting a
// tighter-but-false theorem ("everyone groups comma+3"). So toLocaleString IS
// the dataflow expression locale→string; the host locale is the data. Retained
// as a primitive, exactly like formatModelName at the parsing/formatting line.
//
// The oracle (formatInteger) is RETAINED by this decision, so the parity slot
// asserts the production template path agrees with the JS producer — the
// single-source contract — rather than pinning literals of deleted code. This
// is locale-robust: it holds under whatever locale CI runs. The locale
// SENSITIVITY itself (the retention rationale, what Option A would break) is
// pinned separately below.

import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";

import {
  parseDslConfig,
  mergeWithDefault,
  validateConfig,
} from "../src/config/dsl-loader";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { formatInteger } from "../src/utils/formatters";

const OPTS = {
  style: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  width: Number.POSITIVE_INFINITY,
};
const BASE_PALETTE = new PaletteResolver(getThemePalette("textual-dark")!);

const VARS = `{ n: { kind: "input", path: "n", type: "number", default: 0 } }`;

// Render `{{ formatInteger .n }}` through the production path, merged onto
// DEFAULT_DSL_CONFIG so the shipped FuncMap is in scope. Returns ANSI/OSC-8-
// stripped text.
function render(n: number): string {
  const source = `{
    variables: ${VARS},
    segments: { probe: { template: ${JSON.stringify("[{{ formatInteger .n }}]")} } },
    layout: [["probe"]],
  }`;
  const raw = parseDslConfig("<test>", source);
  const config = validateConfig(
    mergeWithDefault(raw, DEFAULT_DSL_CONFIG),
    "<test>",
    source,
  ) as ValidatedConfig;
  const store = new VariableStore();
  const registry = new SourceRegistry(store);
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp" });
  const out = renderDsl(
    config,
    compiled,
    store,
    registry,
    { n },
    BASE_PALETTE,
    OPTS,
  );
  return out
    .replace(/\x1b\]8;[^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

describe("bdi.5 — formatInteger retained primitive (production path)", () => {
  // The enumerated boundary table from the acceptance: 0, 999 (no group),
  // 1000 (first group), 1_000_000 (two groups), and negatives (sign + groups).
  // Asserted against the retained JS producer so the contract is "the template
  // surface delegates to the locale-correct primitive, with no divergence."
  test.each<number>([0, 999, 1000, 1_000_000, -1234, -1_000_000])(
    "{{ formatInteger %p }} === formatInteger(%p)",
    (n) => {
      expect(render(n)).toContain(`[${formatInteger(n)}]`);
    },
  );
});

// [LAW:one-source-of-truth] The retention rationale, pinned as behavior: the
// primitive is locale-AWARE. toLocaleString with an explicit locale proves the
// grouping separator tracks the locale — the exact property a fixed regex would
// destroy. If a future change swaps formatInteger for a locale-blind helper,
// this documents what was lost (and why the production default, en_US, reads
// "50,000" while a de_DE daemon reads "50.000").
describe("bdi.5 — formatInteger is locale-aware (why it is retained)", () => {
  test("grouping separator tracks locale, not a hardcoded comma", () => {
    expect((50000).toLocaleString("en-US")).toBe("50,000");
    expect((50000).toLocaleString("de-DE")).toBe("50.000");
    // The production primitive uses the host-default locale (no explicit arg),
    // so its separator is whatever the daemon's inherited LANG/LC_* resolves —
    // a single source of truth a fixed regex cannot honor.
    expect(formatInteger(50000)).toBe((50000).toLocaleString());
  });
});
