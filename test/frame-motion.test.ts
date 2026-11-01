// [LAW:verifiable-goals] brandon-doctor-v62x.tgp: whether a frame moves is read
// off the cells it drew, so a template's `frames` moves the bar exactly as an
// effect does, and a bar with neither is still.

import { drawPayload } from "./helpers/draw-payload";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { picked, selectionFor } from "./helpers/selection";
import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import type { DrawnMotion } from "../src/render/drawn-motion";
import type { Frame } from "../src/render/frame";
import type { ColorCompatibility } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";

const AT = 1_800_000_000 as Instant;

// The one frame a config of one `cell` segment draws, under the globals given
// (JSON5 text), at the colour depth given.
function frameOf(
  template: string,
  globals = "{}",
  root = '{ h: ["cell"] }',
  picks: Readonly<Record<string, string>> = {},
  colorCompatibility: ColorCompatibility = "truecolor",
): Frame {
  const config = parseAndValidate(
    "<test>",
    `{ globals: ${globals}, segments: { cell: { template: ${JSON.stringify(template)} } }, root: ${root} }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const compiled = registerDslConfig(config, registry, {
    signer: TEST_SIGNER,
    cwd: "/tmp",
  });
  try {
    return drawPayload(
      config,
      compiled,
      store,
      registry,
      { session_id: "s" },
      AT,
      {
        endcaps: "powerline",
        colorCompatibility,
        wrap: true,
        padding: 1,
        width: 160,
      },
      undefined,
      selectionFor(config, {}, picked(picks)),
    ).frame;
  } finally {
    registry.dispose();
  }
}

// The motion of that frame.
const motionOf = (...args: Parameters<typeof frameOf>): DrawnMotion =>
  frameOf(...args).motion;

describe("a drawn frame says whether it moves", () => {
  test("a bar of still text under no effect is still", () => {
    expect(motionOf("still")).toBe("still");
  });

  test("a template's frames move it, with no effect on", () => {
    expect(motionOf('{{ frames 1 "a" 1 "b" }}')).toBe("moves");
  });

  test("the bar's effect moves it", () => {
    expect(motionOf("still", '{ effect: "pulse" }')).toBe("moves");
  });

  test("an effect rule that names no effect now can move it later", () => {
    expect(motionOf("still", `{ effect: '{{ "none" }}' }`)).toBe("can-move");
  });

  test("a placement wearing its own effect, hidden now, can move it later", () => {
    expect(
      motionOf(
        "still",
        "{}",
        `{ h: [{ seg: "cell", when: "{{ false }}", settings: { effect: "pulse" } }, "model"] }`,
      ),
    ).toBe("can-move");
  });

  // A session's pick of `none` is a decision: the rule it outranks arms nothing.
  test("a session's pick of no effect over an effect rule is still", () => {
    expect(
      motionOf("still", `{ effect: '{{ "pulse" }}' }`, undefined, {
        effect: "none",
      }),
    ).toBe("still");
  });

  test("placements that fade as they come and go can move it later", () => {
    expect(motionOf("still", "{ transitions: true }")).toBe("can-move");
  });
});

// [LAW:verifiable-goals] candybar-animation-wbxz.014: a frame says when it
// next changes, on the wall clock, whatever drew what changes — so a feed draws
// it then. `AT` is a whole even second: a `frames 1 "a" 1 "b"` shows "a" and
// turns a second later at 1x.
describe("a drawn frame says when it next changes, on the wall clock", () => {
  const nextOf = (...args: Parameters<typeof frameOf>): number =>
    frameOf(...args).nextChange;

  test("a still bar never changes", () => {
    expect(nextOf("still")).toBe(Infinity);
  });

  test("a template's frames turn at their beat, and at the session's speed", () => {
    expect(nextOf('{{ frames 1 "a" 1 "b" }}')).toBe(AT + 1);
    expect(
      nextOf('{{ frames 1 "a" 1 "b" }}', '{ animationSpeed: "5x" }'),
    ).toBeCloseTo(AT + 0.2, 6);
  });

  test("a readout of real time turns on the wall clock at any speed", () => {
    expect(
      nextOf('{{ realtimeFrames 1 "a" 1 "b" }}', '{ animationSpeed: "5x" }'),
    ).toBe(AT + 1);
  });

  // `stepped` draws a colour, no cells of its own, so it says its hold only
  // to the frame it is evaluated for.
  test("a stepped colour, which stamps no cell, is heard", () => {
    const stepped =
      '{{ fg (stepped 0.25 (color "primary") 0.25 (color "secondary")) "x" }}';
    expect(nextOf(stepped)).toBe(AT + 0.25);
    expect(motionOf(stepped)).toBe("moves");
  });

  // A stepped colour is heard when it is evaluated, drawn or not, so the
  // bundled gauge evaluates its climbing colour only where it draws it.
  test("the bundled effort gauge moves at max, and below it is still", () => {
    const gauge = (level: string): string =>
      `{{ template "effortGauge" (dict "effort" (dict "level" "${level}" "glyphs" "? a b c d")) }}`;
    for (const level of ["low", "medium", "high", "xhigh"])
      expect([level, nextOf(gauge(level))]).toEqual([level, Infinity]);
    expect(nextOf(gauge("max"))).toBe(AT + 1);
  });

  test("the soonest of a frame's changes is its next", () => {
    expect(
      nextOf(
        '{{ frames 1 "a" 1 "b" }}{{ fg (stepped 0.25 (color "primary") 0.25 (color "secondary")) "x" }}',
      ),
    ).toBe(AT + 0.25);
  });

  test("a continuous effect changes at once, with a template's frames beside it", () => {
    expect(nextOf("still", '{ effect: "pulse" }')).toBe(AT);
    expect(nextOf('{{ frames 1 "a" 1 "b" }}', '{ effect: "pulse" }')).toBe(AT);
  });

  // An effect moves colours, and at no colour depth there are none to move.
  test("an effect at no colour depth changes nothing: the frame is still", () => {
    expect(nextOf("still", '{ effect: "pulse" }', undefined, {}, "none")).toBe(
      Infinity,
    );
    expect(
      motionOf("still", '{ effect: "pulse" }', undefined, {}, "none"),
    ).toBe("still");
  });
});
