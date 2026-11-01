import { plainOf, textOf, type Frame, type Run } from "../src/render/frame";
import { sameDraw } from "./helpers/frame";
// [LAW:verifiable-goals] brandon-effects-2gka.bm1: a placement can carry its own
// effect. Its `effect` setting moves that placement's cells and the seams that
// show its colour, on a clock of its own, and every other cell of the row is
// drawn exactly as it is without the setting.

import { drawPayload } from "./helpers/draw-payload";
import { linkUrls } from "./helpers/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { selectionFor } from "./helpers/selection";

import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { settingsOf, type ValidatedConfig } from "../src/config/dsl-types";
import { SessionEffects } from "../src/render/effect";
import type { RenderedLine } from "../src/dsl/node-registry";
import { menuStateKey } from "../src/config/menu-keys";
import { decideEffectName, EFFECT_NAMES, type EffectName } from "../src/themes";
import type { Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";

const START = 1_800_000_000 as Instant;
const at = (seconds: number): Instant => (START + seconds) as Instant;
// Pulse breathes within its first minute; shimmer, a slow sweep, crosses a
// row this short only after its first three.
const INSTANTS = [0, 5, 11, 20, 33, 47, 90, 180, 200, 230, 260, 300];

// Where on its row the placement named by text no other cell draws sits: a
// looping effect measures the row's extent, which an edge placement bounds.
type Seat = "first" | "middle" | "last";
const SEATS: Readonly<Record<Seat, (placed: string) => string>> = {
  first: (placed) => `${placed}, "left", "right"`,
  middle: (placed) => `"left", ${placed}, "right"`,
  last: (placed) => `"left", "right", ${placed}`,
};

// A row of placements, one of them named by text no other cell draws.
const row = (middle: string, seat: Seat = "middle"): ValidatedConfig =>
  parseAndValidate(
    "<test>",
    `{
      segments: {
        left: { template: 'left cell' },
        middle: { template: 'MIDDLE' },
        right: { template: 'right cell' },
      },
      root: { h: [${SEATS[seat](middle)}] },
    }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );
const PULSE = `{ seg: "middle", settings: { effect: "pulse" } }`;
const PLAIN = row(`"middle"`);
const PULSING = row(PULSE);

// The session every render here draws for, whose state `renderer` seeds.
const PAYLOAD = { session_id: "s" };

function renderer(
  config: ValidatedConfig,
  state: Readonly<Record<string, string>> = {},
): {
  readonly render: (
    bar: EffectName,
    when: Instant,
    effects: SessionEffects<RenderedLine>,
  ) => Frame;
  readonly dispose: () => void;
} {
  const store = new VariableStore();
  const session = new SessionState();
  for (const [key, value] of Object.entries(state)) session.set("s", key, value);
  const registry = new SourceRegistry(processLauncher, store, "", session);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
  const opts = {
    endcaps: "powerline" as const,
    colorCompatibility: "truecolor" as const,
    wrap: true,
    padding: 1,
    width: 160,
  };
  return {
    render: (bar, when, effects) =>
      drawPayload(config, compiled, store, registry, PAYLOAD, when, opts, undefined,
        selectionFor(config, { effect: decideEffectName(bar), effects }),
      ).frame,
    dispose: () => registry.dispose(),
  };
}

// Each screen cell of a line: its glyph and the look it is drawn in.
function screenCells(line: readonly Run[]): string[] {
  return line.flatMap(({ text, ...look }) => {
    const drawn = JSON.stringify(look);
    return [...text].map((glyph) => `${glyph}${drawn}`);
  });
}

// The columns the middle placement's colours show in: its cell (the text and
// the padding each side of it) and the seam either side of it — the one into it
// shows its fill as ground, the one out of it as ink. Counted as screen cells.
function middleColumns(line: readonly Run[]): { from: number; to: number } {
  const at = [...plainOf(line).split("MIDDLE")[0]!].length;
  const padding = 1;
  const seam = 1;
  return {
    from: at - padding - seam,
    to: at + "MIDDLE".length + padding + seam,
  };
}

describe("a placement's effect setting", () => {
  test("every placement has it: the bar's by default, any effect by name", () => {
    expect(settingsOf({ template: "x" }).effect).toEqual({
      label: "effect",
      domain: ["bar", ...EFFECT_NAMES],
      default: "bar",
    });
  });

  test.each(
    (["none", "shimmer", "sparkle"] as const).flatMap((bar) =>
      (Object.keys(SEATS) as Seat[]).map((seat) => [bar, seat] as const),
    ),
  )(
    "under a bar wearing %s, pulse on the %s placement of its row moves its cells and nothing else",
    (bar, seat) => {
      const plain = renderer(row(`"middle"`, seat));
      const pulsing = renderer(row(PULSE, seat));
      try {
        const plainFx = new SessionEffects<RenderedLine>("s");
        const pulsingFx = new SessionEffects<RenderedLine>("s");
        let moved = false;
        for (const s of INSTANTS) {
          const before = plain.render(bar, at(s), plainFx);
          const after = pulsing.render(bar, at(s), pulsingFx);
          expect(textOf(after)).toBe(textOf(before));
          expect(linkUrls(after)).toEqual(linkUrls(before));
          after.rows.forEach(({ runs }, i) => {
            const held = before.rows[i]!.runs;
            if (!plainOf(runs).includes("MIDDLE")) {
              expect(runs).toEqual(held);
              return;
            }
            const { from, to } = middleColumns(runs);
            const was = screenCells(held);
            const is = screenCells(runs);
            is.forEach((cell, col) => {
              if (col < from || col >= to) expect(cell).toBe(was[col]);
            });
            if (is.slice(from, to).join() !== was.slice(from, to).join())
              moved = true;
          });
        }
        // [LAW:verifiable-goals] Otherwise the equalities above prove nothing.
        expect(moved).toBe(true);
      } finally {
        plain.dispose();
        pulsing.dispose();
      }
    },
  );

  test("its clock starts when it comes into force for that placement", () => {
    const pulsing = renderer(PULSING);
    const plain = renderer(PLAIN);
    try {
      // The session has drawn the plain row since 0; pulse comes into force on
      // the middle placement at 300, so its first frame is at rest.
      const effects = new SessionEffects<RenderedLine>("s");
      plain.render("none", at(0), effects);
      expect(pulsing.render("none", at(300), effects).rows).toEqual(
        plain.render("none", at(300), new SessionEffects<RenderedLine>("s")).rows,
      );
      expect(effects.lastFrame().own).toEqual([
        { placement: "middle", effect: "pulse", t: 0 },
      ]);
      pulsing.render("none", at(312), effects);
      expect(effects.lastFrame().own).toEqual([
        { placement: "middle", effect: "pulse", t: 12 },
      ]);
      // Dropped from the bar, it is no longer in force for the session.
      plain.render("none", at(320), effects);
      expect(effects.lastFrame().own).toEqual([]);
    } finally {
      pulsing.dispose();
      plain.dispose();
    }
  });

  test("none stands a placement still on a moving bar", () => {
    const still = renderer(row(`{ seg: "middle", settings: { effect: "none" } }`));
    try {
      const effects = new SessionEffects<RenderedLine>("s");
      const frames = INSTANTS.map((s) => still.render("shimmer", at(s), effects));
      const middle = frames.map((frame) => {
        const { runs } = frame.rows.find((r) => plainOf(r.runs).includes("MIDDLE"))!;
        const { from, to } = middleColumns(runs);
        // Its own cell, short of the seams, which show its neighbours too.
        return screenCells(runs).slice(from + 1, to - 1).join();
      });
      for (const cells of middle) expect(cells).toBe(middle[0]);
      // [LAW:verifiable-goals] The bar around it did move.
      expect(frames.some((frame) => !sameDraw(frame, frames[0]!))).toBe(true);
    } finally {
      still.dispose();
    }
  });

  // The bar's effect is kept under a scope no placement id can equal, so a
  // placement named `bar` wears its own effect, not the bar's.
  test("a placement named bar wears its own effect", () => {
    const plain = renderer(PLAIN);
    const named = renderer(
      row(`{ seg: "middle", id: "bar", settings: { effect: "pulse" } }`),
    );
    try {
      const plainFx = new SessionEffects<RenderedLine>("s");
      const namedFx = new SessionEffects<RenderedLine>("s");
      const differs = INSTANTS.some(
        (s) =>
          !sameDraw(named.render("shimmer", at(s), namedFx), plain.render("shimmer", at(s), plainFx)),
      );
      expect(differs).toBe(true);
      expect(namedFx.lastFrame().own).toEqual([
        expect.objectContaining({ placement: "bar", effect: "pulse" }),
      ]);
    } finally {
      plain.dispose();
      named.dispose();
    }
  });

  // Every cell a placement lays is its own: the band its open menu drops
  // stands still with it on a moving bar.
  test("an open menu's band wears its placement's effect", () => {
    const config = parseAndValidate(
      "<test>",
      `{
        actions: { applyTheme: { set: 'theme', from: 'themes' } },
        segments: {
          left: { template: 'left cell' },
          picker: { template: '{{ menu "applyTheme" "▸" "▾" }}' },
        },
        root: { h: ["left", { seg: "picker", settings: { effect: "none" } }] },
      }`,
      undefined,
      DEFAULT_DSL_CONFIG,
    );
    const open = renderer(config, {
      [menuStateKey("picker", "applyTheme", undefined)]: "applyTheme",
    });
    try {
      const effects = new SessionEffects<RenderedLine>("s");
      const frames = INSTANTS.map((s) => open.render("shimmer", at(s), effects));
      const band = frames.map(({ rows }) => rows.find((r) => plainOf(r.runs).includes("✕"))!);
      expect(band[0]).toBeDefined();
      for (const row of band) expect(row).toEqual(band[0]);
      // [LAW:verifiable-goals] The bar above it did move.
      const top = ({ rows }: Frame) => ({ rows: rows.slice(0, 1) });
      expect(frames.some((frame) => !sameDraw(top(frame), top(frames[0]!)))).toBe(true);
    } finally {
      open.dispose();
    }
  });

  test("a segment may not declare it, and a placement may set only an effect", () => {
    expect(() =>
      parseAndValidate(
        "<test>",
        `{ segments: { x: { template: 'x', settings: { effect: { label: "e", domain: ["a"], default: "a" } } } } }`,
        undefined,
        DEFAULT_DSL_CONFIG,
      ),
    ).toThrow(/setting "effect" is one every placement already has/);
    expect(() => row(`{ seg: "middle", settings: { effect: "glow" } }`)).toThrow(
      /effect/,
    );
  });
});
