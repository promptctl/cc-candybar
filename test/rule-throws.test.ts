// [LAW:verifiable-goals] brandon-unfiled-3248.2gq: a globals rule — `style`,
// `palette` or `effect` — whose template throws when it is evaluated renders
// that slot's floor and reports a `rule` warning naming where it was written,
// rather than throwing out of drawDsl and taking the whole bar away. A
// failing segment costs one ⚠ cell; a failing rule costs its slot.
//
// [LAW:single-enforcer] Drives the real spine — parse/merge/validate, then
// registerDslConfig + drawDsl, the style resolved as src/daemon/draw-bar.ts
// resolves it and the theme and effect from the config's own globals.

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, type RenderWarning } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { EFFECT_FLOOR, STYLE_FLOOR, THEME_FLOOR } from "../src/themes";
import { instantOf } from "../src/utils/instant";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};

const ALLOWED = new Set<string>([THEME_FLOOR, "nord"]);

const src = (slot: string, rule: string): string => `{
  globals: { ${slot}: '${rule}' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'ctx.pct': { kind: 'input', path: 'ctx.pct', type: 'number', default: 0 },
    'theme.effective': { kind: 'input', path: 'theme.effective', default: '' },
    'style.effective': { kind: 'input', path: 'style.effective', default: '' },
    'effect.effective': { kind: 'input', path: 'effect.effective', default: '' },
  },
  segments: {
    label: {
      template: 'T={{ .theme.effective }} S={{ .style.effective }} E={{ .effect.effective }}',
      bg: 'surface',
      fg: 'foreground',
    },
  },
  root: { h: ['label'] },
}`;

function runtime(source: string) {
  const config = parseAndValidate("<rule-throws>", source, ALLOWED);
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  const warnings: RenderWarning[] = [];
  const render = (pct: number): string =>
    textOf(
      drawPayload(
        config,
        compiled,
        store,
        registry,
        { session_id: "s-rule-throws", ctx: { pct } },
        instantOf(new Date()),
        OPTS,
        { onRenderWarning: (w) => warnings.push(w) },
      ).frame,
    );
  return { render, warnings, dispose: () => registry.dispose() };
}

describe("a globals rule whose template throws renders its slot's floor and says so", () => {
  test.each([
    { slot: "palette", label: `T=${THEME_FLOOR}`, floor: THEME_FLOOR },
    { slot: "style", label: `S=${STYLE_FLOOR}`, floor: STYLE_FLOOR },
    { slot: "effect", label: `E=${EFFECT_FLOOR}`, floor: EFFECT_FLOOR },
  ] as const)("$slot: a `fail` draws the bar in $floor", ({ slot, label, floor }) => {
    const rt = runtime(src(slot, '{{ fail "the rule broke" }}'));
    try {
      // The bar is drawn, wearing the slot's floor, labelled as such.
      expect(rt.render(0)).toContain(label);
      expect(rt.warnings).toEqual([
        {
          kind: "rule",
          slot,
          message: expect.stringMatching(
            new RegExp(
              `^globals\\.${slot} rendered "${floor}": the rule failed — .*the rule broke`,
            ),
          ),
        },
      ]);
    } finally {
      rt.dispose();
    }
  });

  test("a rule reading a field nothing provides is the same failure, not a throw", () => {
    const rt = runtime(src("style", "{{ .no.such.field }}"));
    try {
      expect(rt.render(0)).toContain(`S=${STYLE_FLOOR}`);
      expect(rt.warnings).toEqual([
        expect.objectContaining({ kind: "rule", slot: "style" }),
      ]);
    } finally {
      rt.dispose();
    }
  });

  test("the failure is per render: the next render the rule succeeds in wears its result, silently", () => {
    const rt = runtime(
      src("palette", '{{ if ge (int .ctx.pct) 50 }}{{ fail "hot" }}{{ else }}nord{{ end }}'),
    );
    try {
      expect(rt.render(10)).toContain("T=nord");
      expect(rt.render(90)).toContain(`T=${THEME_FLOOR}`);
      expect(rt.render(10)).toContain("T=nord");
      expect(rt.warnings.map((w) => w.message)).toEqual([
        expect.stringContaining("hot"),
      ]);
    } finally {
      rt.dispose();
    }
  });
});
