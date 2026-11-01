// [LAW:verifiable-goals] candybar-settings-ui-aok.5's done-gate: edit mode has
// its own LOOK, and that look is authored config rather than renderer
// constants. Four claims, each pinned below:
//
//   1. Entering edit mode restyles the whole bar (plain joiners + a visible
//      separator between cells); leaving restores the previous bytes EXACTLY.
//   2. The staged fragment outranks a session pick — the rightmost rung of the
//      precedence chain in src/config/presets.ts — and the session pick governs
//      again the moment edit mode clears, with nothing saved or restored.
//   3. A CONFIG can change what edit mode looks like, with no engine edit.
//   4. The fragment cannot select a preset; the loader says so by name.
//
// [LAW:single-enforcer] Drives the real seams: resolveEffectiveGlobals (the one
// resolution the daemon and `cc-candybar check` both call), the real click wire
// for the session writes, and registerDslConfig + drawDsl for the bytes. No
// parallel rig and no hand-built joiner — a test that restated the chain would
// pass while the daemon diverged, which is the whole failure this ticket closes.

import { drawPayload } from "./helpers/draw-payload";
import { textOf, type Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { testVerbContext, clickUrl, recordRender } from "./helpers/click";
import { effectsUrl, VERB_SET_STATE } from "../src/click/wire";
import { resolveEffectiveGlobals } from "../src/config/effective-globals";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { ConfigError } from "../src/config/dsl-loader";
import { EDIT_MODE_KEY, EDIT_MODE_ARRANGE } from "../src/config/loader/edit-mode";
import type { ValidatedConfig } from "../src/config/dsl-types";
import { instantOf } from "../src/utils/instant";

const SID = "s-edit-look";
const BASE_THEME = "textual-dark";
const ALLOWED = new Set([BASE_THEME]);

// Two cells in one row, so a joiner runs BETWEEN them — that inter-cell seam is
// exactly what the staged style reshapes. `session.id` is declared because any
// config carrying state vars needs it (cross-ref.ts).
function src(extra = ""): string {
  return `{
  globals: { palette: '${BASE_THEME}', endcaps: 'powerline' },
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
  },
  actions: {
    padTo: { set: 'padding', min: 0, max: 8, by: 1 },
    wrapToggle: { set: 'autoWrap', cycle: ['true', 'false'] },
    applyEndcaps: { set: 'endcaps', from: 'endcaps' },
  },
  segments: {
    // The edit.toggle reference is what DEMANDS edit mode (loader/edit-mode.ts),
    // so this config gets the real toggle action, the real state key, and the
    // real +/- chrome, exactly as a user config does.
    a: { template: 'A{{ action "edit.toggle" "e" "d" }}', bg: 'surface', fg: 'foreground' },
    b: { template: 'B', bg: 'panel', fg: 'foreground' },
  },
  root: { h: ['a', 'b'] },
  ${extra}
}`;
}

function buildRuntime(source: string) {
  const config = parseAndValidate("<edit-look>", source, ALLOWED);
  const sessionState = new SessionState();
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  // [LAW:single-enforcer] The real gate is the one this session's config
  // derives — the sole authority on what a click may write. Recording the
  // render and the config it rendered with is what makes the set-state calls
  // below travel the same road a real click travels.
  recordRender(sessionState, SID);
  renderedConfig.set(sessionState, config);

  // [LAW:one-source-of-truth] The daemon's own resolution, called the way the
  // daemon calls it — a session-key reader and the entry's customized fact.
  const effectiveNow = () =>
    resolveEffectiveGlobals(
      config,
      (key) => sessionState.get(SID, key),
      () => false,
    );

  const render = (): Frame => {
    const effective = effectiveNow();
    return drawPayload(
      config,
      compiled,
      store,
      registry,
      { session_id: SID },
      instantOf(new Date()),
      {
        endcaps: effective.endcaps,
        separator: effective.separator,
        colorCompatibility: "truecolor" as const,
        wrap: effective.autoWrap,
        padding: effective.padding,
        width: Number.POSITIVE_INFINITY,
      },
      undefined,
      // The selection IS the same `effective` resolution every field above comes
      // from — so the bar cannot be painted from one resolution and labelled
      // from another.
      effective,
    ).frame;
  };

  return { config, sessionState, render, effectiveNow };
}

async function setState(
  sessionState: SessionState,
  key: string,
  value: string,
): Promise<void> {
  await clickUrl(
    effectsUrl([{ verb: VERB_SET_STATE, args: [SID, key, value] }]),
    testVerbContext(sessionState, undefined, renderedConfig.get(sessionState)),
  );
}

// The config each runtime's session renders with, which is the config its
// clicks are gated by. Keyed on the session state so a test that builds two
// runtimes gates each one's clicks by its own config.
const renderedConfig = new WeakMap<SessionState, ValidatedConfig>();

const enterEditMode = async (s: SessionState) =>
  await setState(s, EDIT_MODE_KEY, EDIT_MODE_ARRANGE);
const leaveEditMode = async (s: SessionState) => await setState(s, EDIT_MODE_KEY, "closed");

describe("edit mode's look — a staged globals fragment", () => {
  test("entering restyles the bar and leaving restores the previous bytes exactly", async () => {
    const { sessionState, render } = buildRuntime(
      src(`editGlobals: { endcaps: 'plain', default_separator: ' | ' },`),
    );

    const before = render();
    await enterEditMode(sessionState);
    const editing = render();
    await leaveEditMode(sessionState);
    const after = render();

    expect(editing.rows).not.toEqual(before.rows);
    expect(textOf(editing)).toContain(" | ");
    // [LAW:dataflow-not-control-flow] Restoration is by construction, not by a
    // save/restore path: nothing wrote the previous style anywhere, it was only
    // out-ranked. Equal rows are the proof that nothing was persisted.
    expect(after.rows).toEqual(before.rows);
  });

  test("the staged fragment outranks a session pick, which governs again on exit", async () => {
    const { sessionState, render, effectiveNow } = buildRuntime(
      src(`editGlobals: { endcaps: 'plain', default_separator: ' | ' },`),
    );

    await setState(sessionState, "endcaps", "capsule");
    const capsule = render();
    expect(effectiveNow().endcaps).toBe("capsule");

    await enterEditMode(sessionState);
    // The rightmost rung wins: a session pick made BEFORE entering edit mode
    // cannot survive into a mode whose whole job is to stop segments reading as
    // one continuous strip.
    expect(effectiveNow().endcaps).toBe("plain");
    expect(render().rows).not.toEqual(capsule.rows);

    await leaveEditMode(sessionState);
    expect(effectiveNow().endcaps).toBe("capsule");
    expect(render().rows).toEqual(capsule.rows);
  });

  test("the look is authored: two configs differing only in editGlobals render differently", async () => {
    // [LAW:verifiable-goals] The ticket's actual bar — "a config can change the
    // edit-mode look; a test demonstrates it with config data only and no
    // engine edit". Both runtimes below run the SAME engine.
    const bundled = buildRuntime(
      src(`editGlobals: { endcaps: 'plain', default_separator: ' | ' },`),
    );
    const retuned = buildRuntime(
      src(`editGlobals: { endcaps: 'plain', default_separator: ' ~~ ' },`),
    );

    await enterEditMode(bundled.sessionState);
    await enterEditMode(retuned.sessionState);

    expect(textOf(bundled.render())).toContain(" | ");
    expect(textOf(retuned.render())).toContain(" ~~ ");
    expect(retuned.render().rows).not.toEqual(bundled.render().rows);
  });

  test("a config declaring no editGlobals gets no restyling from edit mode", async () => {
    // The empty fragment is the identity one — the mode is carried entirely by
    // what the fragment CONTAINS, so staging nothing resolves to exactly the
    // pre-edit values [LAW:dataflow-not-control-flow]. Asserted on the resolved
    // globals rather than on rendered bytes, because edit mode also splices its
    // +/- CHROME into the tree: that is a different feature (edit-chrome.ts),
    // and conflating the two would make this test fail for the wrong reason.
    const { sessionState, effectiveNow } = buildRuntime(src());
    const before = effectiveNow();
    await enterEditMode(sessionState);
    expect(effectiveNow()).toEqual(before);
  });

  test("every staged field outranks its session pick, not just style", async () => {
    const { sessionState, effectiveNow } = buildRuntime(
      src(`editGlobals: { padding: 3, autoWrap: false },`),
    );
    await setState(sessionState, "padding", "1");
    await setState(sessionState, "autoWrap", "true");
    expect(effectiveNow().padding).toBe(1);
    expect(effectiveNow().autoWrap).toBe(true);

    await enterEditMode(sessionState);
    expect(effectiveNow().padding).toBe(3);
    expect(effectiveNow().autoWrap).toBe(false);
  });

  test("an unstaged field still resolves through its own session pick while editing", async () => {
    // The fragment is a DELTA, not a replacement: staging `style` says nothing
    // about `padding`, exactly as a preset's globals delta does.
    const { sessionState, effectiveNow } = buildRuntime(
      src(`editGlobals: { endcaps: 'plain' },`),
    );
    await setState(sessionState, "padding", "4");
    await enterEditMode(sessionState);
    expect(effectiveNow().endcaps).toBe("plain");
    expect(effectiveNow().padding).toBe(4);
  });
});

describe("editGlobals — the loader's contract", () => {
  test("the fragment cannot select a preset, and the error says why", () => {
    expect(() =>
      parseAndValidate(
        "<edit-look>",
        src(`editGlobals: { preset: 'compact' },`),
        ALLOWED,
      ),
    ).toThrow(ConfigError);
    try {
      parseAndValidate(
        "<edit-look>",
        src(`editGlobals: { preset: 'compact' },`),
        ALLOWED,
      );
    } catch (err) {
      expect(String(err)).toContain(
        "the editGlobals fragment cannot select a preset",
      );
    }
  });

  test("an unknown key inside the fragment is rejected by the globals field table", () => {
    expect(() =>
      parseAndValidate(
        "<edit-look>",
        src(`editGlobals: { stripStyle: 'plain' },`),
        ALLOWED,
      ),
    ).toThrow(/editGlobals key/);
  });

  test("a user fragment merges FIELD by field over the bundled one", () => {
    // [LAW:one-source-of-truth] The `globals` cascade, not the by-name cascade:
    // retuning the separator must not silently drop the bundled `plain`.
    const config: ValidatedConfig = parseAndValidate(
      "<edit-look>",
      `{ editGlobals: { default_separator: ' ~ ' } }`,
      undefined,
      DEFAULT_DSL_CONFIG,
    );
    expect(config.editGlobals.default_separator).toBe(" ~ ");
    expect(config.editGlobals.endcaps).toBe(DEFAULT_DSL_CONFIG.editGlobals.endcaps);
  });
});

describe("the bundled default's edit look", () => {
  test("ships plain joiners with a stated separator", () => {
    expect(DEFAULT_DSL_CONFIG.editGlobals.endcaps).toBe("plain");
    expect(DEFAULT_DSL_CONFIG.editGlobals.default_separator).toBe(" | ");
  });
});
