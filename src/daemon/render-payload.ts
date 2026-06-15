// [LAW:single-enforcer] The single place where the daemon assembles every
// data field the DSL templates can read. The output of this function — the
// `RenderPayload` — is fed verbatim to `registry.applyInput(...)` (inside
// renderDsl), and every `kind: "input"` variable in the default DSL
// config resolves its `path` against exactly this shape.
//
// [LAW:dataflow-not-control-flow] Variability lives in the values flowing
// through here, not in hand-coded branches. The set of providers actually
// invoked is selected by inspecting the DslConfig's declared input paths —
// the *config* (data) chooses what runs. Templates use `when` predicates
// and inline guards on the resulting values to decide what renders.
//
// [LAW:one-source-of-truth] `RenderPayload` is the contract between the
// daemon's data-provider fleet and the DSL config's input declarations. The
// default config in `src/config/default-dsl-config.ts` declares input paths
// that mirror this shape; user configs MUST agree (a path that doesn't
// resolve falls back to the variable's declared default).

import path from "node:path";
import type { ClaudeHookData } from "../utils/claude.js";
import type { DslConfig, VariableDecl } from "../config/dsl-types.js";
import { walkNodes } from "../config/dsl-types.js";
import { extractTemplateRefs } from "../config/dsl-loader.js";
import type { GitInfo, GitInfoOptions } from "../segments/git.js";
import { ABSENT, failed, type Outcome } from "../utils/outcome.js";
import { cacheExpiresAt } from "../segments/cache.js";
import type { DaemonLogger } from "./log.js";
import type {
  SessionUsageStore,
  SpeedObservation,
} from "./cache/session-usage-store.js";
import type { ContextProvider } from "../segments/context.js";
import type { MetricsProvider } from "../segments/metrics.js";
import type { TmuxService } from "../segments/tmux.js";
import type { GitDataProvider } from "./cache/git.js";
import type { SessionStateRW } from "./session-state.js";

// ─── Augmented payload shape ─────────────────────────────────────────────────

// [LAW:types-are-the-program] The RenderPayload extends ClaudeHookData with
// daemon-computed fields. The new keys are all OPTIONAL on the type because
// individual provider failures (no transcript, no git repo, no tmux) leave
// their slots null/missing — and the DSL templates handle absence via
// `when`/inline guards, never by branching in this code.
export interface RenderPayload extends ClaudeHookData {
  // env-style values surfaced as paths so the DSL can read them via `input`
  // alongside the rest of the payload. (`kind: "env"` is also available for
  // arbitrary env-var lookups in user configs.)
  readonly home?: string;

  // ─── Daemon-computed augmentations ───────────────────────────────────────
  // The provider's null/absent return becomes a missing field; the DSL's
  // input-var fallback chain fills in the default.

  readonly git?: GitPayload;
  readonly tmux?: { readonly session: string };
  readonly theme?: string;

  // Usage-family. Each provider returns null when it has no data (no
  // transcript yet, no rate-limit window active, etc.); we drop the field
  // rather than emit zeros, so an unconfigured user sees their declared
  // `default`. Individual fields inside each sub-object are ALSO optional —
  // "we have a metrics object but messageCount couldn't be computed" is
  // representable distinct from "metrics object zeroed because we had to
  // satisfy a non-optional type." Absence flows through `applyInput`'s
  // fallback chain (which writes both the default value AND a last_error)
  // exactly like a missing top-level field.
  readonly session?: SessionPayload;
  readonly today?: TodayPayload;
  readonly burn?: BurnPayload;
  readonly speed?: SpeedPayload;
  readonly block?: BlockPayload;
  readonly weekly?: WeeklyPayload;
  readonly cache?: CachePayload;
  readonly context?: ContextPayload;
  readonly metrics?: MetricsPayload;
}

// Flattened projection of GitInfo: every field shape the parity bindings
// reference. [LAW:one-type-per-behavior] Same absence policy as
// MetricsPayload: every field can independently be absent (not requested,
// genuinely none, or its fetch failed), and absence is PRESERVED — the DSL
// input fallback chain emits the declared `default` and records a
// `last_error` per field. The old coerce-to-''/0 shim erased the distinction
// between "no stashes" and "stash count unknown because git failed".
export interface GitPayload {
  readonly repoName?: string;
  readonly branch?: string;
  readonly sha?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly staged?: number;
  readonly unstaged?: number;
  readonly untracked?: number;
  readonly conflicts?: number;
  readonly upstream?: string;
  readonly stash?: number;
  readonly status?: string;
  readonly operation?: string;
  readonly timeSinceCommit?: number;
  // Forge PR/MR. [LAW:no-silent-failure] Unlike every other git field (where
  // `failed` collapses to a missing key), the PR's failure is surfaced as
  // `prError` so the segment can render a VISIBLY DISTINCT marker — a forge
  // outage must not look like "no PR". The three render-distinguishable states:
  // open PR (prNumber/prState/prUrl present), lookup failed (prError present),
  // no PR (all absent → segment when-gated off).
  readonly prNumber?: number;
  readonly prState?: string;
  readonly prUrl?: string;
  readonly prError?: string;
}

export interface SessionPayload {
  readonly cost?: number;
  readonly tokens?: number;
}

export interface TodayPayload {
  readonly cost?: number;
  readonly tokens?: number;
}

// [LAW:one-type-per-behavior] The burn rate is the session's spend velocity —
// dollars per wall-clock hour — a derivative of the same cost the `session`
// segment totals, so it is its own concept, not a field bolted onto the
// totals. Optional because a too-young session yields no honest rate
// ([LAW:no-silent-failure] — absence over a single-turn artifact).
export interface BurnPayload {
  readonly costPerHour?: number;
}

// [LAW:one-type-per-behavior] Token throughput for the active turn — tokens per
// second on each of three lanes (prompt-side input, generated output, their
// total). Each lane is INDEPENDENTLY optional: during streaming `output` moves
// while `input` (fixed at turn start) is idle, so an absent `input` rate beside a
// live `output` rate is the honest shape, not a zero. Absence (no baseline yet,
// idle between turns, or a too-stale prior sample) travels as a missing field to
// the -1 default, which the `formatSpeed` helper reads as "—". [LAW:no-silent-failure]
export interface SpeedPayload {
  readonly input?: number;
  readonly output?: number;
  readonly total?: number;
  // [LAW:one-type-per-behavior] The recent burn-rate trend: a delimited series
  // of total-lane tok/s over the store's sample ring, for the `sparkline` helper.
  // It rides the speed lane because it folds from the SAME observation the three
  // instantaneous rates do, but it is INDEPENDENTLY optional — a session that
  // burst then went idle has no current rate yet still has a history to draw. It
  // travels as a string because a series cannot cross the scalar var-system seam;
  // the helper decodes it. Absent (fewer than two samples) → missing field → "".
  readonly history?: string;
}

export interface BlockPayload {
  readonly nativeUtilization: number;
  readonly resetsAt: number;
  // [LAW:types-are-the-program] Linear projection of nativeUtilization → 100%
  // at the current rate, in whole minutes. Absent (not 0, not a sentinel
  // in the type) when the window is too young or shows no usage to project
  // from — the ETA's "we cannot say" state is unrepresentable as a number,
  // so it travels as a missing field to the DSL default. [LAW:no-silent-failure]
  readonly etaMinutes?: number;
}

export interface WeeklyPayload {
  readonly percentage: number;
  readonly resetsAt: number;
  // Same projection as BlockPayload.etaMinutes over the seven-day window.
  readonly etaMinutes?: number;
}

// Prompt-cache warmth. One field — the epoch-seconds expiry instant —
// mirroring block/weekly `resetsAt` so the DSL composes the countdown via
// `minutesUntilReset`. Absent when no cache-bearing transcript entry exists.
export interface CachePayload {
  readonly expiresAt: number;
}

export interface ContextPayload {
  readonly totalTokens: number;
  readonly contextLeft: number;
}

// [LAW:types-are-the-program] Each metrics field can independently be absent
// (transcript missing, cost block absent, response-time math undefined). The
// optional fields make "no data for this dimension" distinguishable from
// "real zero" — the DSL input fallback chain emits the declared `default`
// for absent fields and records a `last_error` (`debug vars` surfaces it).
// A coerce-to-zero shim here would erase that distinction.
export interface MetricsPayload {
  readonly lastResponseTime?: number;
  readonly responseTime?: number;
  readonly sessionDuration?: number;
  readonly messageCount?: number;
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
}

// ─── Provider dependencies ────────────────────────────────────────────────────

export interface RenderPayloadDeps {
  readonly gitProvider: GitDataProvider;
  // [LAW:one-source-of-truth] One store backs BOTH the `session` and `today`
  // projections — they are folds over the same per-session records, not two
  // independent providers that could disagree.
  readonly usageStore: SessionUsageStore;
  readonly contextProvider: ContextProvider;
  readonly metricsProvider: MetricsProvider;
  readonly tmuxService: TmuxService;
  readonly sessionState: SessionStateRW;
  // [LAW:single-enforcer] The log capability for every provider lane:
  // buildRenderPayload is the ONE place lane failures are logged, so the
  // providers' interiors never log and never double-log.
  readonly log: DaemonLogger;
  // [LAW:single-enforcer] The one clock the projection math reads "now" from —
  // the same seam threaded to the template engine's `minutesUntilReset`, so
  // an ETA and the reset countdown beside it agree on the instant. Omitted ⇒
  // wall clock; tests inject a frozen clock for determinism.
  readonly clock?: () => Date;
}

// ─── Rate-limit projection (pure) ──────────────────────────────────────────────
//
// [LAW:effects-at-boundaries] The math is pure — utilization, reset instant,
// window length and `now` in; minutes-to-cap out. The only effect (reading the
// clock) stays in buildRenderPayload; these stay testable in isolation.

// Window lengths are facts of Claude's rate-limit cadence, not config: the
// five-hour block and the seven-day window.
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
// Below this much elapsed in a window, a linear projection from one early data
// point is noise — surface no ETA rather than a confidently-wrong number.
const MIN_PROJECTABLE_ELAPSED_MS = 5 * 60 * 1000;
// The same floor for the spend rate: under a minute of session wall-clock,
// $/hr is dominated by a single turn rather than a sustained burn.
const MIN_BURN_SECONDS = 60;

// tok/s is a delta between two successive render observations. The wall-time
// between them must clear a tiny floor (the clock has to have advanced — below
// it the rate is divide-by-near-zero noise) and stay under a ceiling: a gap
// wider than this means the prior sample predates an idle stretch, so the rate
// would be diluted by dead time. Both bounds → no reading (re-baseline silently
// on the next render) rather than a misleading number. [LAW:no-silent-failure]
const MIN_SPEED_SAMPLE_MS = 50;
const MAX_SPEED_SAMPLE_MS = 10 * 1000;

/**
 * Linearly extrapolate a rate-limit window's utilization to its 100% cap.
 * The window started `windowMs` before `resetsAtSec`; elapsed time and the
 * used-% give a rate, and the remaining headroom divided by that rate is the
 * minutes-to-cap. Returns undefined when the window is too young to project
 * or shows no usage yet — the caller drops the field and the segment renders
 * "—" rather than a fabricated ETA. [LAW:no-silent-failure]
 */
export function projectEtaMinutes(
  usedPercentage: number,
  resetsAtSec: number,
  windowMs: number,
  nowMs: number,
): number | undefined {
  const elapsedMs = windowMs - (resetsAtSec * 1000 - nowMs);
  if (elapsedMs < MIN_PROJECTABLE_ELAPSED_MS || usedPercentage <= 0)
    return undefined;
  const pctPerMs = usedPercentage / elapsedMs;
  const etaMs = (100 - usedPercentage) / pctPerMs;
  return Math.max(0, Math.round(etaMs / 60000));
}

/**
 * Session spend rate in dollars per hour: cost over wall-clock duration.
 * Returns undefined under a wall-clock floor where the rate is a single-turn
 * artifact, not a sustained burn. A real $0 over enough time is a true 0/hr,
 * not absence. [LAW:no-silent-failure]
 */
export function projectCostPerHour(
  cost: number,
  durationSeconds: number,
): number | undefined {
  if (durationSeconds < MIN_BURN_SECONDS) return undefined;
  return (cost * 3600) / durationSeconds;
}

/**
 * Instantaneous tokens-per-second between two successive render observations of
 * one cumulative token count. Returns undefined when the sample window is too
 * small or too large to be honest (see the floor/ceiling constants) or when the
 * count did not advance (idle / between turns — a true 0 over a real window is
 * reported as 0, but a flat count carries no throughput to report). A real
 * positive rate is always >= 0, so callers use -1 as the absence default — 0
 * tok/s never doubles as the "no reading" marker. [LAW:no-silent-failure]
 */
export function projectTokensPerSecond(
  prevTokens: number,
  prevMs: number,
  curTokens: number,
  nowMs: number,
): number | undefined {
  const deltaMs = nowMs - prevMs;
  if (deltaMs < MIN_SPEED_SAMPLE_MS || deltaMs > MAX_SPEED_SAMPLE_MS)
    return undefined;
  const deltaTokens = curTokens - prevTokens;
  if (deltaTokens <= 0) return undefined;
  return (deltaTokens * 1000) / deltaMs;
}

// [LAW:effects-at-boundaries] Pure fold of one speed observation into the
// payload's three rate lanes. No baseline (first render of a session) or every
// lane un-projectable → undefined (the whole `speed` key is dropped); otherwise
// each lane that projects contributes its rate, each that doesn't is a missing
// field → the -1 default → "—".
function projectSpeed(obs: SpeedObservation): SpeedPayload | undefined {
  const { prev, cur } = obs;
  if (prev === undefined) return undefined;
  const input = projectTokensPerSecond(
    prev.input,
    prev.atMs,
    cur.input,
    cur.atMs,
  );
  const output = projectTokensPerSecond(
    prev.output,
    prev.atMs,
    cur.output,
    cur.atMs,
  );
  const total = projectTokensPerSecond(
    prev.total,
    prev.atMs,
    cur.total,
    cur.atMs,
  );
  if (input === undefined && output === undefined && total === undefined)
    return undefined;
  return {
    ...(input !== undefined && { input }),
    ...(output !== undefined && { output }),
    ...(total !== undefined && { total }),
  };
}

// [LAW:effects-at-boundaries] Pure fold of the observation's sample ring into the
// burn-rate history string. Each adjacent pair becomes one total-lane tok/s; an
// un-projectable pair (no new tokens, or a gap outside the sample window) is a
// real ZERO-throughput interval, not absence — the series is a string of numbers,
// and 0 is the honest value for "burned nothing here" ([LAW:no-silent-failure] —
// the gap is reported, not dropped to misalign the graph). Fewer than two samples
// ⇒ no pair ⇒ undefined (the whole field drops to the "" default).
function projectSpeedHistory(obs: SpeedObservation): string | undefined {
  const { samples } = obs;
  if (samples.length < 2) return undefined;
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    const rate = projectTokensPerSecond(
      prev.total,
      prev.atMs,
      cur.total,
      cur.atMs,
    );
    rates.push(rate ?? 0);
  }
  return rates.join(",");
}

// ─── Builder ─────────────────────────────────────────────────────────────────

// ─── Config-driven provider gating ───────────────────────────────────────────
//
// [LAW:dataflow-not-control-flow] Whether a provider fires is selected by
// the active layout. Walk from `config.root` → cells nodes → their segments →
// their template strings → referenced variable names → recursive expansion through
// `template`-kind vars. The transitive closure tells us which input paths
// are actually reachable from a rendered segment; providers feeding paths
// outside that closure do not run.
//
// [LAW:single-enforcer] One reachability walk owns "is this provider
// needed." A declared-but-unreachable input variable (the default config
// declares every built-in variable for reference completeness) contributes
// no work to the hot path. Exported so the cache can compute the closure
// once at registration time (config is stable per cache entry) and reuse
// it across renders.
export function buildNeededPrefixes(config: DslConfig): ReadonlySet<string> {
  // 1. Variable name → declaration index for fast lookup. Global vars first;
  //    per-segment vars are namespaced `segName.varName` (same as runtime).
  const allDecls = new Map<string, VariableDecl>();
  for (const [name, decl] of Object.entries(config.variables)) {
    allDecls.set(name, decl);
  }
  for (const [segName, seg] of Object.entries(config.segments)) {
    if (!seg.vars) continue;
    for (const [varName, decl] of Object.entries(seg.vars)) {
      allDecls.set(`${segName}.${varName}`, decl);
    }
  }

  // 2. BFS from layout segments. Frontier seeds with refs from each
  //    rendered segment's template/when/bg/fg ONLY — segment-local vars in
  //    `seg.vars` are reached transitively via those refs (their declared
  //    names appear in the templates that need them). Seeding from
  //    `seg.vars` directly would mark unused per-segment template vars as
  //    needed and pull in their providers without justification.
  //    `visited` tracks vars whose own `template`-kind body we've already
  //    followed.
  const frontier: string[] = [];
  const visited = new Set<string>();

  for (const node of walkNodes(config.root)) {
    // A node's `when` references variables too — seed them so a provider feeding
    // only a predicate (e.g. a state var gating a row/container) isn't gated out.
    if (node.when)
      for (const ref of extractTemplateRefs(node.when)) frontier.push(ref);
    if (node.kind !== "segment") continue;
    const seg = config.segments[node.name];
    if (!seg) continue;
    for (const src of [seg.template, seg.when, seg.bg, seg.fg]) {
      if (src) for (const ref of extractTemplateRefs(src)) frontier.push(ref);
    }
  }

  // 3. Walk the closure. A ref is the dotted form `a.b.c`. Two cases:
  //    - LEAF: `ref` exactly matches a declared variable. The scope proxy
  //      treats this as the variable read.
  //    - NAMESPACE: `ref` is a strict prefix of declared variable names
  //      (e.g. `git` when only `git.branch`, `git.sha`, … are declared).
  //      The scope proxy returns a nested proxy here, which the template
  //      can iterate / stringify / pass to functions like `toJson`. A
  //      namespace read implicitly reaches every leaf under it, so every
  //      `<ref>.*` declaration becomes reachable.
  //    Both cases collapse to "expand the ref to every matching declared
  //    name." For template-kind matches, the body refs become new frontier
  //    items; for input-kind matches, the path is added to the closure.
  const inputPaths = new Set<string>();
  while (frontier.length > 0) {
    const ref = frontier.pop()!;
    for (const declName of expandRef(allDecls, ref)) {
      if (visited.has(declName)) continue;
      visited.add(declName);
      const decl = allDecls.get(declName);
      if (!decl) continue;
      if (decl.kind === "input") {
        inputPaths.add(decl.path);
      } else if (decl.kind === "template") {
        for (const r of extractTemplateRefs(decl.template)) {
          frontier.push(r);
        }
      }
      // Other kinds (literal/env/file/shell/time/git/state) declare their
      // own box without reading a payload path — they need no provider
      // gating because the daemon's payload builder is the only thing
      // this gates.
    }
  }

  return inputPaths;
}

// [LAW:single-enforcer] Mirror of the scope proxy's read semantics: a ref
// resolves either to an exact variable (leaf) or to every variable under a
// namespace prefix (`.git` matches `git.branch`, `git.sha`, …). Yields the
// set of declared names the ref reaches.
function expandRef(
  decls: ReadonlyMap<string, VariableDecl>,
  ref: string,
): readonly string[] {
  // Leaf — most specific declared name wins, mirroring lookupDecl's loop.
  let candidate = ref;
  while (candidate.length > 0) {
    if (decls.has(candidate)) return [candidate];
    const dot = candidate.lastIndexOf(".");
    if (dot < 0) break;
    candidate = candidate.slice(0, dot);
  }
  // Namespace — every name starting with `${ref}.` is reachable.
  const ns = `${ref}.`;
  const matches: string[] = [];
  for (const name of decls.keys()) {
    if (name.startsWith(ns)) matches.push(name);
  }
  return matches;
}

function anyPathStartsWith(
  paths: ReadonlySet<string>,
  prefix: string,
): boolean {
  for (const p of paths) {
    if (p === prefix || p.startsWith(prefix + ".")) return true;
  }
  return false;
}

// [LAW:dataflow-not-control-flow] Each `show*` flag is derived from a
// specific declared input path; the closure tells us exactly which fields
// the user's templates will read. Without this, GitService.getGitInfo
// silently returns "" / 0 for fields whose `show*` flag isn't set (because
// computing them requires extra git invocations), and a user who declares
// `git.sha` or `git.staged` would see their template evaluate against
// empty strings or zeros.
function gitOptionsFromClosure(needed: ReadonlySet<string>): GitInfoOptions {
  const has = (path: string): boolean => needed.has(path);
  // `git.staged` / `git.unstaged` / `git.untracked` / `git.conflicts` all
  // come from one `git status --porcelain` call — any one of them turning
  // the flag on enables all four.
  const wantsWorkingTree =
    has("git.staged") ||
    has("git.unstaged") ||
    has("git.untracked") ||
    has("git.conflicts");
  return {
    ...(has("git.sha") && { showSha: true }),
    ...(wantsWorkingTree && { showWorkingTree: true }),
    ...(has("git.stash") && { showStashCount: true }),
    ...(has("git.upstream") && { showUpstream: true }),
    ...(has("git.repoName") && { showRepoName: true }),
    ...(has("git.operation") && { showOperation: true }),
    ...(has("git.timeSinceCommit") && { showTimeSinceCommit: true }),
    // Any PR field laid out turns on the (network) forge lookup. Keep these in
    // lockstep with the projected `git.pr*` fields below.
    ...((has("git.prNumber") ||
      has("git.prState") ||
      has("git.prUrl") ||
      has("git.prError")) && { showPullRequest: true }),
  };
}

/**
 * Compose every render-time data source into the augmented payload that the
 * DSL applies to its input variables.
 *
 * Each provider runs only if its payload prefix sits in the closure
 * computed by `buildNeededPrefixes(config)` — the set of `kind: "input"`
 * paths transitively reachable from a segment in `config.root`. Merely
 * declaring an input variable does NOT trigger provider work; the variable
 * must actually be referenced by a layout-rendered segment (directly, or
 * via a chain of `template`-kind vars). The default config declares many
 * unused inputs for reference completeness — switching one on is a layout
 * edit, not a re-declaration.
 *
 * All needed providers run concurrently via `Promise.all`; each one's
 * failure becomes a missing field (handled by the DSL input fallback
 * chain). No provider error propagates to the caller — a single broken
 * source must not blank the bar.
 *
 * [LAW:no-silent-failure][LAW:single-enforcer] Every lane carries a typed
 * outcome (ok | absent | failed) and THIS function is the one log site:
 * `failed` is logged through `deps.log` and projected as a missing field,
 * `absent` is a missing field with nothing to log — the default lives in
 * the DSL declaration's `default` field, owned by the config, not buried
 * here.
 */
export async function buildRenderPayload(
  hookData: ClaudeHookData,
  deps: RenderPayloadDeps,
  cwd: string | undefined,
  // [LAW:single-enforcer] The cache pre-computes the closure once at
  // registration; passing it in (rather than recomputing per render) keeps
  // the hot path free of the BFS + extractTemplateRefs cost.
  neededInputPaths: ReadonlySet<string>,
): Promise<RenderPayload> {
  const wants = (prefix: string): boolean =>
    anyPathStartsWith(neededInputPaths, prefix);

  // [LAW:single-enforcer] One clock read feeds every projection this render —
  // the ETA extrapolations below AND the tok/s sample window in the speed lane,
  // so an ETA, a reset countdown, and a throughput figure all agree on "now".
  const nowMs = (deps.clock ?? (() => new Date()))().getTime();

  // [LAW:dataflow-not-control-flow][LAW:one-type-per-behavior] Every provider
  // lane is ONE shape: "needed → call provider (whose contract is to never
  // reject — the catch makes the lane total against bugs, mapping a throw
  // into the same logged failure path)" or "not needed → ABSENT". The skipped
  // lanes resolve immediately; no variant means lanes are present/absent at
  // the array level (which would change the destructure shape).
  const lane = <T>(
    name: string,
    needed: boolean,
    run: () => Promise<Outcome<T>>,
  ): Promise<Outcome<T>> =>
    needed
      ? run().catch((e: unknown) => failed(`${name}: ${String(e)}`))
      : Promise.resolve(ABSENT);

  const [
    gitOutcome,
    usage,
    today,
    context,
    metrics,
    tmuxSession,
    cacheExpiry,
    speed,
  ] = await Promise.all([
    lane("git", wants("git"), () =>
      deps.gitProvider.getGitInfo(
        cwd ?? hookData.workspace?.current_dir,
        gitOptionsFromClosure(neededInputPaths),
        hookData.workspace?.project_dir,
      ),
    ),
    // [LAW:dataflow-not-control-flow] The burn segment reads `burn.costPerHour`,
    // a derivative of session cost and metrics duration — so wanting `burn`
    // pulls in exactly the two lanes it is folded from.
    lane(
      "session",
      wants("session.cost") || wants("session.tokens") || wants("burn"),
      () => deps.usageStore.getUsageInfo(hookData.session_id, hookData),
    ),
    lane("today", wants("today"), () => deps.usageStore.getTodayInfo(hookData)),
    lane("context", wants("context"), () =>
      deps.contextProvider.getContextInfo(hookData),
    ),
    lane("metrics", wants("metrics") || wants("burn"), () =>
      deps.metricsProvider.getMetricsInfo(hookData.session_id, hookData),
    ),
    lane("tmux", wants("tmux"), () => deps.tmuxService.getSessionId()),
    // Prompt-cache expiry: a bounded tail-read through the gated transcript-fs
    // seam, so it runs alongside the other providers and stays in the shared
    // in-flight budget rather than blocking the event loop on sync fs.
    lane("cache", wants("cache"), () =>
      cacheExpiresAt(hookData.transcript_path),
    ),
    // [LAW:one-source-of-truth] tok/s folds from the SAME store the session
    // lane reads — observeSpeed both reports the prior sample and records this
    // render's, so it must run every render the speed segment is laid out (the
    // first establishes the baseline that the second projects from).
    lane("speed", wants("speed"), () =>
      deps.usageStore.observeSpeed(
        hookData.session_id,
        hookData.transcript_path,
        nowMs,
      ),
    ),
  ]);
  // [LAW:effects-at-boundaries] The projections are pure folds returning data
  // (payload fragment + failure descriptions); the log effect happens once,
  // here, at the edge. `take` is the total fold for the single-value lanes:
  // ok → value, absent → undefined, failed → undefined + a failure to log.
  const failures: string[] = [];
  const take = <T>(oc: Outcome<T>): T | undefined => {
    if (oc.kind === "failed") {
      failures.push(oc.reason);
      return undefined;
    }
    return oc.kind === "ok" ? oc.value : undefined;
  };

  const gitProjection = projectGitInfo(gitOutcome);
  failures.push(...gitProjection.failures);
  const usageValue = take(usage);
  const todayValue = take(today);
  const contextValue = take(context);
  const metricsValue = take(metrics);
  const tmuxValue = take(tmuxSession);
  const cacheValue = take(cacheExpiry);
  for (const f of failures) deps.log("warn", `provider fetch failed: ${f}`);
  // [LAW:dataflow-not-control-flow] block.* reads straight from hookData
  // alongside weekly. (The prior dedicated provider only re-derived
  // `minutesUntilReset(resets_at)`, which the DSL template composes via
  // the formatter func — a duplicate code path was retired.)
  const fiveHour = hookData.rate_limits?.five_hour;
  const sevenDay = hookData.rate_limits?.seven_day;
  const blockEta = fiveHour
    ? projectEtaMinutes(
        fiveHour.used_percentage,
        fiveHour.resets_at,
        FIVE_HOUR_MS,
        nowMs,
      )
    : undefined;
  const weeklyEta = sevenDay
    ? projectEtaMinutes(
        sevenDay.used_percentage,
        sevenDay.resets_at,
        SEVEN_DAY_MS,
        nowMs,
      )
    : undefined;
  // [LAW:dataflow-not-control-flow] Gated by `wants("burn")` so the rate is
  // computed only when a layout segment reads it; absent cost/duration (lane
  // skipped or provider empty) yields no rate, never a fabricated one.
  const burnCost = usageValue?.session.cost;
  const burnDuration = metricsValue?.sessionDuration;
  const costPerHour =
    wants("burn") && burnCost != null && burnDuration != null
      ? projectCostPerHour(burnCost, burnDuration)
      : undefined;
  // [LAW:effects-at-boundaries] The store reported the prev+cur samples (an
  // effect: it read state and advanced the baseline); the rate is a pure fold of
  // that data here at the edge. Absent observation (lane skipped/failed) or no
  // projectable lane → no `speed` key → every lane reads its -1 default.
  const speedObs = take(speed);
  // [LAW:dataflow-not-control-flow] The instantaneous rates and the burn-rate
  // history fold independently from one observation — either can be present
  // without the other (a fresh burst has rates but a one-sample history; an
  // idle-after-burst session has a history but no current rate). Merge whatever
  // each yields; the whole `speed` key drops only when both are absent.
  const speedRates =
    speedObs !== undefined ? projectSpeed(speedObs) : undefined;
  const speedHistory =
    speedObs !== undefined ? projectSpeedHistory(speedObs) : undefined;
  const speedPayload =
    speedRates !== undefined || speedHistory !== undefined
      ? {
          ...speedRates,
          ...(speedHistory !== undefined && { history: speedHistory }),
        }
      : undefined;

  // [LAW:one-source-of-truth] The theme variable surfaces the session's
  // resolved theme so the toolbar/tray DSL templates can encode it into
  // cc-candybar:// URLs without re-resolving. SessionState owns the value;
  // we mirror it onto the payload, not redeclare it.
  const themeRaw = wants("theme")
    ? deps.sessionState.get(hookData.session_id, "theme")
    : undefined;
  const theme = typeof themeRaw === "string" ? themeRaw : undefined;

  // home is always available — it's a single env-var read, no I/O cost.
  // Letting the gate skip it would add a branch with no win.
  // [LAW:single-enforcer] All path-shaped payload fields are normalized
  // to forward-slash separators at this boundary. The DSL's directory
  // template (and any user template that does prefix/relative-path math)
  // assumes POSIX separators; without normalization, Windows hookData
  // (current_dir = "C:\Users\Alice") would never match a forward-slash
  // home prefix. Normalize *here*, not in the template — keeps DSL
  // templates platform-agnostic by construction.
  const home = posixify(process.env.HOME ?? process.env.USERPROFILE);
  const workspace = hookData.workspace
    ? {
        ...hookData.workspace,
        current_dir: posixify(hookData.workspace.current_dir) ?? "",
        project_dir: posixify(hookData.workspace.project_dir) ?? "",
      }
    : hookData.workspace;

  // [LAW:types-are-the-program] Partial projections so absent provider data
  // travels as missing fields all the way to applyInput. Each provider's
  // null sub-fields become absent keys here; applyInput's fallback chain
  // fills in the declared DSL default and records a last_error per field.
  const sessionPayload: SessionPayload | undefined =
    usageValue === undefined
      ? undefined
      : pickNonNull({
          cost: usageValue.session.cost,
          tokens: usageValue.session.tokens,
        });
  const todayPayload: TodayPayload | undefined =
    todayValue === undefined
      ? undefined
      : { cost: todayValue.cost, tokens: todayValue.tokens };
  const metricsPayload: MetricsPayload | undefined =
    metricsValue === undefined
      ? undefined
      : pickNonNull({
          lastResponseTime: metricsValue.lastResponseTime,
          responseTime: metricsValue.responseTime,
          sessionDuration: metricsValue.sessionDuration,
          messageCount: metricsValue.messageCount,
          linesAdded: metricsValue.linesAdded,
          linesRemoved: metricsValue.linesRemoved,
        });

  return {
    ...hookData,
    ...(workspace !== undefined && { workspace }),
    ...(home !== undefined && { home }),
    ...(gitProjection.git !== undefined && { git: gitProjection.git }),
    ...(tmuxValue !== undefined && { tmux: { session: tmuxValue } }),
    ...(theme !== undefined && { theme }),
    ...(sessionPayload !== undefined && { session: sessionPayload }),
    ...(todayPayload !== undefined && { today: todayPayload }),
    ...(costPerHour !== undefined && { burn: { costPerHour } }),
    ...(speedPayload !== undefined && { speed: speedPayload }),
    ...(wants("block") &&
      fiveHour !== undefined && {
        block: {
          // [LAW:one-source-of-truth] Both fields read straight from the
          // hookData rate-limit window; the DSL composes minutesUntilReset
          // against .block.resetsAt the same way weekly does. One
          // projection rule, two segments.
          nativeUtilization: fiveHour.used_percentage,
          resetsAt: fiveHour.resets_at,
          ...(blockEta !== undefined && { etaMinutes: blockEta }),
        },
      }),
    ...(sevenDay !== undefined && {
      weekly: {
        percentage: sevenDay.used_percentage,
        resetsAt: sevenDay.resets_at,
        ...(weeklyEta !== undefined && { etaMinutes: weeklyEta }),
      },
    }),
    ...(cacheValue !== undefined && {
      cache: { expiresAt: cacheValue },
    }),
    ...(contextValue !== undefined && {
      context: {
        totalTokens: contextValue.totalTokens,
        contextLeft: contextValue.contextLeftPercentage,
      },
    }),
    ...(metricsPayload !== undefined && { metrics: metricsPayload }),
  };
}

// [LAW:types-are-the-program] Project an object with possibly-null fields
// down to a partial whose nulls have been dropped. If every field is null
// the result is undefined — caller treats that as "provider returned but
// had nothing usable" and omits the sub-object entirely.
function pickNonNull<T extends Readonly<Record<string, number | null>>>(
  src: T,
): { [K in keyof T]?: number } | undefined {
  const out: { [K in keyof T]?: number } = {};
  let any = false;
  for (const k of Object.keys(src) as Array<keyof T>) {
    const v = src[k];
    if (v !== null && v !== undefined) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

// [LAW:single-enforcer] Convert backslash-separator path strings to
// forward-slash separators so DSL templates can rely on POSIX path math
// (prefix checks, trimPrefix) on every platform. Undefined and empty
// inputs pass through unchanged. The function is platform-conditional
// only on whether `\` *could* be a separator (it never can on POSIX, so
// no harm in always converting — but the explicit guard avoids touching
// strings on non-Windows callers where backslash is meaningful
// inside path components).
function posixify(s: string | undefined): string | undefined {
  if (s === undefined || s.length === 0) return s;
  if (path.sep !== "\\") return s;
  return s.replace(/\\/g, "/");
}

// [LAW:types-are-the-program] Project the outcome-carrying GitInfo down to
// the flat shape the DSL input paths read. A pure fold: `ok` fields become
// values, `absent` and `failed` fields become MISSING keys (the DSL input
// fallback chain fills the declared default and records a last_error), and
// every `failed` contributes a description for the boundary to log — this
// function performs no effect itself ([LAW:effects-at-boundaries]).
function projectGitInfo(outcome: Outcome<GitInfo>): {
  readonly git?: GitPayload;
  readonly failures: readonly string[];
} {
  if (outcome.kind === "absent") return { failures: [] };
  if (outcome.kind === "failed") return { failures: [outcome.reason] };

  const info = outcome.value;
  const failures: string[] = [];
  const field = <T>(
    name: string,
    oc: Outcome<T> | undefined,
  ): T | undefined => {
    if (oc === undefined || oc.kind === "absent") return undefined;
    if (oc.kind === "failed") {
      failures.push(`git.${name}: ${oc.reason}`);
      return undefined;
    }
    return oc.value;
  };

  const aheadBehind = field("aheadBehind", info.aheadBehind);
  const sha = field("sha", info.sha);
  const operation = field("operation", info.operation);
  const timeSinceCommit = field("timeSinceCommit", info.timeSinceCommit);
  const stash = field("stash", info.stashCount);
  const upstream = field("upstream", info.upstream);
  const repoName = field("repoName", info.repoName);

  // [LAW:no-silent-failure] The PR deliberately breaks the `field` pattern: a
  // `failed` lookup is NOT dropped to a missing key (which the template can't
  // tell apart from "no PR"). It is BOTH logged AND surfaced as `prError` so
  // the segment renders a distinct marker. `absent` is still a missing key (no
  // PR / no forge → segment off). The reason is the gate value the template
  // tests; the same reason is logged for the operator.
  const pr = info.pullRequest;
  const prFields: {
    prNumber?: number;
    prState?: string;
    prUrl?: string;
    prError?: string;
  } = {};
  if (pr?.kind === "ok") {
    prFields.prNumber = pr.value.number;
    prFields.prState = pr.value.state;
    prFields.prUrl = pr.value.url;
  } else if (pr?.kind === "failed") {
    failures.push(`git.pr: ${pr.reason}`);
    prFields.prError = pr.reason;
  }

  return {
    git: {
      branch: info.branch,
      status: info.status,
      ...(aheadBehind !== undefined && {
        ahead: aheadBehind.ahead,
        behind: aheadBehind.behind,
      }),
      ...(info.workingTree !== undefined && {
        staged: info.workingTree.staged,
        unstaged: info.workingTree.unstaged,
        untracked: info.workingTree.untracked,
        conflicts: info.workingTree.conflicts,
      }),
      ...(sha !== undefined && { sha }),
      ...(operation !== undefined && { operation }),
      ...(timeSinceCommit !== undefined && { timeSinceCommit }),
      ...(stash !== undefined && { stash }),
      ...(upstream !== undefined && { upstream }),
      ...(repoName !== undefined && { repoName }),
      ...prFields,
    },
    failures,
  };
}
