// The rich payload of `check`'s faked session (src/check-fixture.ts), composed
// in process for a test that draws a bar without a renderer: the fixture's
// readings stamped into a document and composed through the daemon's own
// composition (`composePayload`), under `effective`. Beyond what `check`
// draws, it opens every menu cell a count gates: one unsaved change, every
// setting resettable, every layer writable, a step of undo, redo and back, so
// each of those templates renders and gets checked.

import { assembleFacts } from "../../src/daemon/facts-assembly";
import type { Readings } from "../../src/daemon/readings";
import type { ValidatedConfig } from "../../src/config/dsl-types";
import type { EffectiveGlobals } from "../../src/config/effective-globals";
import { LAYER_ROLES, layerFlags } from "../../src/config/layer-role";
import { perSetting } from "../../src/config/setting-projections";
import {
  CHECK_HINTS,
  CHECK_HOME,
  checkDaemonFacts,
  checkDay,
  checkHook,
  checkLanes,
} from "../../src/check-fixture";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import {
  composePayload,
  instantFacts,
  type RenderPayload,
  type ViewPayload,
} from "../../src/renderer/render-payload";
import type { Instant } from "../../src/utils/instant";
import { ABSENT, ok } from "../../src/utils/outcome";

const CHECK_SESSION = sessionIdOf("test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b");

// `term` is the draw's (a bind writes it from the width), so it is left out;
// `today` is the draw's projection of the document's facts, beside it.
export type CheckPayload = Omit<ViewPayload, "term"> &
  ReturnType<typeof instantFacts>;

export function checkPayload(
  config: ValidatedConfig,
  effective: EffectiveGlobals,
  configPath: string | null,
  // The instant the render this payload feeds is drawn at, so its reset times
  // sit where the render's own countdowns measure them from.
  at: Instant,
): CheckPayload {
  const sources = Object.entries(config.variables).flatMap(([name, decl]) =>
    decl.kind === "source" ? [name] : [],
  );
  const readings: Readings = {
    lanes: {
      ...checkLanes(at),
      // Every declared source reads absent, as `check`'s owners answer it.
      sources: new Map(sources.map((name) => [name, ABSENT])),
      runs: new Map(),
      env: new Map(),
      doctor: ABSENT,
    },
    today: ok({ sums: checkDay(at).sums, own: {} }),
    faults: [],
  };
  const document = assembleFacts(
    undefined,
    CHECK_SESSION,
    readings,
    checkDaemonFacts(at),
    at,
  );
  const { term: _term, ...payload } = composePayload(
    document,
    {
      hookData: checkHook(at, CHECK_SESSION, `${CHECK_HOME}/code/cc-candybar`),
      hints: CHECK_HINTS,
      home: CHECK_HOME,
    },
    {
      sources: Object.keys(document.sources),
      effective,
      configFacts: {
        unsaved: 1,
        resettable: perSetting(
          () => true,
        ) satisfies RenderPayload["resettable"],
        // The field the theme gear's `⤓ default for <theme>` reads, spelled as
        // the daemon spells it: the theme in force, and no save under a
        // rule-chosen theme.
        themeDefault:
          effective.theme.kind === "decided"
            ? { differs: true, theme: effective.theme.name }
            : { differs: false },
        // The bundled default has no file, and a stand-in keeps the
        // quick-action tray's `↗ config` drawn.
        configPath:
          configPath ?? `${CHECK_HOME}/.config/cc-candybar/config.json5`,
        layers: layerFlags(LAYER_ROLES),
      },
      history: { undo: 1, redo: 1, sinceEdit: 1 },
      back: 1,
    },
  );
  return { ...payload, ...instantFacts(document.builtins, at) };
}
