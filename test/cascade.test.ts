// [LAW:behavior-not-structure] A threshold cascade whose result is text
// (brandon-template-funcs-jku): `{{ ramp }}`'s decision with a different output
// domain. The contract is which result a value selects, and which stop lists are
// refused.
//
// The last describe is the one that earns its keep. The ascending-stop discipline is
// spelled twice — here and in rich-js's `ColorRamp` constructor — because sharing it
// would drag a generic ladder across a package boundary for twenty lines. Two
// spellings of a rule drift, so these tests hold them to the SAME behaviour on the
// same inputs instead of asserting that they agree.

import { ColorRamp, parseRgbHex } from "@promptctl/rich-js";
import type { ColorRgba } from "@promptctl/rich-js";

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { cascadeAt, parseCascadeStops } from "../src/template-engine/cascade";

const at = (value: number, ...specs: string[]): string =>
  cascadeAt(value, parseCascadeStops(specs));

describe("a text cascade selects the last stop at or below the value", () => {
  const LADDER = ["0:Smart", "40:Coasting", "70:Foggy", "90:Cooked"];

  test("each band selects its own result", () => {
    expect(at(0, ...LADDER)).toBe("Smart");
    expect(at(39, ...LADDER)).toBe("Smart");
    expect(at(40, ...LADDER)).toBe("Coasting");
    expect(at(69.9, ...LADDER)).toBe("Coasting");
    expect(at(70, ...LADDER)).toBe("Foggy");
    expect(at(90, ...LADDER)).toBe("Cooked");
    expect(at(1000, ...LADDER)).toBe("Cooked");
  });

  // The clamp `ColorRamp.at` applies, so a cascade reads the same in either domain.
  test("a value below every stop takes the first result", () => {
    expect(at(-50, ...LADDER)).toBe("Smart");
  });

  test("one stop is a constant, which is a legal cascade", () => {
    expect(at(7, "0:always")).toBe("always");
    expect(at(-7, "0:always")).toBe("always");
  });

  // Spelled the way `ramp` spells a hard edge.
  test("two stops at one position are a hard edge, the later one winning", () => {
    expect(at(49, "0:low", "50:high", "50:higher")).toBe("low");
    expect(at(50, "0:low", "50:high", "50:higher")).toBe("higher");
  });

  test("a result may be empty, a glyph, or carry colons of its own", () => {
    expect(at(5, "0:", "1:▰")).toBe("▰");
    expect(at(0, "0:", "1:▰")).toBe("");
    expect(at(9, "0:a:b")).toBe("a:b");
  });
});

describe("a malformed cascade is refused, never silently repaired", () => {
  test("no stops at all", () => {
    expect(() => parseCascadeStops([])).toThrow(/at least one stop/);
  });

  test("a stop with no position", () => {
    expect(() => parseCascadeStops(["warm"])).toThrow(
      /must be "<position>:<result>"/,
    );
  });

  test("a position that is not a number", () => {
    expect(() => parseCascadeStops(["0:calm", "hot:hot"])).toThrow(
      /must be "<position>:<result>"/,
    );
  });

  // [LAW:no-silent-failure] The one that matters: sorting would be the tempting
  // kindness, and a sorted cascade is a DIFFERENT cascade than the one written.
  test("a descending pair, rather than being sorted", () => {
    expect(() => parseCascadeStops(["80:hot", "50:warm"])).toThrow(
      /ascending position order/,
    );
  });

  test("a non-finite value", () => {
    expect(() => at(Number.NaN, "0:calm")).toThrow(/finite value/);
  });
});

// The equivalence pin. Each case is fed to BOTH ladders in the same shape; both must
// refuse, or both must accept and agree about which band a value falls in.
describe("the same discipline as ColorRamp, on the same inputs", () => {
  // parseRgbHex takes the digits without the leading "#", which its own error says
  // loudly rather than parsing to NaN channels.
  const rgba = (hex: string): ColorRgba => parseRgbHex(hex.replace("#", ""));
  const colourRamp = (stops: ReadonlyArray<[number, string]>): ColorRamp =>
    new ColorRamp(
      "step",
      stops.map(([position, hex]) => ({ at: position, color: rgba(hex) })),
    );

  test.each([
    ["no stops", [] as ReadonlyArray<[number, string]>],
    [
      "a descending pair",
      [
        [80, "#ff0000"],
        [50, "#00ff00"],
      ] as ReadonlyArray<[number, string]>,
    ],
    [
      "a non-finite position",
      [[Number.NaN, "#ff0000"]] as ReadonlyArray<[number, string]>,
    ],
  ])("both refuse %s", (_label, stops) => {
    expect(() => colourRamp(stops)).toThrow();
    expect(() =>
      parseCascadeStops(stops.map(([position, hex]) => `${position}:${hex}`)),
    ).toThrow();
  });

  // And where both accept, they pick the same band — the search itself, not just the
  // refusals, is the shared part.
  test("both select the same stop for the same value", () => {
    const stops: ReadonlyArray<[number, string]> = [
      [0, "#111111"],
      [40, "#222222"],
      [90, "#333333"],
    ];
    const ramp = colourRamp(stops);
    const specs = stops.map(([position, hex]) => `${position}:${hex}`);
    for (const value of [-10, 0, 39, 40, 89, 90, 1000]) {
      expect(cascadeAt(value, parseCascadeStops(specs))).toBe(
        ramp.at(value).hex,
      );
    }
  });
});

// The refactor's proof. The bundled `cacheTimer` carried its colour decision as a
// three-level `if` chain that could not be read as a cascade; this is that chain,
// written out, checked against the cascade that replaces it at every boundary it has.
// Behaviour-preserving by measurement, not by inspection (brandon-template-funcs-jku).
describe("the cascade that replaces cacheTimer's fg chain", () => {
  // `{{ if le m 8 }}error{{ else }}{{ if le m 20 }}warning{{ else }}foreground{{ end }}{{ end }}`
  const chain = (minutes: number): string =>
    minutes <= 8 ? "error" : minutes <= 20 ? "warning" : "foreground";

  // The stops are read OUT OF THE BUNDLED CONFIG, not restated here. A mutation
  // proved why: with the list hardcoded, moving cacheTimer's own threshold from 21 to
  // 19 broke nothing — the pin asserted the rule while the config was free to drift
  // from it. Reading the shipped expression is what makes this a pin on the bar.
  const shipped = (): string[] => {
    const fg = DEFAULT_DSL_CONFIG.segments.cacheTimer?.fg ?? "";
    const stops = [...fg.matchAll(/"(-?\d+(?:\.\d+)?:[^"]*)"/g)].map(
      (m) => m[1]!,
    );
    expect(stops.length).toBeGreaterThan(1);
    return stops;
  };

  test("selects what the if chain selected, at and around every boundary", () => {
    const stops = shipped();
    for (const minutes of [-5, 0, 1, 7, 8, 9, 10, 19, 20, 21, 22, 100]) {
      expect({
        minutes,
        picked: cascadeAt(minutes, parseCascadeStops(stops)),
      }).toEqual({ minutes, picked: chain(minutes) });
    }
  });
});
