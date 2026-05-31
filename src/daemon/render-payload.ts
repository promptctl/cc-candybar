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
import { extractTemplateRefs } from "../config/dsl-loader.js";
import type { GitInfo } from "../segments/git.js";
import { cacheExpiresAt } from "../segments/cache.js";
import type { SessionUsageStore } from "./cache/session-usage-store.js";
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
  readonly block?: BlockPayload;
  readonly weekly?: WeeklyPayload;
  readonly cache?: CachePayload;
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
  readonly operation: string;
  readonly timeSinceCommit: number;
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
// the active layout. Walk from `config.layout` → segments → their template
// strings → referenced variable names → recursive expansion through
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

  for (const row of config.layout) {
    // A row's `when` references variables too — seed them so a provider feeding
    // only a row predicate (e.g. a state var gating the row) isn't gated out.
    if (row.when)
      for (const ref of extractTemplateRefs(row.when)) frontier.push(ref);
    for (const segName of row.segments) {
      const seg = config.segments[segName];
      if (!seg) continue;
      for (const src of [seg.template, seg.when, seg.bg, seg.fg]) {
        if (src) for (const ref of extractTemplateRefs(src)) frontier.push(ref);
      }
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
function gitOptionsFromClosure(needed: ReadonlySet<string>): {
  showSha?: boolean;
  showWorkingTree?: boolean;
  showStashCount?: boolean;
  showUpstream?: boolean;
  showRepoName?: boolean;
} {
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
  };
}

/**
 * Compose every render-time data source into the augmented payload that the
 * DSL applies to its input variables.
 *
 * Each provider runs only if its payload prefix sits in the closure
 * computed by `buildNeededPrefixes(config)` — the set of `kind: "input"`
 * paths transitively reachable from a segment in `config.layout`. Merely
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
  // [LAW:single-enforcer] The cache pre-computes the closure once at
  // registration; passing it in (rather than recomputing per render) keeps
  // the hot path free of the BFS + extractTemplateRefs cost.
  neededInputPaths: ReadonlySet<string>,
): Promise<RenderPayload> {
  const wants = (prefix: string): boolean =>
    anyPathStartsWith(neededInputPaths, prefix);

  // [LAW:dataflow-not-control-flow] Each provider lane is the same shape:
  // either "needed → call provider with .catch(() => null)" or "not needed
  // → resolve(null)". The skipped lanes resolve immediately; no variant
  // means lanes are present/absent at the array level (which would change
  // the destructure shape).
  const nullP = <T>(): Promise<T | null> => Promise.resolve(null);

  const [gitInfo, usage, today, context, metrics, tmuxSession] =
    await Promise.all([
      wants("git")
        ? deps.gitProvider
            .getGitInfo(
              cwd ?? hookData.workspace?.current_dir,
              gitOptionsFromClosure(neededInputPaths),
              hookData.workspace?.project_dir,
            )
            .catch(() => null)
        : nullP<GitInfo>(),
      wants("session.cost") || wants("session.tokens")
        ? deps.usageStore
            .getUsageInfo(hookData.session_id, hookData)
            .catch(() => null)
        : nullP<Awaited<ReturnType<SessionUsageStore["getUsageInfo"]>>>(),
      wants("today")
        ? deps.usageStore.getTodayInfo(hookData).catch(() => null)
        : nullP<Awaited<ReturnType<SessionUsageStore["getTodayInfo"]>>>(),
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
      wants("tmux")
        ? deps.tmuxService.getSessionId().catch(() => null)
        : nullP<string>(),
    ]);
  // [LAW:dataflow-not-control-flow] block.* reads straight from hookData
  // alongside weekly. (The prior dedicated provider only re-derived
  // `minutesUntilReset(resets_at)`, which the DSL template composes via
  // the formatter func — a duplicate code path was retired.)
  const fiveHour = hookData.rate_limits?.five_hour;

  // Prompt-cache expiry. A synchronous bounded tail-read, gated to layouts
  // that actually declare a cache.* input — unused layouts pay nothing. Not
  // folded into the Promise.all above because it does no async I/O; the read
  // is a few KB from the transcript tail.
  const cacheExpiry = wants("cache")
    ? cacheExpiresAt(hookData.transcript_path)
    : null;

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
    ...(workspace !== undefined && { workspace }),
    ...(home !== undefined && { home }),
    ...(gitInfo !== null && { git: projectGitInfo(gitInfo) }),
    ...(tmuxSession !== null && { tmux: { session: tmuxSession } }),
    ...(theme !== undefined && { theme }),
    ...(sessionPayload !== undefined && { session: sessionPayload }),
    ...(todayPayload !== undefined && { today: todayPayload }),
    ...(wants("block") &&
      fiveHour !== undefined && {
        block: {
          // [LAW:one-source-of-truth] Both fields read straight from the
          // hookData rate-limit window; the DSL composes minutesUntilReset
          // against .block.resetsAt the same way weekly does. One
          // projection rule, two segments.
          nativeUtilization: fiveHour.used_percentage,
          resetsAt: fiveHour.resets_at,
        },
      }),
    ...(hookData.rate_limits?.seven_day !== undefined && {
      weekly: {
        percentage: hookData.rate_limits.seven_day.used_percentage,
        resetsAt: hookData.rate_limits.seven_day.resets_at,
      },
    }),
    ...(cacheExpiry !== null && { cache: { expiresAt: cacheExpiry } }),
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
    operation: info.operation ?? "",
    timeSinceCommit: info.timeSinceCommit ?? 0,
  };
}
