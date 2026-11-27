import { SAMPLE_CALENDAR } from "./sample-region.js";
import { daemonFactsOf } from "./daemon-facts";
// Sample inputs for the production payload projection. The menu counters exercise
// reset, Save, Undo, Redo, and Back in the template suites.

import { assembleFacts } from "../../../src/daemon/facts-assembly";
import type { Readings } from "../../../src/daemon/readings";
import type { ValidatedConfig } from "../../../src/config/dsl-types";
import type { EffectiveGlobals } from "../../../src/config/effective-globals";
import { LAYER_ROLES, layerFlags } from "../../../src/config/layer-role";
import { perSetting } from "../../../src/config/setting-projections";
import {
  SAMPLE_HINTS,
  SAMPLE_HOME,
  sampleDay,
  sampleHook,
  sampleLanes,
} from "./sample-session";
import { sessionIdOf } from "../../../src/daemon/foundations/session-id";
import {
  composePayload,
  instantFacts,
  type RenderPayload,
  type ViewPayload,
} from "../../../src/renderer/render-payload";
import type { Instant, Tick } from "../../../src/utils/instant";
import { ABSENT, ok } from "../../../src/utils/outcome";

const SAMPLE_SESSION = sessionIdOf("test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b");

// `term` is the draw's (a bind writes it from the width), so it is left out;
// `today` is the draw's projection of the document's facts, beside it.
type SamplePayload = Omit<ViewPayload, "term"> &
  ReturnType<typeof instantFacts>;

export function samplePayload(
  config: ValidatedConfig,
  effective: EffectiveGlobals,
  configPath: string | null,
  // The instant the render this payload feeds is drawn at, so its reset times
  // sit where the render's own countdowns measure them from.
  at: Instant,
): SamplePayload {
  const sources = Object.entries(config.variables).flatMap(([name, decl]) =>
    decl.kind === "source" ? [name] : [],
  );
  const readings: Readings = {
    lanes: {
      ...sampleLanes(at),
      // A declared source before its program writes.
      sources: new Map(sources.map((name) => [name, ABSENT])),
      runs: new Map(),
      env: new Map(),
    },
    today: ok({ sums: sampleDay(at).sums, own: {} }),
    losses: [],
  };
  const document = assembleFacts(
    undefined,
    SAMPLE_SESSION,
    readings,
    daemonFactsOf(),
    { at, tick: 0 as Tick },
  );
  const { term: _term, ...payload } = composePayload(
    document,
    {
      hookData: {
        ...sampleHook(at, SAMPLE_SESSION, `${SAMPLE_HOME}/code/cc-candybar`),
        location: {
          main: `${SAMPLE_HOME}/code/cc-candybar`,
          worktree: "",
          subpath: "/src",
          noRepo: false,
        },
      },
      hints: SAMPLE_HINTS,
      home: SAMPLE_HOME,
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
          configPath ?? `${SAMPLE_HOME}/.config/cc-candybar/config.json5`,
        layers: layerFlags(LAYER_ROLES),
      },
      history: { undo: 1, redo: 1, sinceEdit: 1 },
      back: 1,
    },
  );
  return { ...payload, ...instantFacts(document.builtins, at, SAMPLE_CALENDAR) };
}
