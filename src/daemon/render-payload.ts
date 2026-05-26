// [LAW:single-enforcer] The single place where the daemon assembles every
// data field the DSL templates can read. The output of this function — the
// `RenderPayload` — is fed verbatim to `registry.applyInput(...)` (inside
// renderDslLine), and every `kind: "input"` variable in the default DSL
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

import type { ClaudeHookData } from "../utils/claude.js";
import type { DslConfig } from "../config/dsl-types.js";
import type { GitInfo } from "../segments/git.js";
import type { UsageProvider } from "../segments/session.js";
import type { TodayProvider } from "../segments/today.js";
import type { ContextProvider } from "../segments/context.js";
import type { MetricsProvider } from "../segments/metrics.js";
import type { BlockProvider } from "../segments/block.js";
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
  readonly block?: BlockPayload;
  readonly weekly?: WeeklyPayload;
  readonly context?: ContextPayload;
  readonly metrics?: MetricsPayload;
}

// Flattened projection of GitInfo: every field shape the parity bindings
// reference. Optional fields project to defaulted scalars at this boundary so
// the DSL input path always lands on a value of the declared type.
export interface GitPayload {
  readonly repoName: string;
  readonly branch: string;
  readonly sha: string;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicts: number;
  readonly upstream: string;
  readonly stash: number;
  readonly status: string;
}

export interface SessionPayload {
  readonly cost?: number;
  readonly tokens?: number;
}

export interface TodayPayload {
  readonly cost?: number;
  readonly tokens?: number;
}

export interface BlockPayload {
  readonly nativeUtilization: number;
  readonly resetsAt: number;
}

export interface WeeklyPayload {
  readonly percentage: number;
  readonly resetsAt: number;
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
  readonly usageProvider: UsageProvider;
  readonly todayProvider: TodayProvider;
  readonly contextProvider: ContextProvider;
  readonly metricsProvider: MetricsProvider;
  readonly blockProvider: BlockProvider;
  readonly tmuxService: TmuxService;
  readonly sessionState: SessionStateRW;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

// Autocompact buffer used by the context provider. Hardcoded here because the
// DSL config has no equivalent of the legacy `context.autocompactBuffer` knob
// — if a user needs a different value, they configure the context segment's
// template to compute differently. Matches the legacy default.
const DEFAULT_AUTOCOMPACT_BUFFER = 33000;

// ─── Config-driven provider gating ───────────────────────────────────────────
//
// [LAW:dataflow-not-control-flow] Whether a provider fires is selected by
// the DslConfig's declared input paths, not by a hardcoded segment-enabled
// boolean (as the legacy renderer used). If no `kind: "input"` variable
// reads a path starting with `metrics.`, the metrics provider does not run
// — the JSONL parse + `findTranscriptFile` walk simply do not happen. The
// same rule covers every other prefix uniformly.
//
// [LAW:single-enforcer] One predicate defines "needed" — adding a new
// payload prefix means declaring an input var that references it; no other
// flag, no second gate.
function buildNeededPrefixes(config: DslConfig): ReadonlySet<string> {
  const needed = new Set<string>();
  const scan = (decls: Readonly<Record<string, unknown>>): void => {
    for (const decl of Object.values(decls)) {
      if (
        decl !== null &&
        typeof decl === "object" &&
        "kind" in decl &&
        (decl as { kind: string }).kind === "input" &&
        "path" in decl &&
        typeof (decl as { path: unknown }).path === "string"
      ) {
        needed.add((decl as { path: string }).path);
      }
    }
  };
  scan(config.variables);
  for (const seg of Object.values(config.segments)) {
    if (seg.vars) scan(seg.vars);
  }
  return needed;
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

/**
 * Compose every render-time data source into the augmented payload that the
 * DSL applies to its input variables.
 *
 * Each provider runs only if the active DslConfig declares at least one
 * `kind: "input"` variable whose `path` reads from that provider's payload
 * prefix (e.g. `metrics.*`). All needed providers run concurrently via
 * `Promise.all`; each one's failure becomes a missing field (handled by the
 * DSL input fallback chain). No provider error propagates to the caller —
 * a single broken source must not blank the bar.
 *
 * [LAW:no-silent-fallbacks] Provider rejections are logged by the underlying
 * data-provider layer; an absent field is the explicit signal that the DSL
 * input fallback uses. This function does not silently coerce nulls to zeros
 * — that decision lives in the DSL declaration's `default` field, owned by
 * the config, not buried here.
 */
export async function buildRenderPayload(
  hookData: ClaudeHookData,
  deps: RenderPayloadDeps,
  cwd: string | undefined,
  config: DslConfig,
): Promise<RenderPayload> {
  const needed = buildNeededPrefixes(config);
  const wants = (prefix: string): boolean =>
    anyPathStartsWith(needed, prefix);

  // [LAW:dataflow-not-control-flow] Each provider lane is the same shape:
  // either "needed → call provider with .catch(() => null)" or "not needed
  // → resolve(null)". The skipped lanes resolve immediately; no variant
  // means lanes are present/absent at the array level (which would change
  // the destructure shape).
  const nullP = <T>(): Promise<T | null> => Promise.resolve(null);

  const [gitInfo, usage, today, context, metrics, blockInfo, tmuxSession] =
    await Promise.all([
      wants("git")
        ? deps.gitProvider
            .getGitInfo(
              cwd ?? hookData.workspace?.current_dir,
              {},
              hookData.workspace?.project_dir,
            )
            .catch(() => null)
        : nullP<GitInfo>(),
      wants("session.cost") || wants("session.tokens")
        ? deps.usageProvider
            .getUsageInfo(hookData.session_id, hookData)
            .catch(() => null)
        : nullP<Awaited<ReturnType<UsageProvider["getUsageInfo"]>>>(),
      wants("today")
        ? deps.todayProvider.getTodayInfo().catch(() => null)
        : nullP<Awaited<ReturnType<TodayProvider["getTodayInfo"]>>>(),
      wants("context")
        ? deps.contextProvider
            .getContextInfo(hookData, DEFAULT_AUTOCOMPACT_BUFFER)
            .catch(() => null)
        : nullP<Awaited<ReturnType<ContextProvider["getContextInfo"]>>>(),
      wants("metrics")
        ? deps.metricsProvider
            .getMetricsInfo(hookData.session_id, hookData)
            .catch(() => null)
        : nullP<Awaited<ReturnType<MetricsProvider["getMetricsInfo"]>>>(),
      wants("block")
        ? deps.blockProvider.getActiveBlockInfo(hookData).catch(() => null)
        : nullP<Awaited<ReturnType<BlockProvider["getActiveBlockInfo"]>>>(),
      wants("tmux")
        ? deps.tmuxService.getSessionId().catch(() => null)
        : nullP<string>(),
    ]);

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
  const home = process.env.HOME ?? process.env.USERPROFILE;

  // [LAW:types-are-the-program] Partial projections so absent provider data
  // travels as missing fields all the way to applyInput. Each provider's
  // null sub-fields become absent keys here; applyInput's fallback chain
  // fills in the declared DSL default and records a last_error per field.
  const sessionPayload: SessionPayload | undefined =
    usage === null
      ? undefined
      : pickNonNull({
          cost: usage.session.cost,
          tokens: usage.session.tokens,
        });
  const todayPayload: TodayPayload | undefined =
    today === null
      ? undefined
      : pickNonNull({ cost: today.cost, tokens: today.tokens });
  const metricsPayload: MetricsPayload | undefined =
    metrics === null
      ? undefined
      : pickNonNull({
          lastResponseTime: metrics.lastResponseTime,
          responseTime: metrics.responseTime,
          sessionDuration: metrics.sessionDuration,
          messageCount: metrics.messageCount,
          linesAdded: metrics.linesAdded,
          linesRemoved: metrics.linesRemoved,
        });

  return {
    ...hookData,
    ...(home !== undefined && { home }),
    ...(gitInfo !== null && { git: projectGitInfo(gitInfo) }),
    ...(tmuxSession !== null && { tmux: { session: tmuxSession } }),
    ...(theme !== undefined && { theme }),
    ...(sessionPayload !== undefined && { session: sessionPayload }),
    ...(todayPayload !== undefined && { today: todayPayload }),
    ...(blockInfo !== null && {
      block: {
        nativeUtilization: blockInfo.nativeUtilization,
        // [LAW:one-source-of-truth] Surface the raw `resets_at` epoch (not
        // pre-computed minutes) so DSL templates compose `minutesUntilReset
        // .block.resetsAt` — the same formatter the weekly segment uses.
        // Pre-computing here would split "minutes until reset" into two
        // paths (precomputed for block, template-computed for weekly), drift
        // bait.
        resetsAt: hookData.rate_limits?.five_hour?.resets_at ?? 0,
      },
    }),
    ...(hookData.rate_limits?.seven_day !== undefined && {
      weekly: {
        percentage: hookData.rate_limits.seven_day.used_percentage,
        resetsAt: hookData.rate_limits.seven_day.resets_at,
      },
    }),
    ...(context !== null && {
      context: {
        totalTokens: context.totalTokens,
        contextLeft: context.contextLeftPercentage,
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
  for (const k of Object.keys(src) as (keyof T)[]) {
    const v = src[k];
    if (v !== null && v !== undefined) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

// [LAW:types-are-the-program] Project the optional-rich GitInfo down to the
// flat shape the DSL input paths read. Every optional becomes a typed default
// at this boundary so the DSL never sees `undefined` for these fields —
// templates can `{{ if ne .git.repoName "" }}` without worrying about whether
// the path resolved.
function projectGitInfo(info: GitInfo): GitPayload {
  return {
    repoName: info.repoName ?? "",
    branch: info.branch,
    sha: info.sha ?? "",
    ahead: info.ahead,
    behind: info.behind,
    staged: info.staged ?? 0,
    unstaged: info.unstaged ?? 0,
    untracked: info.untracked ?? 0,
    conflicts: info.conflicts ?? 0,
    upstream: info.upstream ?? "",
    stash: info.stashCount ?? 0,
    status: info.status,
  };
}
