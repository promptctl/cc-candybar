// [LAW:verifiable-goals] The step vocabulary a ◀ ▶ ? or page-arrow link carries
// (src/render/option-ring.ts): what a link spells, what the click reads back,
// and where a step lands. The draw and the click both fold through these, so
// they are pinned as pure functions with no rig.

import {
  centreOf,
  landing,
  parseStep,
  randomOther,
  ringAround,
  spellStep,
  stepOffset,
  STEP_RANDOM,
} from "../../src/render/option-ring";

describe("a step as a link spells it", () => {
  test("an offset and `random` read back as they were spelled", () => {
    for (const step of [stepOffset(1), stepOffset(-1), stepOffset(7), STEP_RANDOM]) {
      expect(parseStep(spellStep(step))).toEqual({ ok: true, step });
    }
  });

  test("anything else is refused, naming what a step is", () => {
    for (const raw of ["", "1.5", "next", "--1", " 1"]) {
      expect(parseStep(raw)).toMatchObject({
        ok: false,
        problem: expect.stringContaining("a whole number of options"),
      });
    }
  });
});

describe("a step lands on the ring the value is centred in", () => {
  const options = ["a", "b", "c", "d", "e"];

  test("an offset wraps at both ends", () => {
    expect(landing(options, "a", stepOffset(-1), 0)).toBe("e");
    expect(landing(options, "e", stepOffset(1), 0)).toBe("a");
    expect(landing(options, "c", stepOffset(2), 0)).toBe("e");
    expect(landing(options, "c", stepOffset(-7), 0)).toBe("a");
  });

  test("a value outside the domain counts as the first option", () => {
    expect(landing(options, "x", stepOffset(1), 0)).toBe("b");
    expect(ringAround(options, "")(0)).toBe(0);
    expect(centreOf(options, "x")).toBe(0);
    expect(centreOf(options, "d")).toBe(3);
  });

  test("random never lands on the option in force, and reaches every other", () => {
    for (const count of [2, 3, 7, 40]) {
      const domain = Array.from({ length: count }, (_, i) => `o${i}`);
      for (const centre of [0, count - 1]) {
        const seen = new Set<string>();
        for (let seed = 0; seed < 4000; seed++) {
          const picked = landing(
            domain,
            domain[centre]!,
            STEP_RANDOM,
            Date.UTC(2026, 9, 15) + seed * 1000,
          );
          expect(picked).not.toBe(domain[centre]);
          seen.add(picked);
        }
        expect([count, centre, seen.size]).toEqual([count, centre, count - 1]);
      }
    }
  });

  test("one option has no other: the pick is that option", () => {
    expect(randomOther(12345, 1, 0)).toBe(0);
  });
});
