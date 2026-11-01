// A run's result: what it measured, what it did not, what failed, and where it
// ran. The JSON file is the source of truth; the table and the comparison are
// views over it [LAW:one-source-of-truth].
//
// [LAW:types-are-the-program] A report is three lists, not one list with a
// status field: a row is always a distribution, so nothing reading rows
// checks whether it has one.

import type { Distribution } from "./stats.js";
import { distributionOf } from "./stats.js";
import type { Environment } from "./environment.js";
import { GROUPS, type Benchmark, type Facts, type Group, type Outcome } from "./types.js";

export interface Row {
  // `<benchmark id>/<series>`: one benchmark can time several quantities.
  readonly id: string;
  readonly group: Group;
  readonly distribution: Distribution;
  readonly facts: Facts;
}

export interface Report {
  readonly schema: 1;
  readonly environment: Environment;
  readonly loadAtEnd: number;
  // The factor every sample count was scaled by: runs at different scales
  // have different tails.
  readonly scale: number;
  readonly rows: readonly Row[];
  readonly skipped: ReadonlyArray<{ id: string; reason: string }>;
  readonly failed: ReadonlyArray<{ id: string; error: string }>;
}

export function rowsOf(benchmark: Benchmark, outcome: Outcome): Row[] {
  if (outcome.kind === "skipped") return [];
  return outcome.series.map((series) => ({
    id: `${benchmark.id}/${series.name}`,
    group: benchmark.group,
    distribution: distributionOf(series.samples),
    facts: outcome.facts,
  }));
}

// ms to the digits that carry information: a render is single-digit ms, a cold
// boot is seconds, and neither wants the other's precision.
export function ms(value: number): string {
  if (value < 10) return value.toFixed(2);
  if (value < 100) return value.toFixed(1);
  return value.toFixed(0);
}

// How a row moved against the same row of an earlier run. The ratio is of
// medians and of 90th percentiles, because a change to the centre and a change
// to the tail are different findings.
export interface Movement {
  readonly p50: number;
  readonly p90: number;
}

export function movementOf(
  now: Distribution,
  before: Distribution,
): Movement {
  return {
    p50: now.p50 / before.p50,
    p90: now.p90 / before.p90,
  };
}

const ratio = (r: number): string =>
  Number.isFinite(r) ? `×${r.toFixed(2)}` : "n/a";

function line(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
    .join("  ");
}

function table(
  header: readonly string[],
  body: ReadonlyArray<readonly string[]>,
): string[] {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i]!.length)),
  );
  return [
    line(header, widths),
    line(
      widths.map((w) => "─".repeat(w)),
      widths,
    ),
    ...body.map((r) => line(r, widths)),
  ];
}

// Rows that can be joined: a row in both runs is a movement; a row in only one
// is said so, so a benchmark that vanished is not read as one that held steady.
export function compare(
  report: Report,
  baseline: Report,
): {
  readonly moved: ReadonlyMap<string, Movement>;
  readonly added: readonly string[];
  readonly gone: readonly string[];
} {
  const before = new Map(baseline.rows.map((r) => [r.id, r.distribution]));
  const now = new Set(report.rows.map((r) => r.id));
  return {
    moved: new Map(
      report.rows.flatMap((r): Array<[string, Movement]> => {
        const prior = before.get(r.id);
        return prior === undefined
          ? []
          : [[r.id, movementOf(r.distribution, prior)]];
      }),
    ),
    added: report.rows.filter((r) => !before.has(r.id)).map((r) => r.id),
    gone: baseline.rows.filter((r) => !now.has(r.id)).map((r) => r.id),
  };
}

// What makes two runs unlike before any number is read.
export function unlike(a: Environment, b: Environment, scales: [number, number]): string[] {
  const differences: Array<[string, unknown, unknown]> = [
    ["cpu", a.host.cpuModel, b.host.cpuModel],
    ["cores", a.host.cpus, b.host.cpus],
    ["arch", a.host.arch, b.host.arch],
    ["memory GiB", a.host.memoryGiB, b.host.memoryGiB],
    ["native client built from this source", a.native?.builtFromThisSource ?? "no native client", b.native?.builtFromThisSource ?? "no native client"],
    ["os", `${a.host.platform} ${a.host.release}`, `${b.host.platform} ${b.host.release}`],
    ["node", a.node, b.node],
    ["scale", scales[0], scales[1]],
  ];
  return differences
    .filter(([, x, y]) => x !== y)
    .map(([what, x, y]) => `${what}: ${String(x)} now, ${String(y)} in the baseline`);
}

export function formatReport(report: Report, baseline: Report | null): string {
  const compared = baseline === null ? null : compare(report, baseline);
  const out: string[] = [];
  const env = report.environment;
  out.push(
    `cc-candybar bench @ ${env.commit.sha}${env.commit.dirty ? " (dirty)" : ""}   ${env.capturedAt}`,
    `${env.host.cpuModel} · ${env.host.cpus} cores · ${env.host.memoryGiB} GiB · ${env.host.platform} ${env.host.release} · node ${env.node}`,
    `load at start ${env.loadAtStart}, at end ${report.loadAtEnd} · sample counts × ${report.scale}` +
      (Math.max(env.loadAtStart, report.loadAtEnd) > env.host.cpus
        ? "   BUSY: more runnable work than cores — the tails are the machine's"
        : ""),
    "p99 of fewer than 100 samples is the slowest sample; n is beside every row",
    env.native === null
      ? "native client: not built"
      : `native client: ${env.native.path} (${env.native.bytes} bytes, ${env.native.builtFromThisSource ? "built from this source" : "NOT built from this source"})`,
    "",
  );
  if (compared !== null && baseline !== null) {
    for (const why of unlike(env, baseline.environment, [report.scale, baseline.scale])) {
      out.push(`baseline differs — ${why}`);
    }
    if (compared.gone.length > 0) {
      out.push(`in the baseline, not in this run: ${compared.gone.join(", ")}`);
    }
    out.push("");
  }
  const header = [
    "benchmark/series",
    "n",
    "min",
    "p50",
    "p90",
    "p99",
    "max",
    ...(compared === null ? [] : ["Δp50", "Δp90"]),
  ];
  for (const group of GROUPS) {
    const rows = report.rows.filter((r) => r.group === group);
    if (rows.length === 0) continue;
    out.push(
      `── ${group} (ms) ──`,
      ...table(
        header,
        rows.map((r) => {
          const d = r.distribution;
          const moved = compared?.moved.get(r.id);
          return [
            r.id,
            String(d.n),
            ms(d.min),
            ms(d.p50),
            ms(d.p90),
            ms(d.p99),
            ms(d.max),
            ...(compared === null
              ? []
              : moved === undefined
                ? ["new", "new"]
                : [ratio(moved.p50), ratio(moved.p90)]),
          ];
        }),
      ),
      "",
    );
  }
  for (const s of report.skipped) out.push(`skipped ${s.id}: ${s.reason}`);
  for (const f of report.failed) out.push(`FAILED  ${f.id}: ${f.error}`);
  return out.join("\n");
}

// [LAW:parse-dont-validate] The one checkpoint a baseline file crosses: it
// returns a Report or says what is wrong, so a hand-edited or older file never
// reaches the comparison as a half-shaped object.
export function parseReport(text: string, source: string): Report {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source} is not JSON: ${(e as Error).message}`);
  }
  const report = value as Partial<Report> | null;
  if (report === null || typeof report !== "object" || report.schema !== 1) {
    throw new Error(`${source} is not a schema 1 bench report`);
  }
  if (!Array.isArray(report.rows) || report.environment === undefined) {
    throw new Error(`${source} has no rows or no environment`);
  }
  const environment = report.environment as Partial<Environment>;
  if (
    typeof environment.host !== "object" ||
    environment.host === null ||
    typeof environment.node !== "string" ||
    typeof environment.commit !== "object" ||
    environment.commit === null
  ) {
    throw new Error(`${source} has an environment without a host, node or commit`);
  }
  for (const row of report.rows) {
    const d = (row as Partial<typeof row>).distribution;
    if (typeof row.id !== "string" || typeof d !== "object" || d === null) {
      throw new Error(`${source} has a row with no id or no distribution: ${JSON.stringify(row).slice(0, 120)}`);
    }
    // Throws on a row with no usable distribution.
    distributionOf([d.n, d.min, d.p50, d.p90, d.p99, d.max]);
    if (!Number.isInteger(d.n) || d.n < 1) {
      throw new Error(`${source} has a row (${row.id}) with ${d.n} samples`);
    }
  }
  return report as Report;
}
