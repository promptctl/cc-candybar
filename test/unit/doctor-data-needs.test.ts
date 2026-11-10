// [LAW:verifiable-goals] brandon-doctor-v62x.onf: which placed segments need
// which outside data, read through the render's own closure, and a segment's
// `missingData: "ignore"` taking it out of the doctor's question.
// [LAW:behavior-not-structure] Every case is a config file's text through the
// real loader; the expectation is the segment names the doctor would report.

import { validateConfig } from "../helpers/parse-and-validate";
import { NO_PROJECT } from "../helpers/no-project";
import { loadConfigSource } from "../../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import { dataNeeds } from "../../src/doctor/data-needs";

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

  describe("a segment needs what it reads through every edge the draw follows", () => {
    const BUNDLED = ["block", "weekly"];
    const placing = (decls: string): readonly string[] =>
      needsIn(
        `{ ${decls}, root: { rows: { extra: { h: ["mine"] } } } }`,
        "default",
      ).rateLimits;

    test("a read only inside one of its partials", () => {
      expect(
        placing(`segments: { mine: {
          template: '{{ template "p" . }}',
          partials: { p: "{{ .weekly.percentage }}" },
        } }`),
      ).toEqual([...BUNDLED, "mine"]);
    });

    test("a read only inside a helper handed the root", () => {
      expect(
        placing(`helpers: { pct: "{{ .weekly.percentage }}" },
          segments: { mine: { template: '{{ template "pct" . }}' } }`),
      ).toEqual([...BUNDLED, "mine"]);
    });

    test("and not a helper handed a dict, which reads the dict", () => {
      expect(
        placing(`helpers: { pct: "{{ .weekly.percentage }}" },
          segments: { mine: {
            template: '{{ template "pct" (dict "weekly" .current_dir) }}',
          } }`),
      ).toEqual(BUNDLED);
    });

    test("a read of the whole namespace", () => {
      expect(
        placing(`segments: { mine: { template: "{{ toJson .weekly }}" } }`),
      ).toEqual([...BUNDLED, "mine"]);
    });

    // The bundled settings segments bind actions by a name they compute, which
    // reaches every action's text, so they need the read too.
    test("a read only in the text of an action it binds", () => {
      expect(
        placing(`actions: { cp: { copy: "{{ .weekly.percentage }}" } },
          segments: { mine: { template: '{{ action "cp" "copy" }}' } }`),
      ).toContain("mine");
    });

    test("a read only in the cache key of a source it reads", () => {
      expect(
        placing(`variables: { stamp: {
            kind: "shell", command: "echo hi", parse: { text: true },
            cache: { key: "{{ .weekly.percentage }}" },
          } },
          segments: { mine: { template: "{{ .stamp }}" } }`),
      ).toEqual([...BUNDLED, "mine"]);
    });
  });

  test("missingData outside its two words is a load error", () => {
    expect(() =>
      needsIn(`{ segments: { block: { missingData: "warn" } } }`, "default"),
    ).toThrow(/missingData/);
  });
});
