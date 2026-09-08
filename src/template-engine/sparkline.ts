// [LAW:effects-at-boundaries] A PURE projection: any history it draws is owned
// by the daemon cache and handed in as data. [LAW:one-source-of-truth] The
// var-system carries only scalars, so `parseSeries` is the one decode edge.
export const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

const LEVELS = SPARK_LEVELS.length;

// `width` shows the MOST RECENT samples, so a fixed cell tracks a growing
// series' tail. Heights are RELATIVE to the window's own min/max.
export function renderSparkline(values: number[], width?: number): string {
  const window =
    width === undefined ? values : width <= 0 ? [] : values.slice(-width);
  if (window.length === 0) return "";

  let min = window[0]!;
  let max = window[0]!;
  for (const v of window) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;

  let out = "";
  for (const v of window) {
    const idx =
      range === 0 ? 0 : Math.round(((v - min) / range) * (LEVELS - 1));
    out += SPARK_LEVELS[idx]!;
  }
  return out;
}

// [LAW:no-silent-failure] A blank token is the genuine "no sample" form and
// drops; a non-empty non-numeric one is malformed and fails loudly.
export function parseSeries(s: string): number[] {
  const out: number[] = [];
  for (const tok of s.split(",")) {
    const t = tok.trim();
    if (t === "") continue;
    const n = Number(t);
    if (!Number.isFinite(n)) {
      throw new TypeError(
        `sparkline: non-numeric series element ${JSON.stringify(tok)}`,
      );
    }
    out.push(n);
  }
  return out;
}
