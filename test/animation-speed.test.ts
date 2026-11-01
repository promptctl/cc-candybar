// [LAW:behavior-not-structure] The animation speed (brandon-menus-sjhy.nt2):
// at any speed above 1x every decorative animation — the bar's loop, a fade, a
// template's `frames` — runs that many times faster than at 1x, a change of
// speed moves no loop to another phase, and a readout of real time
// (`realtimeFrames`) keeps real time.
import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { DEFAULT_TERMINAL_THEME, RichText } from "@promptctl/rich-js";

import { selectionFor } from "./helpers/selection";
import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { SessionEffects, type RowItem } from "../src/render/effect";
import { FrameMemory } from "../src/render/frame-memory";
import { framed } from "./helpers/frames";
import type { RenderedLine } from "../src/dsl/node-registry";
import {
  ANIMATION_SPEED_NAMES,
  ANIMATION_SPEEDS,
  type AnimationSpeedName,
} from "../src/themes";
import type { Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";

// A whole multiple of the ten-second cycles below, so `frames` reads its
// first frame at at(0).
const START = 1_800_000_000 as Instant;
const at = (seconds: number): Instant => (START + seconds) as Instant;

const STILL_FRAME = {
  transitions: false,
  source: { config: {}, preset: "default", revision: 0, width: 80 },
  last: null,
  returned: () => ({ drawing: null, deeper: [] }),
  hold: (line: string) => line,
};

// The bar's loop drawn at `when`, at `speed`: the effect's own t that frame.
const loopT = (
  fx: SessionEffects<string>,
  when: Instant,
  speed: AnimationSpeedName,
): number => {
  const motion = fx.motion(
    "shimmer",
    fx.clockAt(when, ANIMATION_SPEEDS[speed]),
    STILL_FRAME,
  );
  motion.drawn();
  return fx.lastFrame().t;
};

// [LAW:types-are-the-program] A table keyed by every speed: a speed added to
// the domain does not compile here until its expected behaviour is written.
const everySpeed = <Row extends readonly unknown[]>(
  rows: Record<AnimationSpeedName, Row>,
) => ANIMATION_SPEED_NAMES.map((speed) => [speed, ...rows[speed]] as const);

describe("the bar's loop runs at the session's animation speed", () => {
  test.each(
    everySpeed({
      "1x": [10],
      "5x": [50],
      "10x": [100],
      "20x": [200],
    }),
  )("ten seconds at %s are %d seconds of the loop", (speed, t) => {
    const fx = new SessionEffects<string>("s");
    loopT(fx, at(0), speed);
    expect(loopT(fx, at(10), speed)).toBeCloseTo(t, 9);
    expect(fx.lastFrame().speed).toBe(ANIMATION_SPEEDS[speed]);
  });

  test("a change of speed moves no loop to another phase: only its pace changes", () => {
    const fx = new SessionEffects<string>("s");
    loopT(fx, at(0), "1x");
    expect(loopT(fx, at(10), "1x")).toBeCloseTo(10, 9);
    // The frame the speed changes in reads where the loop already was.
    expect(loopT(fx, at(10), "20x")).toBeCloseTo(10, 9);
    expect(loopT(fx, at(11), "20x")).toBeCloseTo(30, 9);
    // And back: the time since passed at 20x, the time after at 1x.
    expect(loopT(fx, at(12), "1x")).toBeCloseTo(50, 9);
    expect(loopT(fx, at(13), "1x")).toBeCloseTo(51, 9);
  });

  test("a frame that is never drawn moves the clock by nothing", () => {
    const fx = new SessionEffects<string>("s");
    loopT(fx, at(0), "1x");
    // A render reads the clock at 20x and throws before it is drawn.
    fx.motion("shimmer", fx.clockAt(at(5), 20), STILL_FRAME);
    expect(loopT(fx, at(10), "1x")).toBeCloseTo(10, 9);
  });
});

describe("a fade runs at the session's animation speed", () => {
  const item = (id: string): RowItem => ({
    owner: new RichText(id, { end: "" }),
    placement: {
      id,
      effect: "bar",
      ground: DEFAULT_TERMINAL_THEME.backgroundColor,
    },
  });
  const fades = {
    transitions: true,
    source: { config: {}, preset: "default", revision: 0, width: 80 },
    returned: (id: string, lines: readonly string[]) => ({
      drawing: lines.includes(id)
        ? {
            own: lines.filter((line) => line === id),
            opened: false,
            ground: DEFAULT_TERMINAL_THEME.backgroundColor,
          }
        : null,
      deeper: lines.filter((line) => line !== id),
    }),
    hold: (line: string) => line,
  };
  // One frame drawn at `when` and `speed`, `shown` saying whether `left` draws
  // in it; what is fading in after it.
  const frame = (
    fx: SessionEffects<string>,
    memory: FrameMemory<string>,
    when: Instant,
    speed: AnimationSpeedName,
    shown: boolean,
  ): ReadonlyArray<{ placement: string; t: number }> => {
    const motion = framed(
      fx,
      memory,
      "none",
      fx.clockAt(when, ANIMATION_SPEEDS[speed]),
      fades,
    );
    motion.placed("left", shown ? ["left"] : []);
    motion.row("r", "bar", shown ? [item("left")] : []);
    motion.drawn();
    return fx.lastFrame().fades;
  };

  // A speed is picked by a write to the session's state, which ends every fade
  // in flight (its revision moves), so a fade runs at one speed throughout.
  test.each(
    everySpeed({
      "1x": [1.5, [{ placement: "left", t: 1.5 }]],
      "5x": [1.5, [{ placement: "left", t: 7.5 }]],
      "10x": [3, []],
      "20x": [1.5, []],
    }),
  )("at %s, a twenty-second fade %s s in is %j", (speed, later, fading) => {
    const fx = new SessionEffects<string>("s");
    const memory = new FrameMemory<string>();
    frame(fx, memory, at(0), speed, false);
    expect(frame(fx, memory, at(1), speed, true)).toEqual([
      { placement: "left", t: 0 },
    ]);
    expect(frame(fx, memory, at(1 + later / 2), speed, true)[0]!.t).toBeCloseTo(
      (later / 2) * ANIMATION_SPEEDS[speed],
      9,
    );
    expect(frame(fx, memory, at(1 + later), speed, true)).toEqual(fading);
  });
});

describe("a template's frames run at the session's animation speed; realtimeFrames does not", () => {
  const glyphs = "abcdefghij"
    .split("")
    .map((g) => `1 "${g}"`)
    .join(" ");
  const CONFIG = parseAndValidate(
    "<test>",
    `{
      segments: {
        anim: { template: 'anim={{ frames ${glyphs} }}' },
        real: { template: 'real={{ realtimeFrames ${glyphs} }}' },
      },
      root: { h: ["anim", "real"] },
    }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );

  const drawn = (
    speed: AnimationSpeedName,
    seconds: readonly number[],
  ): string => {
    const store = new VariableStore();
    const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
    const compiled = registerDslConfig(CONFIG, registry, {
      signer: TEST_SIGNER,
      cwd: "/tmp",
    });
    const effects = new SessionEffects<RenderedLine>("s");
    try {
      return seconds
        .map((s) =>
          textOf(
            drawPayload(
              CONFIG,
              compiled,
              store,
              registry,
              {},
              at(s),
              {
                endcaps: "plain",
                colorCompatibility: "none",
                wrap: true,
                padding: 1,
                width: 160,
              },
              undefined,
              selectionFor(CONFIG, { animationSpeed: speed, effects }),
            ).frame,
          ),
        )
        .at(-1)!;
    } finally {
      registry.dispose();
    }
  };

  // Ten glyphs a second apart: `frames` reads its animation seconds, and
  // `realtimeFrames` its wall seconds, since the session's first frame.
  test.each(
    everySpeed({
      "1x": [1, "anim=b", "real=b"],
      "5x": [1, "anim=f", "real=b"],
      "10x": [0.5, "anim=f", "real=a"],
      "20x": [0.4, "anim=i", "real=a"],
    }),
  )("at %s, %d s later draws %s and %s", (speed, later, anim, real) => {
    const bar = drawn(speed, [0, later]);
    expect(bar).toContain(anim);
    expect(bar).toContain(real);
  });
});
