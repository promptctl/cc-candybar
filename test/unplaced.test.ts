// [LAW:verifiable-goals] A placement of a segment nothing declares drops only
// its own cell, wherever it sits — a nested row, a preset's root — and the drop
// is the load's error; any other issue still refuses the config, with the drop
// beside it.

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import {
  inheritableSegmentNames,
  loadConfigChain,
  mergeWithDefault,
  parseDslConfig,
  validateRenderable,
} from "../src/config/dsl-loader";
import { ConfigError } from "../src/config/loader/diagnostics";
import { placementIds } from "../src/config/dsl-types";
import { rootNode } from "../src/config/root";
import { presetRoot } from "../src/config/presets";
import { EMPTY_DEFAULT, validateConfig } from "./helpers/parse-and-validate";

const authored = (source: string) => {
  const raw = parseDslConfig(
    "<test>",
    source,
    undefined,
    inheritableSegmentNames(EMPTY_DEFAULT),
  );
  return { config: mergeWithDefault(raw, EMPTY_DEFAULT), raw, source };
};

const SOURCE = `{
  segments: { a: { template: "a" }, b: { template: "b" } },
  root: { v: [{ h: ["a", "ghost"] }, { h: [{ h: ["b", "wraith"] }] }, "spectre"] },
  presets: { other: { root: { h: ["b", "phantom"] } } },
}`;

describe("a placement of an undeclared segment", () => {
  test("drops only its own cells, at any depth and in every preset, and is the load's error", () => {
    const { config, dropped } = validateRenderable(authored(SOURCE), "<test>");
    const placed = placementIds(rootNode(config.root));
    expect(placed).toEqual(expect.arrayContaining(["a", "b"]));
    for (const gone of ["ghost", "wraith", "spectre"])
      expect(placed).not.toContain(gone);
    const other = placementIds(presetRoot(config, "other").node);
    expect(other).toContain("b");
    expect(other).not.toContain("phantom");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toBeInstanceOf(ConfigError);
    for (const gone of ["ghost", "wraith", "spectre"])
      expect(dropped[0]!.message).toContain(
        `"${gone}" does not match any declared segment`,
      );
    expect(dropped[0]!.message).toMatch(
      /"phantom" does not match any declared segment/,
    );
  });

  test("the strict load refuses it with the same message", () => {
    const { dropped } = validateRenderable(authored(SOURCE), "<test>");
    expect(() => validateConfig(authored(SOURCE), "<test>")).toThrow(
      dropped[0]!.message,
    );
  });

  test("another issue still refuses the config, the drop named beside it", () => {
    const source = `{
      segments: { a: { template: "{{ .nope }}" } },
      root: { h: ["a", "ghost"] },
    }`;
    expect(() => validateRenderable(authored(source), "<test>")).toThrow(
      /nope[\s\S]*"ghost" does not match/,
    );
  });

  test("an issue found after the drops are cut still names the drop beside it", () => {
    const source = `{
      variables: { x: { kind: "state", key: "x", default: "" }, "x.y": { kind: "state", key: "y", default: "" } },
      segments: { a: { template: "a" } },
      root: { h: ["a", "ghost"] },
    }`;
    expect(() => validateRenderable(authored(source), "<test>")).toThrow(
      /declared under the variable "x"[\s\S]*"ghost" does not match/,
    );
  });

  test("a config with nothing to drop is drawn as merged", () => {
    const clean = authored(
      `{ segments: { a: { template: "a" } }, root: { h: ["a"] } }`,
    );
    const { config, dropped } = validateRenderable(clean, "<test>");
    expect(dropped).toEqual([]);
    expect(config.root).toBe(clean.config.root);
  });
});

describe("a chain whose merge fails", () => {
  // The lower file places a segment nothing declares, which the bar draws
  // past; the upper file names an action nothing declares, which refuses it.
  const FILES: Record<string, string> = {
    "/lower.json5": `{ segments: { a: { template: "a" } }, root: { h: ["a", "ghost"] } }`,
    "/upper.json5": `{ segments: { t: { template: '{{ action "nope" "x" }}' } }, root: { h: ["t"] } }`,
  };
  test("is blamed on the error that refused it, not on a lower file's undeclared placement", () => {
    const load = () =>
      loadConfigChain(
        ["/lower.json5", "/upper.json5"],
        DEFAULT_DSL_CONFIG,
        { warned: () => {} },
        { repo: null, cwd: null },
        (p) => FILES[p]!,
      );
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/upper\.json5[\s\S]*nope/);
    expect(load).not.toThrow(/ghost/);
  });
});

describe("a lower layer's undeclared placement", () => {
  const chain = (files: Record<string, string>) =>
    loadConfigChain(
      Object.keys(files),
      DEFAULT_DSL_CONFIG,
      { warned: () => {} },
      { repo: null, cwd: null },
      (p) => files[p]!,
    );
  const LOWER = `{ segments: { a: { template: "a" } }, root: { h: ["a", "gti"] } }`;

  test("is dropped and reported against the file that wrote it, at its own line, whether or not the file above drops its own", () => {
    for (const upper of [
      `{ segments: { u: { template: "u" } } }`,
      `{ segments: { u: { template: "u" } }, presets: { p: { root: { h: ["u", "bar"] } } } }`,
    ]) {
      const { config, dropped } = chain({
        "/lower.json5": LOWER,
        "/upper.json5": upper,
      });
      expect(placementIds(rootNode(config.root))).not.toContain("gti");
      const lower = dropped.find((e) => e.file === "/lower.json5");
      expect(lower?.issues).toEqual([
        {
          path: "root.children[1]",
          message: 'root entry "gti" does not match any declared segment',
          line: 1,
        },
      ]);
      expect(
        dropped.filter((e) => e.file === "/upper.json5").map((e) => e.message),
      ).not.toContainEqual(expect.stringMatching(/gti/));
    }
  });
});

describe("two placements of one undeclared name", () => {
  test("cost their own two cells, reported as drops, never a duplicate id", () => {
    const { config, dropped } = validateRenderable(
      authored(
        `{ segments: { a: { template: "a" } }, root: { v: [{ h: ["a", "gti"] }, { h: ["gti"] }] } }`,
      ),
      "<test>",
    );
    expect(placementIds(rootNode(config.root))).toEqual(["a"]);
    expect(dropped[0]!.message).toMatch(/"gti" does not match/);
    expect(dropped[0]!.message).not.toMatch(/placements with the id/);
  });
});
