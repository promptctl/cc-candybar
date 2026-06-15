// [LAW:effects-at-boundaries] A sparkline is a PURE projection: a numeric
// series in, a string of block glyphs out. It reads no clock, touches no
// store, accumulates nothing — any history it draws is owned by the daemon
// cache and handed in as data (cf. session-usage-store's burn-rate ring).
// [LAW:one-source-of-truth] The renderer operates on number[] (the real
// domain); the var-system can only carry a scalar across the payload→template
// seam, so `parseSeries` decodes the delimited string form at that one edge —
// the wire shape and the domain shape have a single, tested conversion.

// The eight-level block ramp, lowest→highest. Index into this is the only
// place a value's normalized height becomes a glyph.
export const SPARK_LEVELS = [
  "▁", // ▁
  "▂", // ▂
  "▃", // ▃
  "▄", // ▄
  "▅", // ▅
  "▆", // ▆
  "▇", // ▇
  "█", // █
] as const;

const LEVELS = SPARK_LEVELS.length;

// Render a numeric series as a unicode mini-graph.
//
// `width` caps the glyph count to fit a cell: the MOST RECENT `width` samples
// are shown (tail slice), so a fixed-width cell tracks the live tail of a
// growing series. Omitted → every sample renders; `width <= 0` → empty.
//
// Heights are RELATIVE to the rendered window's own min/max — a sparkline shows
// shape, never absolute magnitude, so the full ramp is always used when the
// window varies. [LAW:dataflow-not-control-flow] The mapping is one unconditional
// fold over the values; the only data-driven value is `range`, and a flat
// window (range === 0) falls to the lowest tier by the same formula's limit
// (height-above-min is 0 for every sample), not a special-cased branch.
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
    // range === 0 ⇒ every sample sits at its own min ⇒ height 0 ⇒ lowest tier.
    const idx =
      range === 0 ? 0 : Math.round(((v - min) / range) * (LEVELS - 1));
    out += SPARK_LEVELS[idx]!;
  }
  return out;
}

// Decode the delimited string a series travels as across the scalar var-system
// seam into the number[] the renderer consumes. Empty / blank tokens are the
// genuine "no sample" form (an empty payload field is ""), so they drop; a
// non-empty, non-numeric token is malformed input and fails LOUDLY rather than
// being silently skipped into a wrong-shaped graph. [LAW:no-silent-failure]
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
