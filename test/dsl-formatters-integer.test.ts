import { SessionState } from "../src/daemon/session-state";
import { getThemePalette } from "@promptctl/rich-js";

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
  colorCompatibility: "truecolor" as const, wrap: true, padding: 0, charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};
const BASE_PALETTE = getThemePalette("textual-dark"!);

const VARS = `{ n: { kind: "input", path: "n", type: "number", default: 0 } }`;

// Merged onto DEFAULT_DSL_CONFIG so the shipped FuncMap is in scope.
function render(n: number): string {
  const source = `{
    variables: ${VARS},
    segments: { probe: { template: ${JSON.stringify("[{{ formatInteger .n }}]")} } },
    root: "probe",
  }`;
  const raw = parseDslConfig("<test>", source);
  const config = validateConfig(
    mergeWithDefault(raw, DEFAULT_DSL_CONFIG),
    "<test>",
    source,
  ) as ValidatedConfig;
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
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
  // Asserted against the JS producer, so the contract is "no divergence" — not a literal.
  test.each<number>([0, 999, 1000, 1_000_000, -1234, -1_000_000])(
    "{{ formatInteger %p }} === formatInteger(%p)",
    (n) => {
      expect(render(n)).toContain(`[${formatInteger(n)}]`);
    },
  );
});

// [LAW:one-source-of-truth] The primitive is locale-AWARE — the exact property a
// fixed grouping regex would destroy.
describe("bdi.5 — formatInteger is locale-aware (why it is retained)", () => {
  test("grouping separator tracks locale, not a hardcoded comma", () => {
    expect((50000).toLocaleString("en-US")).toBe("50,000");
    expect((50000).toLocaleString("de-DE")).toBe("50.000");
    // The production primitive takes the host-default locale, whatever LANG/LC_* resolves.
    expect(formatInteger(50000)).toBe((50000).toLocaleString());
  });
});
