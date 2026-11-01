import type { Environment } from "../scripts/bench/environment";
import {
  compare,
  formatReport,
  parseReport,
  rowsOf,
  type Report,
  type Row,
} from "../scripts/bench/report";
import { distributionOf } from "../scripts/bench/stats";
import { measured, skipped, type Benchmark } from "../scripts/bench/types";

const environment: Environment = {
  capturedAt: "2026-10-28T00:00:00.000Z",
  host: {
    platform: "darwin",
    arch: "arm64",
    release: "25.0",
    cpuModel: "Test CPU",
    cpus: 8,
    memoryGiB: 32,
  },
  node: "v22.0.0",
  commit: { sha: "abc1234", dirty: false },
  bundle: { modified: "2026-10-28T00:00:00.000Z" },
  native: null,
  loadAtStart: 1,
};

const row = (id: string, samples: number[]): Row => ({
  id,
  group: "wire",
  distribution: distributionOf(samples),
  facts: {},
});

const reportOf = (rows: Row[], over: Partial<Report> = {}): Report => ({
  schema: 1,
  environment,
  loadAtEnd: 1,
  scale: 1,
  rows,
  skipped: [],
  failed: [],
  ...over,
});

const benchmark: Benchmark = {
  id: "wire.tick",
  group: "wire",
  about: "",
  samples: 3,
  run: async () => skipped("unused"),
};

describe("rowsOf", () => {
  it("makes one row per series, keyed by benchmark and series", () => {
    const rows = rowsOf(
      benchmark,
      measured([
        { name: "rtt", samples: [1, 2, 3] },
        { name: "took", samples: [1, 1, 1] },
      ]),
    );
    expect(rows.map((r) => r.id)).toEqual(["wire.tick/rtt", "wire.tick/took"]);
  });

  it("makes no row for a benchmark that did not run", () => {
    expect(rowsOf(benchmark, skipped("no native client"))).toEqual([]);
  });
});

describe("compare", () => {
  it("joins rows by id and says what is new and what is gone", () => {
    const now = reportOf([row("a", [20, 20, 20]), row("b", [5, 5, 5])]);
    const before = reportOf([row("a", [10, 10, 10]), row("c", [1, 1, 1])]);
    const { moved, added, gone } = compare(now, before);
    expect(moved.get("a")).toEqual({ p50: 2, p90: 2 });
    expect(added).toEqual(["b"]);
    expect(gone).toEqual(["c"]);
  });
});

describe("parseReport", () => {
  it("returns what formatReport was given, after a trip through JSON", () => {
    const report = reportOf([row("a", [1, 2, 3])]);
    expect(parseReport(JSON.stringify(report), "r.json")).toEqual(report);
  });

  it.each([
    ["not json", "{", /not JSON/],
    ["another schema", JSON.stringify({ schema: 2 }), /not a schema 1/],
    ["no rows", JSON.stringify({ schema: 1 }), /no rows/],
  ])("refuses a file that is %s, naming it", (_, text, why) => {
    expect(() => parseReport(text, "r.json")).toThrow(why);
  });
});

describe("formatReport", () => {
  it("prints n beside every row and the movement against a baseline", () => {
    const now = reportOf([row("a", [20, 20, 20]), row("b", [5, 5, 5])]);
    const text = formatReport(now, reportOf([row("a", [10, 10, 10])]));
    expect(text).toMatch(/^a\s+3\s/m);
    expect(text).toMatch(/×2\.00/);
    expect(text).toMatch(/new/);
  });

  it("says when the machine was busier than it has cores", () => {
    const busy = reportOf([row("a", [1, 1, 1])], { loadAtEnd: 40 });
    expect(formatReport(busy, null)).toMatch(/BUSY/);
    expect(formatReport(reportOf([row("a", [1, 1, 1])]), null)).not.toMatch(/BUSY/);
  });

  it("keeps a benchmark that did not run in the report, and says why", () => {
    const text = formatReport(
      reportOf([], {
        skipped: [{ id: "client.native", reason: "no native client is built" }],
        failed: [{ id: "wire.tick.w80", error: "drew no bar" }],
      }),
      null,
    );
    expect(text).toMatch(/skipped client\.native: no native client is built/);
    expect(text).toMatch(/FAILED\s+wire\.tick\.w80: drew no bar/);
  });

  it("names how a baseline's machine differs before any number is read", () => {
    const other = reportOf([row("a", [1, 1, 1])], {
      environment: { ...environment, node: "v20.0.0" },
    });
    expect(formatReport(reportOf([row("a", [1, 1, 1])]), other)).toMatch(
      /baseline differs — node: v22\.0\.0 now, v20\.0\.0 in the baseline/,
    );
  });
});
