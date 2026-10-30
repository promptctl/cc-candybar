// The stages of a draw, timed in-process through the seam the check command
// and the gallery draw through: load a config, compile and bind it, draw it.
//
// This is NOT the cost of a tick. It has no render cache, no session state, no
// client hints and no waiting on sources; it draws the check fixture's payload.
// What it buys is the split: when a tick is slow, these say whether the
// config load, the compile or the draw is where the time went, without a
// daemon's scheduling in the way. The tick is `wire`.

import fs from "node:fs";
import path from "node:path";

import {
  NO_REPO,
  prepareConfig,
  renderEffective,
  type PreparedConfig,
} from "../../../src/check.js";
import { DEFAULT_DSL_CONFIG } from "../../../src/config/default-dsl-config.js";
import { homeLayer, loadConfigChain } from "../../../src/config/dsl-loader.js";
import { resolveEffectiveGlobals } from "../../../src/config/effective-globals.js";
import { presetNames } from "../../../src/config/presets.js";
import { instantOf } from "../../../src/utils/instant.js";
import { REPO } from "../environment.js";
import { removeTree, scratchDir } from "../fixtures.js";
import { repeat } from "../measure.js";
import { measured, type Benchmark } from "../types.js";

const ABOUT =
  "renderDsl over the check fixture's payload: a stage of a tick (no render cache, session state or hints), not its cost";

// The terminal widths Claude Code runs in, narrowest split pane to widest.
const WIDTHS = [40, 80, 120, 200, 300] as const;
const DRAW_WIDTH = 120;

// Every example config the repo ships, by file: a new example is measured the
// day it is added.
const EXAMPLES_DIR = path.join(REPO, "examples");
const EXAMPLES = fs
  .readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith(".json5"))
  .sort();

// [LAW:no-silent-failure] A config that warns or drops a plugin draws a bar
// other than the one measured; the benchmark stops rather than time it.
async function prepared(
  layers: readonly string[],
  cwd: string,
): Promise<PreparedConfig> {
  const warnings: string[] = [];
  // An example file is explicit: no repository supplies it.
  const config = await prepareConfig(
    layers.map(homeLayer),
    NO_REPO,
    cwd,
    warnings,
    instantOf(new Date()),
  );
  if (warnings.length > 0 || config.droppedPlugins.length > 0) {
    config.registry.dispose();
    throw new Error(
      `${layers.join(", ") || "the bundled default"} did not prepare cleanly: ${[
        ...warnings,
        ...config.droppedPlugins.map((d) => `plugin dropped: ${JSON.stringify(d)}`),
      ].join("; ")}`,
    );
  }
  return config;
}

// [LAW:no-silent-failure] The checkpoint every draw crosses: a draw that threw
// a segment into its ⚠ cell, or drew nothing, is not a fast draw. The draw
// reports these rather than throwing, which is why a sample cannot vouch for
// itself.
function drawnClean(
  drew: Awaited<ReturnType<typeof renderEffective>>,
  what: string,
): number {
  if (drew.failures.size > 0 || drew.rendered.length === 0) {
    throw new Error(
      `${what} drew a broken bar (${drew.rendered.length} bytes): ${[...drew.failures].map(([k, v]) => `${k}: ${v}`).join("; ") || "nothing"}`,
    );
  }
  return drew.rendered.length;
}

interface Draw {
  readonly preset: string | null;
  readonly width: number;
  readonly layers: readonly string[];
}

// Draws at the advancing second a real session's ticks arrive at, so a draw
// is never the repeat of the instant before it.
async function drawing(
  draw: Draw,
  samples: number,
  what: string,
): Promise<{ ms: number[]; bytes: number }> {
  const cwd = scratchDir("ccbn-stage");
  try {
    const config = await prepared(draw.layers, cwd);
    try {
      const effective = resolveEffectiveGlobals(
        config.config,
        (key) => (key === "preset" ? draw.preset : null),
        () => false,
      );
      const start = Date.now();
      let bytes = 0;
      const ms = await repeat(samples, async (i) => {
        const at = instantOf(new Date(start + (i + 4) * 1000));
        bytes = drawnClean(
          await renderEffective(config, effective, draw.width, at),
          what,
        );
      });
      return { ms, bytes };
    } finally {
      config.registry.dispose();
    }
  } finally {
    removeTree(cwd);
  }
}

const drawBenchmark = (
  id: string,
  about: string,
  draw: Draw,
  samples: number,
): Benchmark => ({
  id,
  group: "stages",
  about: `${about}; ${ABOUT}`,
  samples,
  async run(plan) {
    const { ms, bytes } = await drawing(draw, plan.samples, id);
    return measured([{ name: "draw", samples: ms }], { bytes });
  },
});

export const STAGES: readonly Benchmark[] = [
  {
    id: "stages.config.load",
    group: "stages",
    about: "parse, validate and merge the bundled default into a config",
    samples: 30,
    async run(plan) {
      const cwd = scratchDir("ccbn-stage");
      try {
        const ms = await repeat(plan.samples, () => {
          loadConfigChain(
            [],
            DEFAULT_DSL_CONFIG,
            { warned: () => {} },
            { repo: null, cwd },
          );
        });
        return measured([{ name: "load", samples: ms }]);
      } finally {
        removeTree(cwd);
      }
    },
  },
  {
    id: "stages.config.prepare",
    group: "stages",
    about:
      "load, compile every template, bind a view and settle its sources: what a new config costs before its first draw",
    samples: 12,
    async run(plan) {
      const cwd = scratchDir("ccbn-stage");
      try {
        const ms = await repeat(plan.samples, async () => {
          (await prepared([], cwd)).registry.dispose();
        });
        return measured([{ name: "prepare", samples: ms }]);
      } finally {
        removeTree(cwd);
      }
    },
  },
  {
    id: "stages.draw.first",
    group: "stages",
    about: `the first draw of a freshly prepared config: every template evaluated once, nothing kept; ${ABOUT}`,
    samples: 12,
    async run(plan) {
      const cwd = scratchDir("ccbn-stage");
      try {
        let bytes = 0;
        const ms: number[] = [];
        for (let i = 0; i < plan.samples; i++) {
          const config = await prepared([], cwd);
          try {
            const effective = resolveEffectiveGlobals(
              config.config,
              () => null,
              () => false,
            );
            const started = performance.now();
            const drew = await renderEffective(
              config,
              effective,
              DRAW_WIDTH,
              instantOf(new Date()),
            );
            ms.push(performance.now() - started);
            bytes = drawnClean(drew, "stages.draw.first");
          } finally {
            config.registry.dispose();
          }
        }
        return measured([{ name: "first-draw", samples: ms }], { bytes });
      } finally {
        removeTree(cwd);
      }
    },
  },
  ...WIDTHS.map((width) =>
    drawBenchmark(
      `stages.draw.width.${width}`,
      `the default preset drawn ${width} columns wide, each draw a second after the last`,
      { preset: null, width, layers: [] },
      60,
    ),
  ),
  ...presetNames(DEFAULT_DSL_CONFIG.presets).map((preset) =>
    drawBenchmark(
      `stages.draw.preset.${preset}`,
      `the ${preset} preset drawn ${DRAW_WIDTH} columns wide, each draw a second after the last`,
      { preset, width: DRAW_WIDTH, layers: [] },
      60,
    ),
  ),
  ...EXAMPLES.map((file) =>
    drawBenchmark(
      `stages.draw.example.${file.replace(/\.json5$/, "")}`,
      `examples/${file} drawn ${DRAW_WIDTH} columns wide, each draw a second after the last`,
      { preset: null, width: DRAW_WIDTH, layers: [path.join(EXAMPLES_DIR, file)] },
      40,
    ),
  ),
];
