// [LAW:one-source-of-truth] The canonical migration state for every built-in
// segment. bzh.2 (deletion) reads `status` here rather than re-deciding which
// segments are safe to remove; bzh.1 / vhi.3 flip entries to "dsl-parity" and
// attach a `dsl` binding as they migrate. The parity test asserts these keys
// cover exactly VALID_SEGMENT_NAMES, so a new segment cannot be added to the
// product without appearing in the proof.
//
// [LAW:dataflow-not-control-flow] Each entry is data — a status value plus a
// render closure — and the test loop is uniform. The status *value* selects
// which assertion runs; there is no per-segment branching in the harness.

import type { SegmentName } from "../../src/config/loader";
import type { LegacyRender, DslBinding } from "./harness";
import { DSL_BINDINGS } from "./dsl-segments";
import {
  HOOK_DATA,
  GIT_INFO,
  USAGE_INFO,
  CONTEXT_INFO,
  METRICS_INFO,
  BLOCK_INFO,
  TODAY_INFO,
  SESSION_ID,
  TMUX_SESSION_ID,
  TOOLBAR_CTX,
  ENV_VAR,
} from "./fixtures";

export type ParityStatus = "legacy-only" | "dsl-pending" | "dsl-parity";

export interface SegmentParityEntry {
  // Where this segment sits in the migration. bzh.3 ships every segment at
  // "legacy-only"; the byte-differ is exercised by the harness self-test.
  status: ParityStatus;
  // Produces the legacy SegmentData for this segment from the fixed fixture.
  legacy: LegacyRender;
  // The DSL counterpart. Attached once a segment reaches "dsl-pending" (a
  // declaration exists but is not yet byte-parity); the test asserts it is
  // byte-identical to golden only at "dsl-parity".
  dsl?: DslBinding;
  // [LAW:no-silent-fallbacks] Set when the legacy renderer cannot produce the
  // same bytes the DSL pipeline produces — e.g. gitTaculous embeds raw inline
  // ANSI escapes that rich-js's structured serializer can't reproduce
  // verbatim. The committed golden tracks the DSL (canonical post-migration);
  // the legacy renderer is kept for runtime backward-compat until bzh.2 deletes
  // it, but is no longer asserted against golden. Surfacing the divergence as
  // a typed flag (rather than skipping silently) keeps the gap visible.
  legacyDivergedFromDsl?: boolean;
}

// [LAW:types-are-the-program] Keyed on SegmentName, so a missing or extra
// segment is a compile error — the exhaustiveness the runtime completeness test
// asserts is now also proven by the type. (A plain annotation, not `satisfies`,
// because consumers need the wide SegmentParityEntry element type — `.status`
// and `.dsl` — not the narrowed all-"legacy-only" literal.)
export const PARITY_REGISTRY: Record<SegmentName, SegmentParityEntry> = {
  directory: {
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderDirectory(HOOK_DATA, c, { enabled: true, style: "full" }),
    dsl: DSL_BINDINGS.directory,
  },
  git: {
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderGit(GIT_INFO, c, {
        enabled: true,
        showSha: true,
        showWorkingTree: true,
        showUpstream: true,
        showStashCount: true,
        showRepoName: true,
      }),
    dsl: DSL_BINDINGS.git,
  },
  gitTaculous: {
    // [LAW:one-source-of-truth] Migrated in bzh.6 to the per-fragment-fg
    // pipeline (see src/template-engine/cells.ts's `baseStyle` parameter).
    // The committed golden for this segment is POST-migration bytes — the
    // legacy renderer embeds raw inline ANSI escapes (`\x1b[32m...\x1b[<fg>m`)
    // which the structured rich-js serializer cannot reproduce verbatim
    // (always emits `\x1b[0m` close + reopen between SGR-codes groups).
    // Visual output is identical; byte stream is the DSL pipeline's natural
    // form. Decision recorded in dsl-segments.ts's gitTaculous binding.
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderGitTaculous(GIT_INFO, c, {
        enabled: true,
        showSha: true,
        showWorkingTree: true,
        showUpstream: true,
        showRepoName: true,
      }),
    dsl: DSL_BINDINGS.gitTaculous,
    legacyDivergedFromDsl: true,
  },
  model: {
    // [LAW:one-source-of-truth] bzh.5 landed formatterFuncs.formatModelName,
    // wrapping src/utils/formatters.ts. The DSL declaration now runs the same
    // regex normalization legacy renderModel runs, so byte-parity holds for
    // raw IDs ("claude-sonnet-4-6") AND decorated names ("Opus 4.7 (1M
    // context)") — not just friendly names. Safe to delete renderModel when
    // bzh.2 fires.
    status: "dsl-parity",
    legacy: (r, c) => r.renderModel(HOOK_DATA, c, { enabled: true }),
    dsl: DSL_BINDINGS.model,
  },
  session: {
    // bzh.5: unblocked by formatterFuncs.formatCost + formatTokens.
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderSession(USAGE_INFO, c, { enabled: true, type: "both" }),
    dsl: DSL_BINDINGS.session,
  },
  block: {
    // bzh.5: unblocked by formatterFuncs.round + formatLongTimeRemaining
    // + threshold-cascade bg/fg templates.
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderBlock(BLOCK_INFO, c, {
        enabled: true,
        type: "both",
        displayStyle: "text",
      }),
    dsl: DSL_BINDINGS.block,
  },
  today: {
    // bzh.5: unblocked by formatterFuncs.formatCost + formatTokens
    // + budgetStatus (DEFAULT_CONFIG sets today.budget.amount=50).
    status: "dsl-parity",
    legacy: (r, c) => r.renderToday(TODAY_INFO, c, "both"),
    dsl: DSL_BINDINGS.today,
  },
  tmux: {
    status: "dsl-parity",
    legacy: (r, c) => r.renderTmux(TMUX_SESSION_ID, c),
    dsl: DSL_BINDINGS.tmux,
  },
  context: {
    // bzh.5: unblocked by formatterFuncs.formatInteger (locale-grouped
    // "50,000") + threshold-cascade bg/fg templates (inverted: low "left"
    // is critical, high is normal).
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderContext(CONTEXT_INFO, c, { enabled: true, displayStyle: "text" }),
    dsl: DSL_BINDINGS.context,
  },
  metrics: {
    // bzh.5: unblocked by formatterFuncs.formatResponseTime + formatDuration.
    // Static template for the all-parts-enabled fixture; per-part conditional
    // gating is a followup if a config disables individual metrics.
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderMetrics(METRICS_INFO, c, {
        enabled: true,
        showResponseTime: true,
        showLastResponseTime: true,
        showDuration: true,
        showMessageCount: true,
        showLinesAdded: true,
        showLinesRemoved: true,
      }),
    dsl: DSL_BINDINGS.metrics,
  },
  version: {
    status: "dsl-parity",
    legacy: (r, c) => r.renderVersion(HOOK_DATA, c, { enabled: true }),
    dsl: DSL_BINDINGS.version,
  },
  sessionId: {
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderSessionId(
        SESSION_ID,
        c,
        { enabled: true, showIdLabel: true, length: 8 },
        {
          transcriptPath: HOOK_DATA.transcript_path,
          projectDir: HOOK_DATA.workspace.project_dir,
        },
      ),
    dsl: DSL_BINDINGS.sessionId,
  },
  env: {
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderEnv(c, { enabled: true, variable: ENV_VAR, prefix: "ENV" }),
    dsl: DSL_BINDINGS.env,
  },
  weekly: {
    // bzh.5: unblocked by formatterFuncs.round + formatLongTimeRemaining
    // + minutesUntilReset (epoch-seconds → minutes math the legacy chains)
    // + threshold-cascade bg/fg templates (same as block).
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderWeekly(HOOK_DATA, c, { enabled: true, displayStyle: "text" }),
    dsl: DSL_BINDINGS.weekly,
  },
  toolbar: {
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderToolbar(
        {
          enabled: true,
          separator: " ",
          items: [
            { text: "\u{1F4C2}", verb: "open-vscode", expr: "cwd" },
            { text: "⎘", verb: "copy", expr: "session.id:8" },
          ],
        },
        c,
        TOOLBAR_CTX,
      ),
    dsl: DSL_BINDINGS.toolbar,
  },
  tray: {
    status: "dsl-parity",
    legacy: (r, c) =>
      r.renderTray(
        {
          enabled: true,
          separator: " ",
          items: [
            { text: "\u{1F514}", verb: "open-url", expr: "theme" },
            { text: "⚙", verb: "copy", expr: "session.id:8" },
          ],
        },
        c,
        TOOLBAR_CTX,
      ),
    dsl: DSL_BINDINGS.tray,
  },
};
