// [LAW:single-enforcer] The one place the daemon assembles every field the DSL
// templates can read; input variables resolve their `path` against this shape.

import path from "node:path";
import os from "node:os";
import type { ClaudeHookData } from "../utils/claude.js";
import type { ClientHints } from "./protocol.js";
import type { DslConfig, Globals, VariableDecl } from "../config/dsl-types.js";
import { effectivePresetName, presetGlobals } from "../config/presets.js";
import { EDIT_MODE_KEY, EDIT_MODE_OPEN } from "../config/loader/edit-mode.js";
import {
  DEFAULT_CHARSET,
  DEFAULT_COLOR_COMPATIBILITY,
} from "../render/strip.js";
import {
  effectiveAutoWrap,
  effectiveLookName,
  effectivePadding,
  effectiveStripStyle,
  effectiveThemeName,
  DEFAULT_UPDATE_NOTICE,
} from "../themes/policy.js";
import { walkNodes } from "../config/dsl-types.js";
import { rootNode } from "../config/root.js";
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
import type {
  Charset,
  ColorCompatibility,
  StripStyle,
} from "../themes/policy.js";

// [LAW:one-source-of-truth] Resolved ONCE per render, so a trigger's label and
// the render it describes cannot disagree.
export interface EffectiveGlobals {
  readonly theme: string;
  readonly look: string;
  readonly preset: string;
  // [LAW:one-source-of-truth] From the SAME entry.state read as `preset`, so the
  // name and the authored-roots set trace to one rebuild.
  readonly presetCustomized: boolean;
  readonly style: StripStyle;
  // [LAW:one-source-of-truth] Undefined, not resolved: PlainJoiner owns the floor.
  readonly separator: string | undefined;
  readonly charset: Charset;
  readonly colorCompatibility: ColorCompatibility;
  readonly autoWrap: boolean;
  readonly padding: number;
  // No SessionState half: the dismissal is keyed on the update's identity.
  readonly updateNotice: boolean;
}

// [LAW:one-source-of-truth] ONE implementation of the precedence chain. "No
// session" travels as a VALUE: a sessionPick returning null, not a null store.
export function resolveEffectiveGlobals(
  config: DslConfig,
  sessionPick: (key: string) => string | null,
  presetCustomized: (preset: string) => boolean,
): EffectiveGlobals {
  // The preset resolves FIRST: every field below reads the globals it selects.
  const preset = effectivePresetName(
    sessionPick("preset"),
    config.globals.preset,
    config.presets,
  );
  const globals = presetGlobals(config, preset);
  // [LAW:dataflow-not-control-flow] "Edit mode is off" is the EMPTY fragment, so
  // every field below resolves by the same expression either way.
  const staged: Partial<Globals> =
    sessionPick(EDIT_MODE_KEY) === EDIT_MODE_OPEN ? config.editGlobals : {};
  return {
    preset,
    presetCustomized: presetCustomized(preset),
    theme: effectiveThemeName(
      staged.palette,
      sessionPick("theme"),
      globals.palette,
    ),
    look: effectiveLookName(
      staged.look,
      sessionPick("look"),
      globals.look,
      config.looks,
    ),
    style: effectiveStripStyle(
      staged.style,
      sessionPick("style"),
      globals.style,
    ),
    separator: staged.default_separator ?? globals.default_separator,
    autoWrap: effectiveAutoWrap(
      staged.autoWrap,
      sessionPick("autoWrap"),
      globals.autoWrap,
    ),
    padding: effectivePadding(
      staged.padding,
      sessionPick("padding"),
      globals.padding,
    ),
    charset: staged.charset ?? globals.charset ?? DEFAULT_CHARSET,
    updateNotice:
      staged.updateNotice ?? globals.updateNotice ?? DEFAULT_UPDATE_NOTICE,
    colorCompatibility:
      staged.colorCompatibility ??
      globals.colorCompatibility ??
      DEFAULT_COLOR_COMPATIBILITY,
  };
}

// [LAW:types-are-the-program] Absence is preserved; templates guard on values.
export interface RenderPayload extends ClaudeHookData {
  readonly home?: string;

  readonly git?: GitPayload;
  readonly tmux?: { readonly session: string };
  readonly host: HostPayload;
  // [LAW:one-source-of-truth] The daemon-resolved theme name — the SAME value
  // basePalette is built from, so a label and the colours cannot drift.
  readonly theme: { readonly effective: string };
  readonly look: { readonly effective: string };
  // [LAW:one-type-per-behavior] The name that selected the layout this render
  // walked, so a trigger cannot claim an arrangement the bar is not in.
  readonly preset: { readonly effective: string; readonly customized: boolean };
  // [LAW:one-type-per-behavior] theme/look's twins over the remaining
  // persistable globals. [LAW:types-are-the-program] Closed unions, not `string`.
  readonly style: { readonly effective: StripStyle };
  readonly charset: { readonly effective: Charset };
  readonly colorCompatibility: { readonly effective: ColorCompatibility };
  readonly autoWrap: { readonly effective: boolean };
  readonly padding: { readonly effective: number };

  // A provider with no data drops its field rather than emit zeros; inner fields
  // are ALSO optional, so "could not compute" stays distinct from "real zero".
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

// [LAW:one-type-per-behavior] Every field can independently be absent, and
// absence is PRESERVED: coercing to ""/0 would erase "no stashes" vs "unknown".
export interface GitPayload {
  readonly repoName?: string;
  readonly repoUrl?: string;
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
  // [LAW:no-silent-failure] Unlike every other git field, a failed lookup is
  // surfaced as `prError` — a forge outage must not look like "no PR".
  readonly prNumber?: number;
  readonly prState?: string;
  readonly prUrl?: string;
  readonly prError?: string;
}

// [LAW:one-source-of-truth] `name`/`user` are MACHINE facts the daemon reads
// directly; `ssh` is a SESSION fact, so it can ONLY arrive as a client hint.
export interface HostPayload {
  // The SHORT hostname (zsh's `%m`) — a name for a human, not a network address.
  readonly name?: string;
  // The EFFECTIVE passwd username, not `$USER`, which su/sudo leave stale.
  readonly user?: string;
  readonly ssh?: boolean;
}

export interface SessionPayload {
  readonly cost?: number;
  readonly tokens?: number;
}

export interface TodayPayload {
  readonly cost?: number;
  readonly tokens?: number;
}

// [LAW:one-type-per-behavior] Spend velocity is a derivative of cost, its own
// concept. Optional: a too-young session yields no honest rate.
export interface BurnPayload {
  readonly costPerHour?: number;
}

// [LAW:one-type-per-behavior] Three INDEPENDENTLY optional lanes: while
// streaming, `output` moves while `input` is idle, and that is not a zero.
export interface SpeedPayload {
  readonly input?: number;
  readonly output?: number;
  readonly total?: number;
  // [LAW:one-type-per-behavior] INDEPENDENTLY optional: a session that burst
  // then idled has history but no rate. A string — a series is not a scalar.
  readonly history?: string;
}

export interface BlockPayload {
  readonly nativeUtilization: number;
  readonly resetsAt: number;
  // [LAW:no-silent-failure] Absent — not 0, not a sentinel — when unprojectable.
  readonly etaMinutes?: number;
}

export interface WeeklyPayload {
  readonly percentage: number;
  readonly resetsAt: number;
  readonly etaMinutes?: number;
}

export interface CachePayload {
  readonly expiresAt: number;
}

export interface ContextPayload {
  readonly totalTokens: number;
  readonly contextLeft: number;
}

export interface MetricsPayload {
  readonly lastResponseTime?: number;
  readonly responseTime?: number;
  readonly sessionDuration?: number;
  readonly messageCount?: number;
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
}

export interface RenderPayloadDeps {
  readonly gitProvider: GitDataProvider;
  // [LAW:one-source-of-truth] One store backs BOTH `session` and `today`.
  readonly usageStore: SessionUsageStore;
  readonly contextProvider: ContextProvider;
  readonly metricsProvider: MetricsProvider;
  readonly tmuxService: TmuxService;
  // [LAW:single-enforcer] The ONE place lane failures are logged.
  readonly log: DaemonLogger;
  // [LAW:single-enforcer] The one clock every projection reads "now" from.
  readonly clock?: () => Date;
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PROJECTABLE_ELAPSED_MS = 5 * 60 * 1000;
const MIN_BURN_SECONDS = 60;

// [LAW:no-silent-failure] Under the floor a rate is noise; over the ceiling the
// prior sample predates idle time. Both ⇒ no reading.
const MIN_SPEED_SAMPLE_MS = 50;
const MAX_SPEED_SAMPLE_MS = 10 * 1000;

/**
 * Extrapolate a rate-limit window's utilization to its 100% cap. Undefined when
 * too young or with no usage yet — never a fabricated ETA. [LAW:no-silent-failure]
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
 * Session spend rate in $/hour. Undefined under a wall-clock floor where the
 * rate is a single-turn artifact; a real $0 is 0/hr. [LAW:no-silent-failure]
 */
export function projectCostPerHour(
  cost: number,
  durationSeconds: number,
): number | undefined {
  if (durationSeconds < MIN_BURN_SECONDS) return undefined;
  return (cost * 3600) / durationSeconds;
}

/**
 * Instantaneous tokens-per-second between two successive observations. Undefined
 * when the window is dishonest or the count flat; callers use -1 as the absence
 * default so 0 tok/s is never "no reading". [LAW:no-silent-failure]
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

// [LAW:effects-at-boundaries] Pure fold of one observation into three lanes.
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

// [LAW:effects-at-boundaries] An in-window pair with no tokens is a real ZERO.
function projectSpeedHistory(obs: SpeedObservation): string | undefined {
  const { samples } = obs;
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    // [LAW:no-silent-failure] An out-of-window pair is UNMEASURABLE, not zero burn.
    const deltaMs = cur.atMs - prev.atMs;
    if (deltaMs < MIN_SPEED_SAMPLE_MS || deltaMs > MAX_SPEED_SAMPLE_MS)
      continue;
    const rate = projectTokensPerSecond(
      prev.total,
      prev.atMs,
      cur.total,
      cur.atMs,
    );
    rates.push(rate ?? 0);
  }
  if (rates.length === 0) return undefined;
  return rates.join(",");
}

/**
 * The short hostname — the cell reads the same whether `os.hostname()` yields
 * an FQDN or a bare name. [LAW:effects-at-boundaries] Pure and total.
 */
export function shortHostname(hostname: string): string {
  const dot = hostname.indexOf(".");
  return dot < 0 ? hostname : hostname.slice(0, dot);
}

/**
 * Assemble the host identity. [LAW:effects-at-boundaries] The two syscalls happen
 * here, at the data-assembly edge. [LAW:no-silent-failure] A throwing one yields
 * an ABSENT field plus a description to log, never a fabricated name.
 */
function readHost(hints: ClientHints): {
  readonly host: HostPayload;
  readonly failures: readonly string[];
} {
  const failures: string[] = [];
  const attempt = (field: string, read: () => string): string | undefined => {
    try {
      const value = read();
      return value === "" ? undefined : value;
    } catch (e) {
      failures.push(`host.${field}: ${String(e)}`);
      return undefined;
    }
  };

  const name = attempt("name", () => shortHostname(os.hostname()));
  const user = attempt("user", () => os.userInfo().username);
  return {
    host: {
      ...(name !== undefined && { name }),
      ...(user !== undefined && { user }),
      // [LAW:one-source-of-truth] Straight from the hint; the daemon's own SSH_*
      // env belongs to whichever shell spawned it and would mislabel sessions.
      ...(hints.ssh !== undefined && { ssh: hints.ssh }),
    },
    failures,
  };
}

// [LAW:dataflow-not-control-flow][LAW:single-enforcer] One reachability walk owns
// "is this provider needed": the closure reachable from a rendered segment.
export function buildNeededPrefixes(config: DslConfig): ReadonlySet<string> {
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

  // Seeded from templates ONLY — `seg.vars` would mark unused vars as needed.
  const frontier: string[] = [];
  const visited = new Set<string>();

  for (const node of walkNodes(rootNode(config.root))) {
    if (node.when)
      for (const ref of extractTemplateRefs(node.when)) frontier.push(ref);
    if (node.kind !== "segment") continue;
    const seg = config.segments[node.name];
    if (!seg) continue;
    for (const src of [seg.template, seg.when, seg.bg, seg.fg]) {
      if (src) for (const ref of extractTemplateRefs(src)) frontier.push(ref);
    }
  }

  // A ref is a LEAF (an exact name) or a NAMESPACE (every leaf under a prefix).
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
    }
  }

  return inputPaths;
}

// [LAW:single-enforcer] Mirror of the scope proxy's read semantics.
function expandRef(
  decls: ReadonlyMap<string, VariableDecl>,
  ref: string,
): readonly string[] {
  let candidate = ref;
  while (candidate.length > 0) {
    if (decls.has(candidate)) return [candidate];
    const dot = candidate.lastIndexOf(".");
    if (dot < 0) break;
    candidate = candidate.slice(0, dot);
  }
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

// [LAW:dataflow-not-control-flow] Each `show*` flag comes from a declared input
// path: getGitInfo returns ""/0 for fields whose flag is unset.
function gitOptionsFromClosure(needed: ReadonlySet<string>): GitInfoOptions {
  const has = (path: string): boolean => needed.has(path);
  // All four come from one `git status --porcelain` call.
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
    ...(has("git.repoUrl") && { showRepoUrl: true }),
    ...(has("git.operation") && { showOperation: true }),
    ...(has("git.timeSinceCommit") && { showTimeSinceCommit: true }),
    // Any PR field laid out turns on the (network) forge lookup.
    ...((has("git.prNumber") ||
      has("git.prState") ||
      has("git.prUrl") ||
      has("git.prError")) && { showPullRequest: true }),
  };
}

/**
 * Compose every render-time data source into the augmented payload. A provider
 * runs only if its prefix sits in the closure from `buildNeededPrefixes`, so
 * declaring an input variable does not itself trigger work. A lane failure
 * becomes a missing field, never a blank bar.
 * [LAW:no-silent-failure][LAW:single-enforcer] THIS is the one lane-log site.
 */
export async function buildRenderPayload(
  hookData: ClaudeHookData,
  deps: RenderPayloadDeps,
  cwd: string | undefined,
  // [LAW:single-enforcer] Pre-computed at registration; the BFS is not hot-path work.
  neededInputPaths: ReadonlySet<string>,
  effective: EffectiveGlobals,
  // [LAW:locality-or-seam] Parsed hints, downstream of the wire checkpoint —
  // observed session context, not the resolved config `effective` carries.
  hints: ClientHints,
): Promise<RenderPayload> {
  const wants = (prefix: string): boolean =>
    anyPathStartsWith(neededInputPaths, prefix);

  // [LAW:single-enforcer] One clock read, so every projection agrees on "now".
  const nowMs = (deps.clock ?? (() => new Date()))().getTime();

  // [LAW:dataflow-not-control-flow] Every lane is ONE shape: needed → run (the
  // catch keeps it total), else ABSENT, so the destructure never varies.
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
    // The burn rate folds from session cost and metrics duration.
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
    // A bounded tail-read through the gated transcript-fs seam, not sync fs.
    lane("cache", wants("cache"), () =>
      cacheExpiresAt(hookData.transcript_path),
    ),
    // [LAW:one-source-of-truth] It reports the prior sample AND records this one.
    lane("speed", wants("speed"), () =>
      deps.usageStore.observeSpeed(
        hookData.session_id,
        hookData.transcript_path,
        nowMs,
      ),
    ),
  ]);
  // [LAW:effects-at-boundaries] Pure folds; the log effect happens once, here.
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
  const hostProjection = readHost(hints);
  failures.push(...hostProjection.failures);
  const usageValue = take(usage);
  const todayValue = take(today);
  const contextValue = take(context);
  const metricsValue = take(metrics);
  const tmuxValue = take(tmuxSession);
  const cacheValue = take(cacheExpiry);
  for (const f of failures) deps.log("warn", `provider fetch failed: ${f}`);
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
  const burnCost = usageValue?.session.cost;
  const burnDuration = metricsValue?.sessionDuration;
  const costPerHour =
    wants("burn") && burnCost != null && burnDuration != null
      ? projectCostPerHour(burnCost, burnDuration)
      : undefined;
  const speedObs = take(speed);
  // [LAW:dataflow-not-control-flow] Rates and history fold independently.
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

  // [LAW:single-enforcer] Path fields are normalized to POSIX separators at this
  // boundary, so templates stay platform-agnostic by construction.
  const home = posixify(process.env.HOME ?? process.env.USERPROFILE);
  const workspace = hookData.workspace
    ? {
        ...hookData.workspace,
        current_dir: posixify(hookData.workspace.current_dir) ?? "",
        project_dir: posixify(hookData.workspace.project_dir) ?? "",
      }
    : hookData.workspace;

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
    host: hostProjection.host,
    // [LAW:one-source-of-truth] Always present — the exact values the render used.
    theme: { effective: effective.theme },
    look: { effective: effective.look },
    preset: {
      effective: effective.preset,
      customized: effective.presetCustomized,
    },
    style: { effective: effective.style },
    charset: { effective: effective.charset },
    colorCompatibility: { effective: effective.colorCompatibility },
    autoWrap: { effective: effective.autoWrap },
    padding: { effective: effective.padding },
    ...(sessionPayload !== undefined && { session: sessionPayload }),
    ...(todayPayload !== undefined && { today: todayPayload }),
    ...(costPerHour !== undefined && { burn: { costPerHour } }),
    ...(speedPayload !== undefined && { speed: speedPayload }),
    ...(wants("block") &&
      fiveHour !== undefined && {
        block: {
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

// [LAW:types-are-the-program] All-null yields undefined, so the caller omits it.
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

// [LAW:single-enforcer] Normalize to forward slashes so templates can rely on
// POSIX path math; platform-guarded because backslash is a POSIX path character.
function posixify(s: string | undefined): string | undefined {
  if (s === undefined || s.length === 0) return s;
  if (path.sep !== "\\") return s;
  return s.replace(/\\/g, "/");
}

// [LAW:types-are-the-program] Pure fold to the flat shape input paths read:
// `absent`/`failed` become MISSING keys, each `failed` a description to log.
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
  const repoUrl = field("repoUrl", info.repoUrl);

  // [LAW:no-silent-failure] The PR breaks the `field` pattern: a failed lookup is
  // surfaced as `prError`, since a missing key cannot be told from "no PR".
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
      ...(repoUrl !== undefined && { repoUrl }),
      ...prFields,
    },
    failures,
  };
}
