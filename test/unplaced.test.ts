// [LAW:verifiable-goals] A placement of a segment nothing declares drops only
// its own cell, wherever it sits — a nested row, a preset's root — and the drop
// is the load's error; any other issue still refuses the config, with the drop
// beside it.

import {
  inheritableSegmentNames,
  mergeWithDefault,
  parseDslConfig,
  validateConfig,
  validateRenderable,
} from "../src/config/dsl-loader";
import { ConfigError } from "../src/config/loader/diagnostics";
import { placementIds } from "../src/config/dsl-types";
import { rootNode } from "../src/config/root";
import { presetRoot } from "../src/config/presets";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";

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
    expect(dropped).toBeInstanceOf(ConfigError);
    for (const gone of ["ghost", "wraith", "spectre"])
      expect(dropped!.message).toContain(
        `"${gone}" does not match any declared segment`,
      );
    expect(dropped!.message).toMatch(
      /"phantom" does not match any declared segment/,
    );
  });

  test("the strict load refuses it with the same message", () => {
    const { dropped } = validateRenderable(authored(SOURCE), "<test>");
    expect(() => validateConfig(authored(SOURCE), "<test>")).toThrow(
      dropped!.message,
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

  test("a config with nothing to drop is drawn as merged", () => {
    const clean = authored(
      `{ segments: { a: { template: "a" } }, root: { h: ["a"] } }`,
    );
    const { config, dropped } = validateRenderable(clean, "<test>");
    expect(dropped).toBeNull();
    expect(config.root).toBe(clean.config.root);
  });
});
