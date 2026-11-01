// [LAW:verifiable-goals] candybar-theme-colours-6fq5.0ub: a caller that hands
// drawDsl no selection renders the bar the daemon would draw for a session
// that has never clicked — the active preset `globals.preset` names, wearing
// the style its globals name — because an omitted selection resolves through
// the daemon's own resolution (`resolveEffectiveGlobals`), not a copy inside
// drawDsl that read the preset and style floors.

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { SessionState } from "../src/daemon/session-state";
import { STYLE_FLOOR, THEME_FLOOR } from "../src/themes";
import { PRESET_FLOOR } from "../src/config/presets";
import { instantOf } from "../src/utils/instant";

// The first truecolor background a drawn bar paints.
const bgOf = ({ rows }: Frame): string | undefined =>
  rows.flatMap(({ runs }) => runs).find(({ bg }) => bg?.startsWith("#"))?.bg;

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};

const SRC = `{
  globals: { preset: 'alt' },
  styles: { hot: { hueShift: 120, chromaScale: 1.5 } },
  presets: {
    alt: { root: { h: ['altLabel'] }, globals: { style: 'hot' } },
  },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    'style.effective': { kind: 'input', path: 'style.effective', default: '' },
  },
  segments: {
    label: { template: 'P=floor S={{ .style.effective }}', bg: 'primary', fg: 'foreground' },
    altLabel: { template: 'P=alt S={{ .style.effective }}', bg: 'primary', fg: 'foreground' },
  },
  root: { h: ['label'] },
}`;

test("an omitted selection renders the declared preset and style, not the floors", () => {
  const config = parseAndValidate("<omitted>", SRC, new Set([THEME_FLOOR]));
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  try {
    const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
    const at = instantOf(new Date());
    const render = (
      selection?: Parameters<typeof drawPayload>[8],
    ): Frame =>
      drawPayload(config, compiled, store, registry, { session_id: "s" }, at, OPTS, undefined, selection).frame;

    const omitted = render();
    // The floor preset and style, picked by the session: what an omitted
    // selection drew before it resolved through the daemon's resolution.
    const floor = render(
      resolveEffectiveGlobals(
        config,
        (key) => ({ preset: PRESET_FLOOR, style: STYLE_FLOOR })[key] ?? null,
        () => false,
      ),
    );

    expect(textOf(omitted)).toContain("P=alt S=hot");
    expect(textOf(floor)).toContain(`P=floor S=${STYLE_FLOOR}`);
    // The palette moved with the style, not only the published name.
    expect(bgOf(omitted)).not.toBe(bgOf(floor));
  } finally {
    registry.dispose();
  }
});
