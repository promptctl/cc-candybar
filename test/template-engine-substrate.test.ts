// [LAW:behavior-not-structure] Asserts what the engine evaluates, never how the
// FuncMap is assembled. The substrate (bdi.1) is the math/datetime/conversion
// primitives + an injectable clock that later formatter migrations (bdi.3/.4)
// compile against; these tests are the contract those tickets build on.

import { createCcCandybarEngine } from "../src/template-engine/engine";

// Evaluate a source against an empty scope, return joined plain text.
function evalText(source: string, clock?: () => Date): string {
  return createCcCandybarEngine(undefined, undefined, clock)
    .parse(source)
    .evaluate({})
    .map((rt) => rt.plain)
    .join("");
}

describe("sprigMath primitives are registered", () => {
  // The exact cases the ticket enumerates as acceptance, plus the neighbors a
  // K/M-style formatter will lean on (sub/min/max).
  test.each([
    ["{{ div 1000000 1000 }}", "1000"],
    ["{{ floor (div 125 60) }}", "2"],
    ["{{ mod 125 60 }}", "5"],
    ["{{ sub 10 3 }}", "7"],
    ["{{ min 5 2 }}", "2"],
    ["{{ max 5 2 }}", "5"],
  ])("%s → %s", (src, expected) => {
    expect(evalText(src)).toBe(expected);
  });
});

describe("printf (Go builtin) handles the formatter cases", () => {
  test.each([
    ['{{ printf "%.2f" 1.5 }}', "1.50"],
    ['{{ printf "$%.2f" 0.005 }}', "$0.01"],
  ])("%s → %s", (src, expected) => {
    expect(evalText(src)).toBe(expected);
  });
});

describe("sprigConversions primitives are registered", () => {
  test.each([
    ['{{ atoi "42" }}', "42"],
    ['{{ float64 "1.5" }}', "1.5"],
    ["{{ toString 42 }}", "42"],
  ])("%s → %s", (src, expected) => {
    expect(evalText(src)).toBe(expected);
  });
});

describe("the clock seam is injectable", () => {
  // [LAW:single-enforcer] One clock feeds sprigDatetime AND createEngine. A
  // frozen clock makes `now`-dependent evaluation deterministic — the whole
  // point of threading it instead of calling new Date() inside the funcs.
  test("now / unixEpoch read the injected clock, not the wall clock", () => {
    const fixed = new Date("2026-06-04T12:00:00.000Z");
    const epoch = String(Math.floor(fixed.getTime() / 1000));
    expect(evalText("{{ unixEpoch (now) }}", () => fixed)).toBe(epoch);
  });

  test("omitting the clock falls back to a live default (advances)", () => {
    // No injected clock ⇒ the default () => new Date(). We can't assert an exact
    // value, only that it produces a plausible recent epoch (the default is wired).
    const out = Number(evalText("{{ unixEpoch (now) }}"));
    expect(out).toBeGreaterThan(1_700_000_000); // after 2023-11
  });
});

describe("domain funcs win the registration-order collisions", () => {
  // [LAW:one-source-of-truth] sprigConversions also defines `int`, but the
  // var-system cast (registered last) must win — it preserves floats where
  // sprig's int truncates. `int 3.9` → "3.9" is only possible if the domain
  // func is the live one.
  test("int is the var-system cast (preserves float), not sprig's truncating int", () => {
    expect(evalText("{{ int 3.9 }}")).toBe("3.9");
    expect(evalText("{{ int true }}")).toBe("1");
  });

  // [LAW:one-source-of-truth] sprigMath also defines `round`; the domain
  // Math.round (registered last) wins until the bdi cleanup ticket.
  test("round is Math.round (half rounds toward +∞)", () => {
    expect(evalText("{{ round 0.5 }}")).toBe("1");
    expect(evalText("{{ round -2.5 }}")).toBe("-2");
  });
});
