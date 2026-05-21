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
  // The DSL counterpart — present (and asserted byte-identical) only once a
  // segment reaches "dsl-pending"/"dsl-parity".
  dsl?: DslBinding;
}

// [LAW:types-are-the-program] Keyed on SegmentName, so a missing or extra
// segment is a compile error — the exhaustiveness the runtime completeness test
// asserts is now also proven by the type. (A plain annotation, not `satisfies`,
// because consumers need the wide SegmentParityEntry element type — `.status`
// and `.dsl` — not the narrowed all-"legacy-only" literal.)
export const PARITY_REGISTRY: Record<SegmentName, SegmentParityEntry> = {
  directory: {
    status: "legacy-only",
    legacy: (r, c) =>
      r.renderDirectory(HOOK_DATA, c, { enabled: true, style: "full" }),
  },
  git: {
    status: "legacy-only",
    legacy: (r, c) =>
      r.renderGit(GIT_INFO, c, {
        enabled: true,
        showSha: true,
        showWorkingTree: true,
        showUpstream: true,
        showStashCount: true,
        showRepoName: true,
      }),
  },
  gitTaculous: {
    status: "legacy-only",
    legacy: (r, c) =>
      r.renderGitTaculous(GIT_INFO, c, {
        enabled: true,
        showSha: true,
        showWorkingTree: true,
        showUpstream: true,
        showRepoName: true,
      }),
  },
  model: {
    status: "legacy-only",
    legacy: (r, c) => r.renderModel(HOOK_DATA, c, { enabled: true }),
  },
  session: {
    status: "legacy-only",
    legacy: (r, c) =>
      r.renderSession(USAGE_INFO, c, { enabled: true, type: "both" }),
  },
  block: {
    status: "legacy-only",
    legacy: (r, c) =>
      r.renderBlock(BLOCK_INFO, c, {
        enabled: true,
        type: "both",
        displayStyle: "text",
      }),
  },
  today: {
    status: "legacy-only",
    legacy: (r, c) => r.renderToday(TODAY_INFO, c, "both"),
  },
  tmux: {
    status: "legacy-only",
    legacy: (r, c) => r.renderTmux(TMUX_SESSION_ID, c),
  },
  context: {
    status: "legacy-only",
    legacy: (r, c) =>
      r.renderContext(CONTEXT_INFO, c, { enabled: true, displayStyle: "text" }),
  },
  metrics: {
    status: "legacy-only",
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
  },
  version: {
    status: "legacy-only",
    legacy: (r, c) => r.renderVersion(HOOK_DATA, c, { enabled: true }),
  },
  sessionId: {
    status: "legacy-only",
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
  },
  env: {
    status: "legacy-only",
    legacy: (r, c) =>
      r.renderEnv(c, { enabled: true, variable: ENV_VAR, prefix: "ENV" }),
  },
  weekly: {
    status: "legacy-only",
    legacy: (r, c) =>
      r.renderWeekly(HOOK_DATA, c, { enabled: true, displayStyle: "text" }),
  },
  toolbar: {
    status: "legacy-only",
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
  },
  tray: {
    status: "legacy-only",
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
  },
};
