// [LAW:verifiable-goals] Style-picker done-gate: clicking a style option
// RESHAPES the whole bar live (the powerline cap/separator family changes). The
// reshape lives in the daemon's PER-RENDER strip-style resolution
// (resolveEffectiveGlobals -> renderOpts.endcaps), OUTSIDE drawDsl — the exact twin
// of how a theme click recolors via basePalette (see dsl-theme-picker-recolor).
// This test replicates that resolution exactly as src/daemon/draw-bar.ts does, so
// it proves the end-to-end loop: a set-state `style` click changes what the
// joiner draws between cells.
//
// [LAW:single-enforcer] Drives the real spine — registerDslConfig + drawDsl
// for rendering, the real click wire for the set-state, and the same
// resolveEffectiveGlobals the daemon calls. No parallel rig, no hand-built
// joiner.

import { drawPayload } from "./helpers/draw-payload";
import { ansiOf, textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { recordRender, testVerbContext, clickUrl } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { paletteForThemeName, ENDCAPS_SHAPES } from "../src/themes";
import { globalsFor } from "./helpers/selection";
import { instantOf } from "../src/utils/instant";

const SID = "s-reshape";
const BASE_THEME = "textual-dark";

// Two cells in one horizontal row, so the joiner runs BETWEEN them — that
// inter-cell seam is exactly what the strip style reshapes.
const SRC = `{
  globals: { palette: '${BASE_THEME}' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    activeStyle: { kind: 'state', key: 'endcaps', default: '' },
  },
  actions: {
    applyEndcaps: { set: 'endcaps', from: 'endcaps' },
  },
  segments: {
    a: { template: ' A ', bg: 'surface', fg: 'foreground' },
    b: { template: ' B ', bg: 'panel', fg: 'foreground' },
  },
  root: { h: ['a', 'b'] },
}`;

const ALLOWED = new Set([BASE_THEME]);

function buildRuntime() {
  const config = parseAndValidate("<reshape>", SRC, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  const basePalette = paletteForThemeName(BASE_THEME);

  // [LAW:one-source-of-truth] Resolve the strip style per render the SAME way the
  // daemon does — the session's clicked style over the config default over the
  // "powerline" floor. Freezing it would silently pass while the real daemon
  // reshapes. (draw-bar.ts: renderOptionsOf(resolveEffectiveGlobals(...))).
  const render = (): Frame =>
    drawPayload(config, compiled, store, registry, { session_id: SID }, instantOf(new Date()), {
      endcaps: globalsFor(config, (key) => sessionState.get(SID, key)).endcaps,
      colorCompatibility: "truecolor" as const, wrap: true, padding: 0,
      width: Number.POSITIVE_INFINITY,
    }).frame;

  return { config, sessionState, render };
}

async function clickEndcaps(
  { config, sessionState }: ReturnType<typeof buildRuntime>,
  style: string,
): Promise<void> {
  // Drive the real wire end-to-end: emit the set-state URL the picker would.
  const url = effectsUrl([{ verb: VERB_SET_STATE, args: [SID, "endcaps", style] }]);
  recordRender(sessionState, SID);
  await clickUrl(url, testVerbContext(sessionState, undefined, config));
}

describe("DSL style picker — live reshape", () => {
  test("clicking a style changes the bytes the joiner emits between cells", async () => {
    const rt = buildRuntime();
    const { sessionState, render } = rt;

    const powerline = render(); // default: SessionState unset -> "powerline" floor
    expect(textOf(powerline).length).toBeGreaterThan(0);

    await clickEndcaps(rt, "capsule");
    const capsule = render();

    await clickEndcaps(rt, "plain");
    const plain = render();

    // [LAW:verifiable-goals] The reshape IS the contract: each strip style yields
    // a distinct inter-cell rendering, so all three footprints are pairwise
    // different. If the session style were ignored, all three would be identical.
    expect(capsule.rows).not.toEqual(powerline.rows);
    expect(plain.rows).not.toEqual(powerline.rows);
    expect(plain.rows).not.toEqual(capsule.rows);
  });

  test("every ENDCAPS_SHAPES member resolves to a renderable, distinct bar", async () => {
    const rt = buildRuntime();
    const { sessionState, render } = rt;
    const seen = new Map<string, string>();
    for (const style of ENDCAPS_SHAPES) {
      await clickEndcaps(rt, style);
      const out = render();
      expect(textOf(out).length).toBeGreaterThan(0);
      seen.set(style, ansiOf(out));
    }
    // The render for each style is unique — the domain offered by the picker
    // maps one-to-one onto a distinct rendered shape (no dead options).
    expect(new Set(seen.values()).size).toBe(ENDCAPS_SHAPES.length);
  });
});

describe("endcaps resolve session over config over floor", () => {
  const endcapsOf = (
    globals: string,
    picks: Readonly<Record<string, string>>,
  ): string =>
    globalsFor(
      parseAndValidate("<endcaps>", `{ globals: { ${globals} } }`, ALLOWED),
      (key) => picks[key] ?? null,
    ).endcaps;
  test("session pick wins over config default and floor", () => {
    expect(endcapsOf("endcaps: 'plain'", { endcaps: "capsule" })).toBe(
      "capsule",
    );
  });
  test("config default applies when the session is unset", () => {
    expect(endcapsOf("endcaps: 'plain'", {})).toBe("plain");
  });
  test("floor is powerline when neither session nor config is set", () => {
    expect(endcapsOf("", {})).toBe("powerline");
  });
  test("a stale out-of-domain session value collapses to the config default", () => {
    // A SessionState entry left over from a prior option vocabulary (e.g. the
    // legacy 'muted' preset) is not a renderable strip style — it must not leak
    // through as a Endcaps. [LAW:no-silent-failure] / [LAW:types-are-the-program]
    expect(endcapsOf("", { endcaps: "muted" })).toBe("powerline");
    expect(endcapsOf("endcaps: 'plain'", { endcaps: "muted" })).toBe("plain");
  });
});
