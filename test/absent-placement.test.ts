// [LAW:behavior-not-structure] Which placement ids stand on nothing here: a
// placement of an absent plugin's segment, and every cell anchored on one,
// through any chain, judged in time linear in the placements.

import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { InsertCell } from "../src/config/dsl-types";
import type { SegmentPresence } from "../src/config/loader/plugin-scope";
import { absentPlacement } from "../src/config/loader/unplaced";

const presence = (name: string): SegmentPresence =>
  name.startsWith("repo.lit.") ? { kind: "absent" } : { kind: "declared" };
const cell = (seg: string, id: string, anchor: string): InsertCell => ({
  seg,
  id,
  anchor,
  relation: "after",
  by: { file: "/cfg.json5", entry: `insert.${id}` },
});

test("an id placed twice at every level of a deep chain on an absent placement is absent, and judged at once", () => {
  const depth = 60;
  const cells = [cell("repo.lit.ticket", "a0", "git")];
  for (let i = 1; i <= depth; i++)
    cells.push(
      cell("two", `a${i}`, `a${i - 1}`),
      cell("three", `a${i}`, `a${i - 1}`),
    );
  const started = performance.now();
  const absent = absentPlacement(DEFAULT_DSL_CONFIG, cells, presence);
  expect(absent(`a${depth}`)).toBe(true);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("a cycle of anchors stands on nothing absent, and an id one present placement holds is not absent", () => {
  const absent = absentPlacement(
    DEFAULT_DSL_CONFIG,
    [
      cell("two", "x", "y"),
      cell("three", "y", "x"),
      cell("repo.lit.ticket", "z", "git"),
      cell("two", "z", "git"),
    ],
    presence,
  );
  expect(absent("x")).toBe(false);
  expect(absent("y")).toBe(false);
  expect(absent("z")).toBe(false);
  expect(absent("nowhere")).toBe(false);
});
