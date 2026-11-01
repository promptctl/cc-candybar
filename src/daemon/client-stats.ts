import { describeFailure, requestOutcome } from "./client-transport";
import type { CliPlan } from "../cli-plan";
import type { RoundTripBudgets, RoundTripOutcome } from "./client-transport";
import { RuntimeStats, type StatsSnapshot } from "./stats";
import { fileEventsLine } from "./cache/file-events";
import { PACKAGE_VERSION } from "../version";
import { bakedDigest } from "./build-currency";
import { shortDigest } from "../source-digest";

// Operator-driven introspection path: legitimately slower budgets than the
// render hot path, carried as this caller's values through the shared
// round-trip in ./client-transport. [LAW:dataflow-not-control-flow]
const BUDGETS: RoundTripBudgets = { connectMs: 200, budgetMs: 500 };

// Query the running daemon for stats. Does NOT spawn a daemon — stats on a
// dead daemon is meaningless. A failure is the plan's stderr and a non-zero
// code.
export async function daemonStatsPlan(
  args: readonly string[],
): Promise<CliPlan> {
  return statsPlan(await fetchStats(), args.includes("--json"));
}

// [LAW:dataflow-not-control-flow] The outcome → (streams, exit-code) fold.
// The raw object needs no shape, so JSON mode carries whatever the daemon
// said before anything is checked; a skewed daemon's JSON is still delivered,
// beside the skew on stderr and a failing code.
export function statsPlan(
  outcome: RoundTripOutcome<StatsSnapshot>,
  wantJson: boolean,
): CliPlan {
  if (outcome.kind !== "ok") {
    return {
      stdout: "",
      stderr: `daemon-stats: ${describeFailure(outcome)}\n`,
      code: 1,
    };
  }
  const json = wantJson ? JSON.stringify(outcome.value, null, 2) + "\n" : null;
  const skew = shapeSkew(outcome.value);
  if (skew !== null) {
    return { stdout: json ?? "", stderr: `daemon-stats: ${skew}\n`, code: 1 };
  }
  return { stdout: json ?? formatStats(outcome.value), stderr: "", code: 0 };
}

export function fetchStats(): Promise<RoundTripOutcome<StatsSnapshot>> {
  // [LAW:no-defensive-null-guards] exception: trust boundary. The response is
  // an unchecked cast from socket JSON; the presence check is the explicit
  // narrowing at the wire edge (an ok response without `stats` classifies as
  // permanent/malformed_response in the transport).
  return requestOutcome(
    () => ({ kind: "stats" }),
    BUDGETS,
    (resp) => ("stats" in resp ? resp.stats : undefined),
  );
}

// [LAW:no-silent-failure] The snapshot is typed as THIS build's, and a
// daemon of another build answers with another shape: a field this build
// added is absent, and reading it as ours would throw on the first such field
// — `pnpm build` then `daemon-stats` inside the minute before the binary
// watch restarts the daemon. The invariant is the SHAPE (every field this
// client reads is there), not the build's identity: a worktree's client
// reading the main checkout's daemon is a different digest and the same
// shape, and it is refused by nothing. The fields are checked against this
// build's own reference snapshot, never a second spelling of the type, and
// only the fields a reader `reads` (daemon-stats reads them all): a doctor
// probe that reads `handlerProbes` works against a daemon from before
// `clients` existed.
export function shapeSkew(
  s: StatsSnapshot,
  reads: ReadonlyArray<keyof StatsSnapshot> = STATS_FIELDS,
): string | null {
  const reference = RuntimeStats.referenceSnapshot();
  const missing = missingFields(
    Object.fromEntries(reads.map((k) => [k, reference[k]])),
    s,
  );
  if (missing.length === 0) return null;
  // [LAW:no-defensive-null-guards] exception: trust boundary — the snapshot
  // is an unchecked cast from socket JSON, and an older daemon's carries no
  // digest field.
  const theirs = buildLabel(s.version, s.sourceDigest ?? null);
  const mine = buildLabel(PACKAGE_VERSION, bakedDigest());
  return `the daemon (${theirs}) reports no ${missing.join(", ")}; it is another build than this client (${mine}), and restarts only when its own bundle changes`;
}

const STATS_FIELDS = Object.keys(RuntimeStats.referenceSnapshot()) as Array<
  keyof StatsSnapshot
>;

// Every path of a field `reference` carries (recursing through its plain
// objects) that `value` does not, in reference order. A list or a record of
// the reference's that `value` carries as anything else is missing too: a
// reader maps a list and walks a record, so a field it cannot treat as one is
// as absent to it as no field. A union tagged by `kind` (an `Asked`) is
// judged present or absent, never below its tag: its arms carry different
// fields, so the reference's arm is no spec of the value's, and its reader
// parses the arm it got.
export function missingFields(
  reference: unknown,
  value: unknown,
  at = "",
): string[] {
  if (Array.isArray(reference)) {
    return Array.isArray(value) ? [] : [at || "<snapshot>"];
  }
  if (!isPlainObject(reference)) return [];
  if (!isPlainObject(value)) return [at || "<snapshot>"];
  if ("kind" in reference) return [];
  const missing: string[] = [];
  for (const key of Object.keys(reference)) {
    const path = at === "" ? key : `${at}.${key}`;
    if (!(key in value)) missing.push(path);
    else missing.push(...missingFields(reference[key], value[key], path));
  }
  return missing;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// [LAW:one-source-of-truth] The one spelling of a build to a person: its
// version and the short digest of the source it was built from.
export function buildLabel(version: string, digest: string | null): string {
  return `${version} [${digest === null ? "no digest" : shortDigest(digest)}]`;
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
  lines.push(`  build         ${buildLabel(s.version, s.sourceDigest)}`);
  lines.push(`  protocol      ${s.protocolVersion}`);
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
  // Each name as a JSON string: a client chose it, and one holding a newline
  // or an escape would otherwise forge rows or drive the terminal.
  lines.push(
    `  unknownFields ${s.unknownHookFields.map((f) => JSON.stringify(f)).join(", ") || "-"}`,
  );
  lines.push(``);
  lines.push(`gitCache`);
  lines.push(`  size          ${s.gitCache.size}`);
  lines.push(`  held          ${s.gitCache.held}`);
  lines.push(
    `  hit rate      ${fmtRate(s.gitCache.hits, s.gitCache.misses)} (${s.gitCache.hits} / ${s.gitCache.hits + s.gitCache.misses})`,
  );
  lines.push(`  changes       ${s.gitCache.changes}`);
  lines.push(``);
  lines.push(`usageCache`);
  lines.push(`  size          ${s.usageCache.size}`);
  lines.push(
    `  hit rate      ${fmtRate(s.usageCache.hits, s.usageCache.misses)} (${s.usageCache.hits} / ${s.usageCache.hits + s.usageCache.misses})`,
  );
  lines.push(`  sweeps        ${s.usageCache.sweeps}`);
  lines.push(``);
  lines.push(`sources`);
  for (const r of s.sources.records) {
    const refreshes = Object.entries(r.refreshes)
      .map(([by, n]) => `${by}:${n}`)
      .join(" ");
    lines.push(
      `  ${`${r.scope}/${r.name}`.padEnd(24)}  failures=${r.failures} last=${r.lastMs === null ? "-" : `${r.lastMs}ms`} refreshes ${refreshes}`,
    );
  }
  const scopes = Object.entries(s.sources.homes)
    .map(([scope, n]) => `${scope}:${n}`)
    .join(" ");
  const held = Object.entries(s.sources.held)
    .map(([source, n]) => `${source}:${n}`)
    .join(" ");
  lines.push(`  homes         ${scopes}`);
  lines.push(`  held          ${held}`);
  const storage = s.sources.pluginStorage;
  const faults = Object.entries(storage.faults)
    .map(([cause, n]) => `${cause}:${n}`)
    .join(" ");
  lines.push(
    `  plugin storage folders=${storage.folders} lost=${storage.lost} faults ${faults}`,
  );
  lines.push(`  fileEvents    ${fileEventsLine(s.fileEvents)}`);
  lines.push(``);
  lines.push(`transcriptReads`);
  lines.push(`  reads         ${s.transcriptReads.reads}`);
  lines.push(`  bytes         ${fmtBytes(s.transcriptReads.bytes)}`);
  lines.push(`  long lines    ${s.transcriptReads.longLines}`);
  lines.push(`  largest line  ${fmtBytes(s.transcriptReads.largestLine)}`);
  lines.push(``);
  lines.push(`renderCache`);
  lines.push(`  size          ${s.renderCache.size}`);
  lines.push(`  held          ${s.renderCache.held}`);
  lines.push(`  retired       ${s.renderCache.retired}`);
  lines.push(`  compiles      ${s.renderCache.compiles}`);
  lines.push(`  views         ${s.renderCache.views}`);
  lines.push(`  pinned        ${s.renderCache.pinned}`);
  lines.push(`  retired views ${s.renderCache.retiredViews}`);
  lines.push(
    `  accounted     ${fmtBytes(s.renderCache.accountedBytes)} / ${fmtBytes(s.renderCache.budgetBytes)}`,
  );
  lines.push(``);
  lines.push(`effectCache`);
  lines.push(`  sessions      ${s.effectCache.sessions}`);
  lines.push(`  effects       ${s.effectCache.effects}`);
  lines.push(``);
  lines.push(`menuIdle`);
  lines.push(`  sessions      ${s.menuIdle.sessions}`);
  lines.push(`  armed         ${s.menuIdle.armed}`);
  lines.push(`  pending       ${s.menuIdle.pending}`);
  lines.push(``);
  lines.push(`journalTurns`);
  lines.push(`  holder        ${s.journalTurns.holder ?? "-"}`);
  lines.push(`  held          ${s.journalTurns.heldMs}ms`);
  lines.push(`  queued        ${s.journalTurns.queued}`);
  lines.push(``);
  lines.push(`sessionState`);
  lines.push(`  sessions      ${s.sessionState.sessions}`);
  lines.push(`  observers     ${s.sessionState.observers}`);
  lines.push(`  revision      ${s.sessionState.revision}`);
  lines.push(``);
  lines.push(`watchers`);
  lines.push(`  active        ${s.watchers.active}`);
  lines.push(`  opened        ${s.watchers.opened}`);
  lines.push(`  closed        ${s.watchers.closed}`);
  lines.push(`  refused       ${s.watchers.refused}`);
  lines.push(`  errors        ${s.watchers.errors}`);
  lines.push(
    `  dirs          ${s.watchers.dirs.active} open (${s.watchers.dirs.opened} opened, ${s.watchers.dirs.closed} closed)`,
  );
  lines.push(``);
  lines.push(`subprocesses`);
  lines.push(`  total         ${s.subprocesses.total}`);
  lines.push(`  inFlight      ${s.subprocesses.inFlight}`);
  lines.push(`  lastMinute    ${s.subprocesses.lastMinute}`);
  // Snapshot already includes only executed categories (stats.ts:
  // snapshotSubprocesses keeps byCategory and the histograms symmetric).
  const activeCats = Object.entries(s.subprocesses.byCategory);
  const refusedRows = Object.entries(s.subprocesses.refused).map(
    ([cat, n]) => [`${cat} refused`, n] as const,
  );
  // [LAW:dataflow-not-control-flow] Column width is a function of the data,
  // not a hardcoded constant that drifts when new categories are added. The
  // padEnd(13) baseline matches the "  pid           " etc. columns above so
  // short categories still line up; longer ones expand the column.
  const colWidth = [...activeCats, ...refusedRows].reduce(
    (w, [label]) => Math.max(w, label.length),
    13,
  );
  for (const [cat, n] of activeCats) {
    const p50 = s.subprocesses.p50DurationMs[cat];
    const p99 = s.subprocesses.p99DurationMs[cat];
    const timing =
      p50 !== undefined && p99 !== undefined
        ? `  (p50 ${p50}ms · p99 ${p99}ms)`
        : "";
    lines.push(`  ${cat.padEnd(colWidth)} ${n}${timing}`);
  }
  for (const [label, n] of refusedRows) {
    lines.push(`  ${label.padEnd(colWidth)} ${n}`);
  }
  if (s.nextRestartReason) {
    lines.push(``);
    lines.push(`nextRestart    ${s.nextRestartReason}`);
  }
  return lines.join("\n") + "\n";
}
