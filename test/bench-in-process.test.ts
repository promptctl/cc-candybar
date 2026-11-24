// The in-process groups, run at the smallest sample count: each benchmark
// returns the samples it was asked for, finite, and passes its own validity
// checkpoint. The wire and client groups need the built bundle and run under
// `pnpm bench`, not here.

import { BENCHMARKS } from "../scripts/bench/suites/index";

const SAMPLES = 3;

const byId = (id: string) => {
  const found = BENCHMARKS.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no benchmark ${id}`);
  return found;
};

describe("the benchmark registry", () => {
  it("names every benchmark once, group first", () => {
    const ids = BENCHMARKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BENCHMARKS) expect(b.id.startsWith(`${b.group}.`)).toBe(true);
  });
});

describe.each([
  "stages.config.load",
  "stages.draw.width.120",
  "stages.draw.example.showcase",
  "sources.usage.cold.100",
  "sources.usage.append",
  "sources.usage.hit",
])("%s", (id) => {
  it("times the samples it is asked for", async () => {
    const outcome = await byId(id).run({ samples: SAMPLES, note: () => {} });
    expect(outcome.kind).toBe("measured");
    if (outcome.kind !== "measured") return;
    for (const series of outcome.series) {
      expect(series.samples).toHaveLength(SAMPLES);
      for (const ms of series.samples) {
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
