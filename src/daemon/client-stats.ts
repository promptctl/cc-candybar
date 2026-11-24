import {
  describeFailure,
  requestOutcome,
  type ClientWorld,
  type RoundTripBudgets,
  type RoundTripOutcome,
} from "./client-transport";
import type { CliPlan } from "../cli-plan";
import { RuntimeStats } from "./stats";
import { isPlainObject } from "../config/loader/validate-core.js";
import {
  missingFields,
  type Durations,
  type RendererPanel,
  type StatsSnapshot,
} from "./foundations/stats-snapshot";
import {
  approachingLimit,
  chargeWords,
  mb,
  type ProcessMemory,
  usageWords,
} from "./foundations/memory-limit";
export { missingFields } from "./foundations/stats-snapshot";
import { fileEventsLine } from "./cache/file-events";
import { PACKAGE_VERSION } from "../version";
import { bakedDigest } from "./build-currency";
import { shortDigest } from "../facts/world-state";

// Operator-driven introspection path: legitimately slower budgets than the
// render hot path, carried as this caller's values through the shared
// round-trip in ./client-transport. [LAW:dataflow-not-control-flow]
const BUDGETS: RoundTripBudgets = { connectMs: 200, budgetMs: 500 };

// Query the running daemon for stats. Does NOT spawn a daemon — stats on a
// dead daemon is meaningless. A failure is the plan's stderr and a non-zero
// code.
export async function daemonStatsPlan(
  world: ClientWorld,
  args: readonly string[],
): Promise<CliPlan> {
  return statsPlan(await fetchStats(world), args.includes("--json"));
}

// [LAW:dataflow-not-control-flow] The outcome → (streams, exit-code) fold.
// The raw object needs no shape, so JSON mode carries whatever the daemon
// said before anything is checked; a skewed daemon's JSON is still delivered,
// beside the skew on stderr and a failing code.
export function statsPlan(
  outcome: RoundTripOutcome<StatsReply>,
  wantJson: boolean,
): CliPlan {
  if (outcome.kind !== "ok") {
    return {
      stdout: "",
      stderr: `daemon-stats: ${describeFailure(outcome)}\n`,
      code: 1,
    };
  }
  const reply = outcome.value;
  const said = reply.kind === "ours" ? reply.snapshot : reply.said;
  const json = wantJson ? JSON.stringify(said, null, 2) + "\n" : null;
  if (reply.kind === "another-build") {
    return {
      stdout: json ?? "",
      stderr: `daemon-stats: ${reply.skew}\n`,
      code: 1,
    };
  }
  return { stdout: json ?? formatStats(reply.snapshot), stderr: "", code: 0 };
}

export function fetchStats(
  world: ClientWorld,
): Promise<RoundTripOutcome<StatsReply>> {
  // An ok response without `stats` classifies as permanent/malformed_response
  // in the transport; one with it is read once, here.
  return requestOutcome(
    world,
    () => ({ kind: "stats" }),
    BUDGETS,
    (resp) => ("stats" in resp ? statsReplyOf(resp.stats) : undefined),
  );
}

// [LAW:parse-dont-validate] A daemon's stats, read where they arrive: this
// build's snapshot, or another build's, which answers with another shape (a
// field this build added is absent) and is said, never read as ours —
// `pnpm build` then `daemon-stats` inside the minute before the binary watch
// restarts the daemon. The invariant is the SHAPE (every field this client
// reads is there), not the build's identity: a worktree's client reading the
// main checkout's daemon is a different digest and the same shape, and it is
// refused by nothing. The fields are checked against this build's own
// reference snapshot, never a second spelling of the type.
export type StatsReply =
  | { readonly kind: "ours"; readonly snapshot: StatsSnapshot }
  | {
      readonly kind: "another-build";
      readonly said: unknown;
      readonly skew: string;
    };

export function statsReplyOf(said: unknown): StatsReply {
  const missing = missingFields(RuntimeStats.referenceSnapshots(), said);
  return missing.length === 0
    ? // [LAW:parse-dont-validate] The walk over the reference is the parse:
      // every field this build reads is present and usable.
      { kind: "ours", snapshot: said as StatsSnapshot }
    : {
        kind: "another-build",
        said,
        skew: `the daemon (${theirLabel(said)}) reports no ${missing.join(", ")}; ${anotherBuild}`,
      };
}

// Another build's own words for which build it is, as far as it says them.
function theirLabel(said: unknown): string {
  const word = (key: string): string | null => {
    const value = isPlainObject(said) ? said[key] : undefined;
    return typeof value === "string" ? value : null;
  };
  return buildLabel(word("version") ?? "no version", word("sourceDigest"));
}

const myLabel = buildLabel(PACKAGE_VERSION, bakedDigest());
const anotherBuild = `it is another build than this client (${myLabel}), and restarts only when its own bundle changes`;

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

const durationsText = (d: Durations): string =>
  `p50 ${d.p50Ms}ms · p90 ${d.p90Ms}ms · p99 ${d.p99Ms}ms · max ${d.maxMs}ms`;

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
  lines.push(`  memory        ${memoryWords(s.host)}`);
  lines.push(``);
  lines.push(`requests`);
  lines.push(`  total         ${s.requests.total}`);
  // Older daemons do not count the compact client's environment challenges.
  if (s.requests.environmentMisses !== undefined)
    lines.push(`  env misses    ${s.requests.environmentMisses}`);
  lines.push(`  errored       ${s.requests.errored}`);
  lines.push(`  timedOut      ${s.requests.timedOut}`);
  lines.push(`  inFlight      ${s.requests.inFlight}`);
  lines.push(
    `  took          ${s.requests.took.count === 0 ? "-" : durationsText(s.requests.took)}`,
  );
  // Each name as a JSON string: a client chose it, and one holding a newline
  // or an escape would otherwise forge rows or drive the terminal.
  lines.push(
    `  unknownFields ${s.unknownHookFields.map((f) => JSON.stringify(f)).join(", ") || "-"}`,
  );
  lines.push(``);
  lines.push(`tasks`);
  lines.push(`  threw         ${s.tasksThrew}`);
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
  for (const kind of ["shell", "file"] as const) {
    const r = s.sourceRuns[kind];
    lines.push(
      `  runs.${kind.padEnd(8)} entries=${r.entries} held=${r.held} failures=${r.failures} abandoned=${r.abandoned} last=${r.lastMs === null ? "-" : `${r.lastMs}ms`}`,
    );
  }
  lines.push(`  runs.watches  ${s.sourceRuns.watches}`);
  lines.push(``);
  lines.push(`transcriptReads`);
  lines.push(`  reads         ${s.transcriptReads.reads}`);
  lines.push(`  bytes         ${fmtBytes(s.transcriptReads.bytes)}`);
  lines.push(`  long lines    ${s.transcriptReads.longLines}`);
  lines.push(`  largest line  ${fmtBytes(s.transcriptReads.largestLine)}`);
  lines.push(``);
  lines.push(`collector`);
  lines.push(`  sessions      ${s.collector.sessions}`);
  lines.push(`  retiring      ${s.collector.retiring}`);
  lines.push(``);
  // [LAW:one-type-per-behavior] Every renderer's panel from one printer, so
  // a worktree's reads as the main renderer's does.
  for (const panel of s.renderers) lines.push(...rendererPanelLines(panel), ``);
  lines.push(`watchers`);
  lines.push(`  active        ${s.watchers.active}`);
  lines.push(`  opened        ${s.watchers.opened}`);
  lines.push(`  closed        ${s.watchers.closed}`);
  lines.push(`  refused       ${s.watchers.refused}`);
  lines.push(`  errors        ${s.watchers.errors}`);
  lines.push(
    `  dirs          ${s.watchers.dirs.active} open (${s.watchers.dirs.opened} opened, ${s.watchers.dirs.closed} closed)`,
  );
  lines.push(`  polled        ${s.watchers.polled} paths`);
  lines.push(``);
  lines.push(`subprocesses`);
  lines.push(`  total         ${s.subprocesses.total}`);
  lines.push(`  inFlight      ${s.subprocesses.inFlight}`);
  lines.push(`  lastMinute    ${s.subprocesses.lastMinute}`);
  lines.push(
    `  draining      ${s.subprocesses.draining} (${s.subprocesses.drainedBytes} bytes dropped, ${s.subprocesses.drainsCut} cut)`,
  );
  lines.push(`  pipeErrors    ${s.subprocesses.pipeErrors}`);
  // Snapshot already includes only categories that have launched. One whose
  // launches are all still running has a count and no durations yet.
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
    const durations = s.subprocesses.durations[cat];
    const timing =
      durations === undefined ? "" : `  (${durationsText(durations)})`;
    lines.push(`  ${cat.padEnd(colWidth)} ${n}${timing}`);
  }
  for (const [label, n] of refusedRows) {
    lines.push(`  ${label.padEnd(colWidth)} ${n}`);
  }
  return lines.join("\n") + "\n";
}

// [LAW:one-source-of-truth] A process's memory in one sentence: its charge
// against the limit, what it said of itself beside it, and whether the charge
// is near the limit.
function memoryWords({ memory, limit }: ProcessMemory): string {
  if (memory.kind === "unmeasured") return `unmeasured (limit ${mb(limit)} MB)`;
  const { charge, usage } = memory;
  const near =
    charge.kind !== "unread" && approachingLimit(charge.bytes, limit);
  return `${chargeWords(charge)} of limit ${mb(limit)} MB (${usageWords(usage)})${near ? ", approaching its limit" : ""}`;
}

function rendererPanelLines({
  name,
  process,
  mailbox,
  stats,
}: RendererPanel): string[] {
  const lines = [`renderer ${name}`];
  switch (process.kind) {
    case "in-host":
      lines.push(`  process       the host's, charged as the host's`);
      break;
    case "not-running":
      lines.push(`  process       not running: ${process.why}`);
      break;
    case "process":
      lines.push(`  process       pid ${process.memory.pid}`);
      lines.push(`  memory        ${memoryWords(process.memory)}`);
      break;
  }
  lines.push(
    `  mailbox       holder ${mailbox.holder ?? "-"} · held ${mailbox.heldMs}ms · queued ${mailbox.queued}`,
  );
  if (stats.kind === "failed") {
    lines.push(`  stats         unanswered: ${stats.reason}`);
    return lines;
  }
  const r = stats.value;
  lines.push(`  renderCache`);
  lines.push(`    size          ${r.renderCache.size}`);
  lines.push(`    held          ${r.renderCache.held}`);
  lines.push(`    retired       ${r.renderCache.retired}`);
  lines.push(`    compiles      ${r.renderCache.compiles}`);
  lines.push(`    views         ${r.renderCache.views}`);
  lines.push(`    pinned        ${r.renderCache.pinned}`);
  lines.push(`    retired views ${r.renderCache.retiredViews}`);
  lines.push(`    passages      ${r.renderCache.passages}`);
  lines.push(
    `    accounted     ${fmtBytes(r.renderCache.accountedBytes)} / ${fmtBytes(r.renderCache.budgetBytes)}`,
  );
  lines.push(`  effectCache`);
  lines.push(`    sessions      ${r.effectCache.sessions}`);
  lines.push(`    effects       ${r.effectCache.effects}`);
  lines.push(`  menuIdle`);
  lines.push(`    sessions      ${r.menuIdle.sessions}`);
  lines.push(`    armed         ${r.menuIdle.armed}`);
  lines.push(`  turns`);
  lines.push(`    parked        ${r.rendererTurns.parked}`);
  lines.push(`    presents      ${r.rendererTurns.presents}`);
  lines.push(`    deferrals     ${r.rendererTurns.deferrals}`);
  lines.push(`  sessionState`);
  lines.push(`    sessions      ${r.sessionState.sessions}`);
  lines.push(`    observers     ${r.sessionState.observers}`);
  lines.push(`    revision      ${r.sessionState.revision}`);
  lines.push(`  framesDrawn   ${r.framesDrawn}`);
  return lines;
}
