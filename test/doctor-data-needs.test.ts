// [LAW:verifiable-goals] brandon-doctor-v62x.onf: which placed segments need
// which outside data, read through the render's own closure, and a segment's
// `missingData: "ignore"` taking it out of the doctor's question.
// [LAW:behavior-not-structure] Every case is a config file's text through the
// real loader; the expectation is the segment names the doctor would report.

import { validateConfig } from "./helpers/parse-and-validate";
import {
  loadConfigSource,
  NO_PROJECT,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { dataNeeds } from "../src/doctor/data-needs";

function needsIn(source: string, preset: string) {
  const loaded = loadConfigSource(
    "/cfg.json5",
    source,
    DEFAULT_DSL_CONFIG,
    NO_PROJECT,
  );
  return dataNeeds(validateConfig(loaded, "/cfg.json5"), preset);
}

describe("dataNeeds", () => {
  test("the bundled bar needs rate limits, and no PR", () => {
    expect(needsIn("{}", "default")).toEqual({
      pullRequests: [],
      rateLimits: ["block", "weekly"],
    });
  });

  test("a preset placing gitPr needs the forge", () => {
    expect(needsIn("{}", "git").pullRequests).toEqual(["gitPr"]);
  });

  test("a segment set to ignore missing data needs nothing", () => {
    expect(
      needsIn(
        `{ segments: { block: { missingData: "ignore" } } }`,
        "default",
      ),
    ).toEqual({ pullRequests: [], rateLimits: ["weekly"] });
  });

  test("a user segment reading the data needs it like a bundled one", () => {
    expect(
      needsIn(
        `{ segments: { mine: { template: "{{ .weekly.percentage }}" } },
           root: { rows: { extra: { h: ["mine"] } } } }`,
        "default",
      ).rateLimits,
    ).toEqual(["block", "weekly", "mine"]);
  });

  test("a placement's own when is its segment's read", () => {
    expect(
      needsIn(
        `{ segments: { alert: { template: "hot" } },
           root: { rows: { extra: { h: [
             { seg: "alert", when: "{{ gt .block.nativeUtilization 80.0 }}" },
           ] } } } }`,
        "default",
      ).rateLimits,
    ).toEqual(["block", "weekly", "alert"]);
  });

  test("missingData outside its two words is a load error", () => {
    expect(() =>
      needsIn(`{ segments: { block: { missingData: "warn" } } }`, "default"),
    ).toThrow(/missingData/);
  });
});
