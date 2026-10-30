import { percentile } from "../scripts/lib/percentile";
import { distributionOf } from "../scripts/bench/stats";

describe("percentile", () => {
  it("is a sample that was observed, never an interpolation", () => {
    const sorted = [1, 2, 4, 8, 16];
    for (const p of [0, 0.1, 0.5, 0.9, 0.99, 1]) {
      expect(sorted).toContain(percentile(sorted, p));
    }
  });

  it("is the one sample of a series of one", () => {
    expect(percentile([7], 0.99)).toBe(7);
  });
});

describe("distributionOf", () => {
  it("reads the same series however it arrives", () => {
    const ascending = Array.from({ length: 200 }, (_, i) => i + 1);
    const shuffled = [...ascending].reverse();
    expect(distributionOf(shuffled)).toEqual(distributionOf(ascending));
  });

  it("orders its quantiles between its extremes", () => {
    const d = distributionOf([5, 1, 9, 3, 7, 2, 8, 4, 6, 10]);
    expect(d.min).toBe(1);
    expect(d.max).toBe(10);
    expect(d.min).toBeLessThanOrEqual(d.p50);
    expect(d.p50).toBeLessThanOrEqual(d.p90);
    expect(d.p90).toBeLessThanOrEqual(d.p99);
    expect(d.p99).toBeLessThanOrEqual(d.max);
    expect(d.n).toBe(10);
    expect(d.mean).toBeCloseTo(5.5);
  });

  it("reports the slowest tick as the p99 of fewer than a hundred", () => {
    const fifty = [...Array.from({ length: 49 }, () => 3), 400];
    expect(distributionOf(fifty).p99).toBe(400);
  });

  it("refuses a series that measured nothing", () => {
    expect(() => distributionOf([])).toThrow(/no samples/);
  });

  it.each([[NaN], [Infinity], [-1]])("refuses the timing %p", (bad) => {
    expect(() => distributionOf([1, bad])).toThrow(/finite, non-negative/);
  });
});
