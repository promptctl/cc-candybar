import type { PowerlineConfig } from "./loader";

// [LAW:types-are-the-program] `satisfies` (not an annotation): the literal's
// narrow type is preserved so consumers reading DEFAULT_CONFIG see the keys
// that are actually present (e.g. DEFAULT_CONFIG.budget.today.amount is
// `number`, not `number | undefined`). PowerlineConfig optionality reflects
// what *user configs* may omit; DEFAULT_CONFIG itself omits nothing, so the
// type should not pretend it does. Eliminates `!` non-null laundering at
// every callsite that reads canonical default values (e.g. the parity
// fixture for today's budget knobs).
export const DEFAULT_CONFIG = {
  // [LAW:dataflow-not-control-flow] "random" is a value, not a special case;
  // resolveSession{Theme,Style,DisplayStyle} expand it per-session at render
  // and cache the pick in SessionState so it's stable for that session.
  theme: "random",
  style: "random",
  display: {
    style: "random",
    charset: "unicode",
    colorCompatibility: "auto",
    autoWrap: true,
    padding: 1,
    lines: [
      {
        segments: {
          directory: {
            enabled: true,
            style: "basename",
          },
          git: {
            enabled: true,
            showSha: false,
            showWorkingTree: false,
            showOperation: false,
            showTag: false,
            showTimeSinceCommit: false,
            showStashCount: false,
            showUpstream: false,
            showRepoName: false,
          },
          gitTaculous: {
            enabled: false,
            showSha: true,
            showWorkingTree: true,
            showUpstream: true,
            showStashCount: true,
            showOperation: true,
            showTimeSinceCommit: false,
            showTag: false,
            showRepoName: false,
          },
          model: { enabled: true },
          session: { enabled: true, type: "tokens", costSource: "calculated" },
          today: { enabled: true, type: "cost" },
          block: {
            enabled: false,
            type: "cost",
            burnType: "cost",
            displayStyle: "text",
          },
          weekly: { enabled: false, displayStyle: "text" },
          version: { enabled: false },
          tmux: { enabled: false },
          sessionId: { enabled: false, showIdLabel: true },
          toolbar: { enabled: false, items: [] },
          tray: { enabled: false, items: [] },
          context: {
            enabled: true,
            showPercentageOnly: false,
            displayStyle: "text",
            autocompactBuffer: 33000,
          },
          metrics: {
            enabled: false,
            showResponseTime: true,
            showLastResponseTime: true,
            showDuration: true,
            showMessageCount: true,
            showLinesAdded: true,
            showLinesRemoved: true,
          },
        },
      },
    ],
  },
  budget: {
    session: {
      warningThreshold: 80,
    },
    today: {
      warningThreshold: 80,
      amount: 50,
    },
    block: {
      warningThreshold: 80,
      amount: 15,
    },
  },
  modelContextLimits: {
    default: 200000,
    sonnet: 200000,
    opus: 200000,
  },
} satisfies PowerlineConfig;
