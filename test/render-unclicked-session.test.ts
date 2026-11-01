// [LAW:verifiable-goals] candybar-theme-colours-6fq5.0ub: a session that has
// never clicked draws the active preset `globals.preset` names, wearing the
// style its globals name, through the daemon's own resolution
// (`resolveEffectiveGlobals`), not the preset and style floors.

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { globalsFor, picked } from "./helpers/selection";
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

test("a session that has never clicked draws the declared preset and style, not the floors", () => {
  const config = parseAndValidate("<omitted>", SRC, new Set([THEME_FLOOR]));
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  try {
    const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
    const at = instantOf(new Date());
    const render = (selection: Parameters<typeof drawPayload>[8]): Frame =>
      drawPayload(config, compiled, store, registry, { session_id: "s" }, at, OPTS, undefined, selection).frame;

    const unclicked = render(globalsFor(config));
    // The floor preset and style, picked by the session.
    const floor = render(globalsFor(config, picked({ preset: PRESET_FLOOR, style: STYLE_FLOOR })));

    expect(textOf(unclicked)).toContain("P=alt S=hot");
    expect(textOf(floor)).toContain(`P=floor S=${STYLE_FLOOR}`);
    // The palette moved with the style, not only the published name.
    expect(bgOf(unclicked)).not.toBe(bgOf(floor));
  } finally {
    registry.dispose();
  }
});
