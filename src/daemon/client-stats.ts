import process from "node:process";
import { describeFailure, requestOutcome } from "./client-transport";
import type { RoundTripBudgets, RoundTripOutcome } from "./client-transport";
import type { StatsSnapshot } from "./stats";

// Operator-driven introspection path: legitimately slower budgets than the
// render hot path, carried as this caller's values through the shared
// round-trip in ./client-transport. [LAW:dataflow-not-control-flow]
const BUDGETS: RoundTripBudgets = { connectMs: 200, budgetMs: 500 };

// Query the running daemon for stats. Does NOT spawn a daemon — stats on a
// dead daemon is meaningless. Exits non-zero on failure with a clear message.
export async function runDaemonStats(args: readonly string[]): Promise<void> {
  const wantJson = args.includes("--json");

  const outcome = await fetchStats();
  if (outcome.kind !== "ok") {
    process.stderr.write(`daemon-stats: ${describeFailure(outcome)}\n`);
    process.exit(1);
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(outcome.value, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatStats(outcome.value));
}

function fetchStats(): Promise<RoundTripOutcome<StatsSnapshot>> {
  // [LAW:no-defensive-null-guards] exception: trust boundary. The response is
  // an unchecked cast from socket JSON; the presence check is the explicit
  // narrowing at the wire edge (an ok response without `stats` classifies as
  // permanent/malformed_response in the transport).
  return requestOutcome({ kind: "stats" }, BUDGETS, (resp) =>
    "stats" in resp ? resp.stats : undefined,
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtRate(hits: number, misses: number): string {
  const total = hits + misses;
  if (total === 0) return "n/a";
  return `${((hits / total) * 100).toFixed(1)}%`;
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${m}m`;
}

export function formatStats(s: StatsSnapshot): string {
  const lines: string[] = [];
  lines.push(`cc-candybar daemon stats`);
  lines.push(``);
  lines.push(`process`);
  lines.push(`  pid           ${s.pid}`);
  lines.push(`  version       ${s.version}`);
  lines.push(`  startedAt     ${s.startedAt}`);
  lines.push(`  uptime        ${fmtUptime(s.uptimeSec)}`);
  lines.push(`  rss           ${fmtBytes(s.rssBytes)}`);
  lines.push(`  heapUsed      ${fmtBytes(s.heapUsedBytes)}`);
  lines.push(`  heapTotal     ${fmtBytes(s.heapTotalBytes)}`);
  lines.push(`  external      ${fmtBytes(s.externalBytes)}`);
  lines.push(`  arrayBuffers  ${fmtBytes(s.arrayBuffersBytes)}`);
  lines.push(``);
  lines.push(`requests`);
  lines.push(`  total         ${s.requests.total}`);
  lines.push(`  errored       ${s.requests.errored}`);
  lines.push(`  timedOut      ${s.requests.timedOut}`);
  lines.push(`  inFlight      ${s.requests.inFlight}`);
  lines.push(``);
  lines.push(`gitCache`);
  lines.push(`  size          ${s.gitCache.size}`);
  lines.push(
    `  hit rate      ${fmtRate(s.gitCache.hits, s.gitCache.misses)} (${s.gitCache.hits} / ${s.gitCache.hits + s.gitCache.misses})`,
  );
  lines.push(`  invalidations ${s.gitCache.invalidations}`);
  lines.push(``);
  lines.push(`usageCache`);
  lines.push(`  size          ${s.usageCache.size}`);
  lines.push(
    `  hit rate      ${fmtRate(s.usageCache.hits, s.usageCache.misses)} (${s.usageCache.hits} / ${s.usageCache.hits + s.usageCache.misses})`,
  );
  lines.push(`  sweeps        ${s.usageCache.sweeps}`);
  lines.push(``);
  lines.push(`renderCache`);
  lines.push(`  size          ${s.renderCache.size}`);
  lines.push(`watchers`);
  lines.push(`  active        ${s.watchers.active}`);
  lines.push(`  opened        ${s.watchers.opened}`);
  lines.push(`  closed        ${s.watchers.closed}`);
  lines.push(`  evicted       ${s.watchers.evicted}`);
  lines.push(``);
  lines.push(`subprocesses`);
  lines.push(`  total         ${s.subprocesses.total}`);
  lines.push(`  inFlight      ${s.subprocesses.inFlight}`);
  lines.push(`  lastMinute    ${s.subprocesses.lastMinute}`);
  // Snapshot already includes only executed categories (stats.ts:
  // snapshotSubprocesses keeps byCategory and the histograms symmetric).
  const activeCats = Object.entries(s.subprocesses.byCategory);
  // [LAW:dataflow-not-control-flow] Column width is a function of the data,
  // not a hardcoded constant that drifts when new categories are added. The
  // padEnd(13) baseline matches the "  pid           " etc. columns above so
  // short categories still line up; longer ones expand the column.
  const colWidth = activeCats.reduce((w, [cat]) => Math.max(w, cat.length), 13);
  for (const [cat, n] of activeCats) {
    const p50 = s.subprocesses.p50DurationMs[cat];
    const p99 = s.subprocesses.p99DurationMs[cat];
    const timing =
      p50 !== undefined && p99 !== undefined
        ? `  (p50 ${p50}ms · p99 ${p99}ms)`
        : "";
    lines.push(`  ${cat.padEnd(colWidth)} ${n}${timing}`);
  }
  if (s.nextRestartReason) {
    lines.push(``);
    lines.push(`nextRestart    ${s.nextRestartReason}`);
  }
  return lines.join("\n") + "\n";
}
