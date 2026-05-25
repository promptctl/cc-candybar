// [LAW:one-source-of-truth] The single deterministic input universe the parity
// proof renders against. Pinning theme/style/color-system/charset + a fixed
// clock makes every byte reproducible, so a golden captured today still
// describes "correct output" after the legacy classes are deleted (bzh.2).
//
// Nothing here touches real git, the filesystem, or the wall clock: each
// data object (GitInfo, UsageInfo, …) is constructed, and the only time-
// dependent segment (weekly) reads a clock the test pins to FIXED_NOW_MS.

import type { ClaudeHookData } from "../../src/utils/claude";
import type { GitInfo } from "../../src/segments/git";
import type { UsageInfo } from "../../src/segments/session";
import type { ContextInfo } from "../../src/segments/context";
import type { MetricsInfo } from "../../src/segments/metrics";
import type { BlockInfo } from "../../src/segments/block";
import type { TodayInfo } from "../../src/segments/today";
import type { ToolbarContext } from "../../src/segments/renderer";
import type { PowerlineColors } from "../../src/themes";
import type { PaletteResolver } from "@promptctl/rich-js";

import { PaletteResolver as PaletteResolverImpl } from "@promptctl/rich-js";
import { SegmentRenderer } from "../../src/segments";
import { buildPowerlineSymbols } from "../../src/segments/symbols";
import { resolveThemeColors } from "../../src/themes";
import { getThemePalette } from "../../src/themes/palette-registry";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import type { BuildLineOptions } from "../../src/render/strip";

// ─── Pinned render conditions ────────────────────────────────────────────────

export const THEME = "textual-dark";
export const STYLE = "surface";
export const CHARSET = "unicode" as const;
export const DISPLAY_STYLE = "powerline" as const;
export const COLOR_SUPPORT = "truecolor" as const;

// Real wall-clock value the weekly segment's "time until reset" is measured
// against. The parity test sets the system clock to this so the rendered
// duration is constant.
export const FIXED_NOW_MS = Date.parse("2026-05-21T12:00:00.000Z");

// Env var the `env` segment reads; the test sets/clears it around the run.
export const ENV_VAR = "CC_CANDYBAR_PARITY_ENV";
export const ENV_VALUE = "staging";

// rich-js strip options shared by both byte producers (legacy + DSL).
export const STRIP_OPTS: BuildLineOptions = {
  style: DISPLAY_STYLE,
  colorCompatibility: COLOR_SUPPORT,
};

// ─── Fixed input data ──────────────────────────────────────────────────────

export const SESSION_ID = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";

export const HOOK_DATA: ClaudeHookData = {
  hook_event_name: "Status",
  session_id: SESSION_ID,
  transcript_path: "/work/acme/.claude/transcript.jsonl",
  cwd: "/work/acme/src",
  model: { id: "claude-sonnet-4-6", display_name: "Sonnet 4.6" },
  workspace: {
    current_dir: "/work/acme/src",
    project_dir: "/work/acme",
    added_dirs: [],
  },
  version: "1.2.3",
  // resets_at is epoch *seconds* (see formatters.minutesUntilReset).
  rate_limits: {
    five_hour: {
      used_percentage: 55,
      resets_at: Math.floor(FIXED_NOW_MS / 1000) + 90 * 60,
    },
    seven_day: {
      used_percentage: 42,
      resets_at: Math.floor(FIXED_NOW_MS / 1000) + 180 * 60,
    },
  },
};

export const GIT_INFO: GitInfo = {
  branch: "main",
  status: "dirty",
  ahead: 2,
  behind: 1,
  sha: "abc1234",
  staged: 3,
  unstaged: 1,
  untracked: 2,
  conflicts: 0,
  stashCount: 1,
  upstream: "origin/main",
  repoName: "acme",
  isWorktree: false,
};

const TOKEN_BREAKDOWN = {
  input: 1000,
  output: 2000,
  cacheCreation: 3000,
  cacheRead: 4000,
};

// [LAW:types-are-the-program] Annotated with `satisfies T` (not `: T`) so the
// literal's narrow type is preserved. UsageInfo/TodayInfo/MetricsInfo all type
// their numeric value fields as `number | null` to model production paths where
// the data source is unavailable; the parity fixture instantiates them all as
// non-null. Without `satisfies`, consumers (the DSL bindings) see the wide
// nullable type and have to coalesce defensively (`?? 0`) just to satisfy
// TypeScript — exactly the [LAW:no-defensive-null-guards] pattern. Narrowing
// the fixture's static type to its actual shape eliminates the guard.
//
// Null-source configs (production: a session with no usage data, a metrics
// segment with no recorded responses) are a separate expressiveness concern:
// the DSL var-system can't represent null directly, so future fixtures will
// need presence-boolean gating or a `when` predicate. Tracked in
// brandon-segment-dsl-migration-bzh.8.
export const USAGE_INFO = {
  session: {
    cost: 1.2345,
    calculatedCost: 1.2,
    officialCost: 1.3,
    tokens: 123456,
    tokenBreakdown: TOKEN_BREAKDOWN,
  },
} satisfies UsageInfo;

export const CONTEXT_INFO = {
  totalTokens: 50000,
  percentage: 25,
  usablePercentage: 30,
  contextLeftPercentage: 70,
  maxTokens: 200000,
  usableTokens: 167000,
} satisfies ContextInfo;

export const METRICS_INFO = {
  responseTime: 12.3,
  lastResponseTime: 5.6,
  sessionDuration: 3600,
  messageCount: 42,
  linesAdded: 120,
  linesRemoved: 30,
} satisfies MetricsInfo;

export const BLOCK_INFO = {
  nativeUtilization: 55,
  timeRemaining: 90,
} satisfies BlockInfo;

export const TODAY_INFO = {
  cost: 4.56,
  tokens: 234567,
  tokenBreakdown: TOKEN_BREAKDOWN,
  date: "2026-05-21",
} satisfies TodayInfo;

export const TMUX_SESSION_ID = "main:1";

export const TOOLBAR_CTX: ToolbarContext = {
  sessionId: SESSION_ID,
  transcriptPath: HOOK_DATA.transcript_path,
  projectDir: HOOK_DATA.workspace.project_dir,
  currentDir: HOOK_DATA.workspace.current_dir,
  modelName: "Sonnet 4.6",
  modelShort: "S4.6",
  hookData: HOOK_DATA as unknown as Record<string, unknown>,
  currentTheme: THEME,
  currentStyle: STYLE,
};

// ─── Render-time singletons ──────────────────────────────────────────────────

export function makeRenderer(): SegmentRenderer {
  return new SegmentRenderer(
    DEFAULT_CONFIG,
    buildPowerlineSymbols(CHARSET, DISPLAY_STYLE),
  );
}

export function makeColors(): PowerlineColors {
  return resolveThemeColors({
    theme: THEME,
    style: STYLE,
    colorSupport: COLOR_SUPPORT,
  });
}

export function makeResolver(): PaletteResolver {
  const palette = getThemePalette(THEME);
  if (!palette) throw new Error(`parity fixture: unknown theme "${THEME}"`);
  return new PaletteResolverImpl(palette);
}
