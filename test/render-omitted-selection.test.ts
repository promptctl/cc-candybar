// [LAW:verifiable-goals] candybar-theme-colours-6fq5.0ub: a caller that hands
// renderDsl no selection renders the bar the daemon would draw for a session
// that has never clicked — the active preset `globals.preset` names, wearing
// the style its globals name — because an omitted selection resolves through
// the daemon's own resolution (`resolveEffectiveGlobals`), not a copy inside
// renderDsl that read the preset and style floors.

import { stripAnsi } from "./helpers/ansi";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { SessionState } from "../src/daemon/session-state";
import { THEME_FLOOR } from "../src/themes";
import { instantOf } from "../src/utils/instant";

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

test("an omitted selection renders the declared preset and style, byte for byte as the daemon's resolution", () => {
  const config = parseAndValidate("<omitted>", SRC, new Set([THEME_FLOOR]));
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(config, registry, { cwd: process.cwd() });
    const at = instantOf(new Date());
    const render = (
      selection?: Parameters<typeof renderDsl>[8],
    ): string =>
      renderDsl(config, compiled, store, registry, { session_id: "s" }, at, OPTS, undefined, selection);

    const omitted = render();
    // The daemon's resolution for a session with no picks (src/daemon/server.ts).
    const daemon = render(resolveEffectiveGlobals(config, () => null, () => false));

    expect(stripAnsi(omitted)).toContain("P=alt S=hot");
    expect(omitted).toBe(daemon);
  } finally {
    registry.dispose();
  }
});
