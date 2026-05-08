import type { ClaudeHookData } from "./utils/claude";
import type { PowerlineColors } from "./themes";
import type { PowerlineConfig, LineConfig } from "./config/loader";
import type {
  UsageInfo,
  ContextInfo,
  MetricsInfo,
  PowerlineSymbols,
  AnySegmentConfig,
  DirectorySegmentConfig,
  ModelSegmentConfig,
  GitSegmentConfig,
  UsageSegmentConfig,
  ContextSegmentConfig,
  MetricsSegmentConfig,
  BlockSegmentConfig,
  TodaySegmentConfig,
  VersionSegmentConfig,
  SessionIdSegmentConfig,
  EnvSegmentConfig,
  WeeklySegmentConfig,
  ToolbarSegmentConfig,
  TraySegmentConfig,
} from "./segments";
import type { SessionStateRW } from "./daemon/session-state";
import {
  resolveSessionTheme,
  resolveSessionStyle,
  resolveSessionDisplayStyle,
} from "./themes/session-random";
import { formatModelName, shortenModelName } from "./utils/formatters";
import type { BlockInfo } from "./segments/block";
import type { TodayInfo } from "./segments/today";

import { resolveThemeColors } from "./themes";
import {
  buildLineStrip,
  buildFlexStripLines,
  type StripStyle,
} from "./render/strip";
import { getColorSupport } from "./utils/color-support";
import { hexToAnsi } from "./utils/colors";
import type { SegmentOverride } from "./themes/cascade.js";
import {
  UsageProvider,
  ContextProvider,
  GitService,
  TmuxService,
  MetricsProvider,
  SegmentRenderer,
} from "./segments";
import {
  wrapOsc8,
  resolveToolbarExpr,
  interpolateToolbarText,
  type ToolbarContext,
} from "./segments/renderer";
import { BlockProvider } from "./segments/block";
import { TodayProvider } from "./segments/today";
import { SYMBOLS, TEXT_SYMBOLS } from "./utils/constants";
import { getTerminalWidth } from "./utils/terminal-width";
import { openSync, readSync, closeSync, statSync } from "node:fs";

const CACHE_TTL_MS = 60 * 60 * 1000; // Anthropic prompt cache: 1h
const CACHE_RED_HEX = "#ef4444";
const CACHE_YELLOW_HEX = "#eab308";
const TAIL_CHUNK = 64 * 1024;
const TAIL_MAX = 1 * 1024 * 1024;

function computeCacheWarmth(
  transcriptPath: string,
  restoreAnsi: string,
): string | null {
  const lastCacheTs = findLastCacheActivityTs(transcriptPath);
  if (lastCacheTs == null) return null;
  const ageMs = Date.now() - lastCacheTs;
  if (ageMs >= CACHE_TTL_MS)
    return colorize("◴ cold", CACHE_RED_HEX, restoreAnsi);
  const remainMin = Math.ceil((CACHE_TTL_MS - ageMs) / 60000);
  const text = `◴ ${remainMin}m`;
  if (remainMin <= 8) return colorize(text, CACHE_RED_HEX, restoreAnsi);
  if (remainMin <= 20) return colorize(text, CACHE_YELLOW_HEX, restoreAnsi);
  return text;
}

// Tail-read JSONL transcript and return the timestamp of the last entry
// with cache_read_input_tokens > 0 or cache_creation_input_tokens > 0.
function findLastCacheActivityTs(transcriptPath: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const size = statSync(transcriptPath).size;
    let tailStart = Math.max(0, size - TAIL_CHUNK);
    let buf = Buffer.alloc(0);

    while (true) {
      const chunkLen = size - tailStart;
      const chunk = Buffer.alloc(chunkLen);
      readSync(fd, chunk, 0, chunkLen, tailStart);
      buf = chunk;

      const ts = scanBufferForLastCacheTs(buf, tailStart === 0);
      if (ts != null) return ts;
      if (tailStart === 0) return null;

      const grown = Math.min(buf.length * 2, TAIL_MAX);
      tailStart = Math.max(0, size - grown);
      if (size - tailStart === buf.length) return null;
    }
  } catch {
    return null;
  } finally {
    if (fd != null)
      try {
        closeSync(fd);
      } catch {}
  }
}

const CACHE_HIT_RE =
  /"(?:cache_read_input_tokens|cache_creation_input_tokens)":[1-9]/;
const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;

function scanBufferForLastCacheTs(
  buf: Buffer,
  bufStartsAtFileBeginning: boolean,
): number | null {
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  // Drop first line if our window doesn't start at file beginning —
  // it's likely a partial line.
  const start = bufStartsAtFileBeginning ? 0 : 1;
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i];
    if (!line || !CACHE_HIT_RE.test(line)) continue;
    const m = TIMESTAMP_RE.exec(line);
    if (!m) continue;
    const ms = Date.parse(m[1]!);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function colorize(text: string, hex: string, restoreAnsi: string): string {
  return `${hexToAnsi(hex, false)}${text}${restoreAnsi}`;
}

interface RenderedSegment {
  type: string;
  text: string;
  bgColor: string;
  fgColor: string;
  bgHex?: string;
  fgHex?: string;
}

// [LAW:dataflow-not-control-flow] Per-render context. Resolved once at the top
// of generateStatusline, threaded through every render method. Holds every
// per-session value derived from sessionId — symbols, segment renderer,
// theme colors, the resolved display style — so downstream methods see the
// same uniform shape whether sessionA picked dracula+capsule or sessionB
// picked nord+powerline.
interface RenderCtx {
  sessionId: string;
  theme: string;
  style: string;
  displayStyle: "minimal" | "powerline" | "capsule";
  symbols: PowerlineSymbols;
  segmentRenderer: SegmentRenderer;
  colors: PowerlineColors;
}

export class PowerlineRenderer {
  private _usageProvider?: UsageProvider;
  private _blockProvider?: BlockProvider;
  private _todayProvider?: TodayProvider;
  private _contextProvider?: ContextProvider;
  private _gitService?: GitService;
  private _tmuxService?: TmuxService;
  private _metricsProvider?: MetricsProvider;
  // [LAW:one-source-of-truth] (symbols, segmentRenderer) are derived from
  // (displayStyle, charset). Cache by displayStyle so concurrent sessions
  // with different per-session displayStyle don't trample each other and
  // we don't rebuild a SegmentRenderer per render. At most 3 entries.
  private readonly _byDisplayStyle = new Map<
    string,
    { symbols: PowerlineSymbols; segmentRenderer: SegmentRenderer }
  >();
  private _sessionState?: SessionStateRW;

  constructor(
    private readonly config: PowerlineConfig,
    deps?: {
      gitService?: GitService;
      usageProvider?: UsageProvider;
      sessionState?: SessionStateRW;
    },
  ) {
    // [LAW:locality-or-seam] dependency injection lets the daemon swap in
    // cached service implementations without the renderer knowing.
    if (deps?.gitService) this._gitService = deps.gitService;
    if (deps?.usageProvider) this._usageProvider = deps.usageProvider;
    if (deps?.sessionState) this._sessionState = deps.sessionState;
  }

  private get usageProvider(): UsageProvider {
    if (!this._usageProvider) {
      this._usageProvider = new UsageProvider();
    }
    return this._usageProvider;
  }

  private get blockProvider(): BlockProvider {
    if (!this._blockProvider) {
      this._blockProvider = new BlockProvider();
    }
    return this._blockProvider;
  }

  private get todayProvider(): TodayProvider {
    if (!this._todayProvider) {
      this._todayProvider = new TodayProvider();
    }
    return this._todayProvider;
  }

  private get contextProvider(): ContextProvider {
    if (!this._contextProvider) {
      this._contextProvider = new ContextProvider(this.config);
    }
    return this._contextProvider;
  }

  private get gitService(): GitService {
    if (!this._gitService) {
      this._gitService = new GitService();
    }
    return this._gitService;
  }

  private get tmuxService(): TmuxService {
    if (!this._tmuxService) {
      this._tmuxService = new TmuxService();
    }
    return this._tmuxService;
  }

  private get metricsProvider(): MetricsProvider {
    if (!this._metricsProvider) {
      this._metricsProvider = new MetricsProvider();
    }
    return this._metricsProvider;
  }

  private getRenderTriple(displayStyle: "minimal" | "powerline" | "capsule"): {
    symbols: PowerlineSymbols;
    segmentRenderer: SegmentRenderer;
  } {
    let cached = this._byDisplayStyle.get(displayStyle);
    if (!cached) {
      const symbols = this.initializeSymbols(displayStyle);
      const segmentRenderer = new SegmentRenderer(
        this.config,
        symbols,
        this._sessionState,
      );
      cached = { symbols, segmentRenderer };
      this._byDisplayStyle.set(displayStyle, cached);
    }
    return cached;
  }

  private buildCtx(hookData: ClaudeHookData): RenderCtx {
    const sessionId = hookData.session_id ?? "";
    const theme = resolveSessionTheme(
      sessionId,
      this.config.theme,
      this._sessionState,
    );
    const style = resolveSessionStyle(
      sessionId,
      this.config.style,
      this._sessionState,
    );
    const displayStyle = resolveSessionDisplayStyle(
      sessionId,
      this.config.display.style,
      this._sessionState,
    );
    const { symbols, segmentRenderer } = this.getRenderTriple(displayStyle);
    const colors = this.computeThemeColors(theme, style);
    return {
      sessionId,
      theme,
      style,
      displayStyle,
      symbols,
      segmentRenderer,
      colors,
    };
  }

  private needsSegmentInfo(segmentType: keyof LineConfig["segments"]): boolean {
    return this.config.display.lines.some(
      (line) => line.segments[segmentType]?.enabled,
    );
  }

  async generateStatusline(hookData: ClaudeHookData): Promise<string> {
    const ctx = this.buildCtx(hookData);

    const usageInfo = this.needsSegmentInfo("session")
      ? await this.usageProvider.getUsageInfo(hookData.session_id, hookData)
      : null;

    const blockInfo = this.needsSegmentInfo("block")
      ? await this.blockProvider.getActiveBlockInfo(hookData)
      : null;

    const todayInfo = this.needsSegmentInfo("today")
      ? await this.todayProvider.getTodayInfo()
      : null;

    const contextSegmentConfig = this.config.display.lines
      .map((line) => line.segments.context)
      .find((c) => c?.enabled) as ContextSegmentConfig | undefined;
    const autocompactBuffer = contextSegmentConfig?.autocompactBuffer ?? 33000;
    const contextInfo = this.needsSegmentInfo("context")
      ? await this.contextProvider.getContextInfo(hookData, autocompactBuffer)
      : null;

    const metricsInfo = this.needsSegmentInfo("metrics")
      ? await this.metricsProvider.getMetricsInfo(hookData.session_id, hookData)
      : null;

    if (this.config.display.autoWrap) {
      const output = await this.generateAutoWrapStatusline(
        hookData,
        usageInfo,
        blockInfo,
        todayInfo,
        contextInfo,
        metricsInfo,
        ctx,
      );
      return this.maybeAppendPanelLine(output, hookData, ctx);
    }

    const lines = await Promise.all(
      this.config.display.lines.map((lineConfig) =>
        this.renderLine(
          lineConfig,
          hookData,
          usageInfo,
          blockInfo,
          todayInfo,
          contextInfo,
          metricsInfo,
          ctx,
        ),
      ),
    );

    const output = lines.filter((line) => line.length > 0).join("\n");
    return this.maybeAppendPanelLine(output, hookData, ctx);
  }

  private async generateAutoWrapStatusline(
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    ctx: RenderCtx,
  ): Promise<string> {
    const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";
    const terminalWidth = getTerminalWidth();

    const outputLines: string[] = [];

    for (const lineConfig of this.config.display.lines) {
      const segments = Object.entries(lineConfig.segments)
        .filter(
          ([_, config]: [string, AnySegmentConfig | undefined]) =>
            config?.enabled,
        )
        .map(([type, config]: [string, AnySegmentConfig]) => ({
          type,
          config,
        }));

      const renderedSegments: RenderedSegment[] = [];
      for (const segment of segments) {
        const segmentData = await this.renderSegment(
          segment,
          hookData,
          usageInfo,
          blockInfo,
          todayInfo,
          contextInfo,
          metricsInfo,
          ctx,
          currentDir,
        );

        if (segmentData) {
          renderedSegments.push({
            type: segment.type,
            text: segmentData.text,
            bgColor: segmentData.bgColor,
            fgColor: segmentData.fgColor,
            bgHex: segmentData.bgHex,
            fgHex: segmentData.fgHex,
          });
        }
      }

      if (renderedSegments.length === 0) continue;

      // [LAW:dataflow-not-control-flow] Wrap is one FlexStrip construction;
      // no terminal width → render single line via FlexStrip with effectively
      // unbounded width. The same code path runs every render — only the
      // width value varies.
      const effectiveWidth =
        terminalWidth && terminalWidth > 0
          ? terminalWidth
          : Number.MAX_SAFE_INTEGER;
      outputLines.push(
        this.buildFlexLineFromSegments(
          renderedSegments,
          effectiveWidth,
          ctx.displayStyle,
        ),
      );
    }

    return outputLines.join("\n");
  }

  // [LAW:single-enforcer] One place resolves displayStyle → StripStyle and
  // config.display.colorCompatibility → rich-js color spec. displayStyle is
  // a per-session value (resolved upstream), not the raw config field.
  private resolveStripOptions(
    displayStyle: "minimal" | "powerline" | "capsule",
  ): {
    style: StripStyle;
    colorCompatibility: "truecolor" | "256" | "ansi" | "none";
  } {
    const stripStyle: StripStyle =
      displayStyle === "capsule"
        ? "capsule"
        : displayStyle === "minimal"
          ? "plain"
          : "powerline";
    // [LAW:single-enforcer] Use powerline's getColorSupport() as the single
    // authority for "auto" resolution — preserves existing detection (which
    // emits ANSI even in non-TTY contexts like CI / Jest) instead of letting
    // rich-js's stricter detector silently drop color.
    const compat = this.config.display.colorCompatibility ?? "auto";
    const resolved = compat === "auto" ? getColorSupport() : compat;
    const richCompat =
      resolved === "ansi256" ? "256" : resolved === "none" ? "none" : resolved;
    return { style: stripStyle, colorCompatibility: richCompat };
  }

  private buildLineFromSegments(
    segments: RenderedSegment[],
    displayStyle: "minimal" | "powerline" | "capsule",
  ): string {
    return buildLineStrip(segments, this.resolveStripOptions(displayStyle));
  }

  private buildFlexLineFromSegments(
    segments: RenderedSegment[],
    width: number,
    displayStyle: "minimal" | "powerline" | "capsule",
  ): string {
    return buildFlexStripLines(segments, {
      ...this.resolveStripOptions(displayStyle),
      width,
    });
  }

  private async renderLine(
    lineConfig: LineConfig,
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    ctx: RenderCtx,
  ): Promise<string> {
    const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";

    const segments = Object.entries(lineConfig.segments)
      .filter(
        ([_, config]: [string, AnySegmentConfig | undefined]) =>
          config?.enabled,
      )
      .map(([type, config]: [string, AnySegmentConfig]) => ({ type, config }));

    const renderedSegments: RenderedSegment[] = [];
    for (const segment of segments) {
      const segmentData = await this.renderSegment(
        segment,
        hookData,
        usageInfo,
        blockInfo,
        todayInfo,
        contextInfo,
        metricsInfo,
        ctx,
        currentDir,
      );

      if (segmentData) {
        renderedSegments.push({
          type: segment.type,
          text: segmentData.text,
          bgColor: segmentData.bgColor,
          fgColor: segmentData.fgColor,
          bgHex: segmentData.bgHex,
          fgHex: segmentData.fgHex,
        });
      }
    }

    return this.buildLineFromSegments(renderedSegments, ctx.displayStyle);
  }

  private async renderSegment(
    segment: { type: string; config: AnySegmentConfig },
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    ctx: RenderCtx,
    currentDir: string,
  ) {
    const colors = ctx.colors;
    if (segment.type === "directory") {
      return ctx.segmentRenderer.renderDirectory(
        hookData,
        colors,
        segment.config as DirectorySegmentConfig,
      );
    }
    if (segment.type === "model") {
      return ctx.segmentRenderer.renderModel(
        hookData,
        colors,
        segment.config as ModelSegmentConfig,
      );
    }

    if (segment.type === "git") {
      return await this.renderGitSegment(
        segment.config as GitSegmentConfig,
        hookData,
        colors,
        currentDir,
        ctx,
      );
    }

    if (segment.type === "gitTaculous") {
      return await this.renderGitTaculousSegment(
        segment.config as GitSegmentConfig,
        hookData,
        colors,
        currentDir,
        ctx,
      );
    }

    if (segment.type === "session") {
      return this.renderSessionSegment(
        segment.config as UsageSegmentConfig,
        usageInfo,
        colors,
        ctx,
      );
    }

    if (segment.type === "sessionId") {
      return hookData.session_id
        ? ctx.segmentRenderer.renderSessionId(
            hookData.session_id,
            colors,
            segment.config as SessionIdSegmentConfig,
            {
              transcriptPath: hookData.transcript_path,
              projectDir: hookData.workspace?.project_dir,
            },
          )
        : null;
    }

    if (segment.type === "tmux") {
      return await this.renderTmuxSegment(colors);
    }

    if (segment.type === "context") {
      return this.renderContextSegment(
        segment.config as ContextSegmentConfig,
        contextInfo,
        colors,
        hookData,
        ctx,
      );
    }

    if (segment.type === "metrics") {
      return this.renderMetricsSegment(
        segment.config as MetricsSegmentConfig,
        metricsInfo,
        blockInfo,
        colors,
        ctx,
      );
    }

    if (segment.type === "block") {
      return this.renderBlockSegment(
        segment.config as BlockSegmentConfig,
        blockInfo,
        colors,
        ctx,
      );
    }

    if (segment.type === "today") {
      return this.renderTodaySegment(
        segment.config as TodaySegmentConfig,
        todayInfo,
        colors,
        ctx,
      );
    }

    if (segment.type === "version") {
      return this.renderVersionSegment(
        segment.config as VersionSegmentConfig,
        hookData,
        colors,
        ctx,
      );
    }

    if (segment.type === "env") {
      return ctx.segmentRenderer.renderEnv(
        colors,
        segment.config as EnvSegmentConfig,
      );
    }

    if (segment.type === "weekly") {
      return ctx.segmentRenderer.renderWeekly(
        hookData,
        colors,
        segment.config as WeeklySegmentConfig,
      );
    }

    if (segment.type === "toolbar") {
      const rawName = hookData.model?.display_name || "Claude";
      const formatted = formatModelName(rawName);
      return ctx.segmentRenderer.renderToolbar(
        segment.config as ToolbarSegmentConfig,
        colors,
        {
          sessionId: hookData.session_id ?? "",
          transcriptPath: hookData.transcript_path,
          projectDir: hookData.workspace?.project_dir,
          currentDir: hookData.workspace?.current_dir || hookData.cwd,
          modelName: formatted,
          modelShort: shortenModelName(formatted),
          hookData: hookData as unknown as Record<string, unknown>,
        },
      );
    }

    if (segment.type === "tray") {
      const rawName = hookData.model?.display_name || "Claude";
      const formatted = formatModelName(rawName);
      return ctx.segmentRenderer.renderTray(
        segment.config as TraySegmentConfig,
        colors,
        {
          sessionId: hookData.session_id ?? "",
          transcriptPath: hookData.transcript_path,
          projectDir: hookData.workspace?.project_dir,
          currentDir: hookData.workspace?.current_dir || hookData.cwd,
          modelName: formatted,
          modelShort: shortenModelName(formatted),
          hookData: hookData as unknown as Record<string, unknown>,
        },
      );
    }

    return null;
  }

  private async renderGitSegment(
    config: GitSegmentConfig,
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    currentDir: string,
    ctx: RenderCtx,
  ) {
    if (!this.needsSegmentInfo("git")) return null;

    const gitInfo = await this.gitService.getGitInfo(
      currentDir,
      {
        showSha: config?.showSha,
        showWorkingTree: config?.showWorkingTree,
        showOperation: config?.showOperation,
        showTag: config?.showTag,
        showTimeSinceCommit: config?.showTimeSinceCommit,
        showStashCount: config?.showStashCount,
        showUpstream: config?.showUpstream,
        showRepoName: config?.showRepoName,
      },
      hookData.workspace?.project_dir,
    );

    return gitInfo
      ? ctx.segmentRenderer.renderGit(gitInfo, colors, config)
      : null;
  }

  private async renderGitTaculousSegment(
    config: GitSegmentConfig,
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    currentDir: string,
    ctx: RenderCtx,
  ) {
    if (!this.needsSegmentInfo("gitTaculous")) return null;

    const gitInfo = await this.gitService.getGitInfo(
      currentDir,
      {
        showSha: config?.showSha,
        showWorkingTree: config?.showWorkingTree,
        showOperation: config?.showOperation,
        showTag: config?.showTag,
        showTimeSinceCommit: config?.showTimeSinceCommit,
        showStashCount: config?.showStashCount,
        showUpstream: config?.showUpstream,
        showRepoName: config?.showRepoName,
      },
      hookData.workspace?.project_dir,
    );

    return gitInfo
      ? ctx.segmentRenderer.renderGitTaculous(gitInfo, colors, config)
      : null;
  }

  private renderSessionSegment(
    config: UsageSegmentConfig,
    usageInfo: UsageInfo | null,
    colors: PowerlineColors,
    ctx: RenderCtx,
  ) {
    if (!usageInfo) return null;
    return ctx.segmentRenderer.renderSession(usageInfo, colors, config);
  }

  private async renderTmuxSegment(colors: PowerlineColors) {
    if (!this.needsSegmentInfo("tmux")) return null;
    // tmux segment uses raw symbols + colors; SegmentRenderer forwards to a
    // helper that doesn't depend on display.style symbols, so we use any
    // cached SegmentRenderer (default to "minimal") — the rendered output
    // doesn't differ across endpoints styles for tmux.
    const tmuxSessionId = await this.tmuxService.getSessionId();
    return this.getRenderTriple("minimal").segmentRenderer.renderTmux(
      tmuxSessionId,
      colors,
    );
  }

  private renderContextSegment(
    config: ContextSegmentConfig,
    contextInfo: ContextInfo | null,
    colors: PowerlineColors,
    hookData: ClaudeHookData | undefined,
    ctx: RenderCtx,
  ) {
    if (!this.needsSegmentInfo("context")) return null;
    const seg = ctx.segmentRenderer.renderContext(contextInfo, colors, config);
    if (!seg || !hookData?.transcript_path) return seg;
    const warmth = computeCacheWarmth(hookData.transcript_path, seg.fgColor);
    if (warmth) seg.text = `${seg.text} ${warmth}`;
    return seg;
  }

  private renderMetricsSegment(
    config: MetricsSegmentConfig,
    metricsInfo: MetricsInfo | null,
    _blockInfo: BlockInfo | null,
    colors: PowerlineColors,
    ctx: RenderCtx,
  ) {
    return ctx.segmentRenderer.renderMetrics(metricsInfo, colors, config);
  }

  private renderBlockSegment(
    config: BlockSegmentConfig,
    blockInfo: BlockInfo | null,
    colors: PowerlineColors,
    ctx: RenderCtx,
  ) {
    if (!blockInfo) return null;
    return ctx.segmentRenderer.renderBlock(blockInfo, colors, config);
  }

  private renderTodaySegment(
    config: TodaySegmentConfig,
    todayInfo: TodayInfo | null,
    colors: PowerlineColors,
    ctx: RenderCtx,
  ) {
    if (!todayInfo) return null;
    const todayType = config?.type || "cost";
    return ctx.segmentRenderer.renderToday(todayInfo, colors, todayType);
  }

  private renderVersionSegment(
    config: VersionSegmentConfig,
    hookData: ClaudeHookData,
    colors: PowerlineColors,
    ctx: RenderCtx,
  ) {
    return ctx.segmentRenderer.renderVersion(hookData, colors, config);
  }

  private initializeSymbols(
    displayStyle: "minimal" | "powerline" | "capsule",
  ): PowerlineSymbols {
    const charset = this.config.display.charset || "unicode";
    const isMinimalStyle = displayStyle === "minimal";
    const isCapsuleStyle = displayStyle === "capsule";
    const symbolSet = charset === "text" ? TEXT_SYMBOLS : SYMBOLS;

    return {
      right: isMinimalStyle
        ? ""
        : isCapsuleStyle
          ? symbolSet.right_rounded
          : symbolSet.right,
      left: isCapsuleStyle ? symbolSet.left_rounded : "",
      branch: symbolSet.branch,
      model: symbolSet.model,
      git_clean: symbolSet.git_clean,
      git_dirty: symbolSet.git_dirty,
      git_conflicts: symbolSet.git_conflicts,
      git_ahead: symbolSet.git_ahead,
      git_behind: symbolSet.git_behind,
      git_worktree: symbolSet.git_worktree,
      git_tag: symbolSet.git_tag,
      git_sha: symbolSet.git_sha,
      git_upstream: symbolSet.git_upstream,
      git_stash: symbolSet.git_stash,
      git_time: symbolSet.git_time,
      session_cost: symbolSet.session_cost,
      block_cost: symbolSet.block_cost,
      today_cost: symbolSet.today_cost,
      context_time: symbolSet.context_time,
      metrics_response: symbolSet.metrics_response,
      metrics_last_response: symbolSet.metrics_last_response,
      metrics_duration: symbolSet.metrics_duration,
      metrics_messages: symbolSet.metrics_messages,
      metrics_lines_added: symbolSet.metrics_lines_added,
      metrics_lines_removed: symbolSet.metrics_lines_removed,
      metrics_burn: symbolSet.metrics_burn,
      version: symbolSet.version,
      bar_filled: symbolSet.bar_filled,
      bar_empty: symbolSet.bar_empty,
      env: symbolSet.env,
      session_id: symbolSet.session_id,
      weekly_cost: symbolSet.weekly_cost,
    };
  }

  private maybeAppendPanelLine(
    output: string,
    hookData: ClaudeHookData,
    ctx: RenderCtx,
  ): string {
    const panel = this.config.panel;
    if (!panel?.items?.length) return output;
    // [LAW:dataflow-not-control-flow] Panel is visible when items exist;
    // toolbar-toggle collapses it (explicitly hidden). Default = visible.
    const expanded = this._sessionState?.get(hookData.session_id ?? "", "toolbar-expanded");
    if (expanded) return output;

    const panelLine = this.renderPanelLine(hookData, ctx);
    if (!panelLine) return output;
    return output + "\n" + panelLine;
  }

  private renderPanelLine(
    hookData: ClaudeHookData,
    ctx: RenderCtx,
  ): string | null {
    const panel = this.config.panel;
    if (!panel?.items?.length) return null;

    const colors = ctx.colors;
    const sep = panel.separator ?? " ";
    const parts: string[] = [];

    for (const item of panel.items) {
      const tctx: ToolbarContext = {
        sessionId: hookData.session_id ?? "",
        transcriptPath: hookData.transcript_path,
        projectDir: hookData.workspace?.project_dir,
        currentDir: hookData.workspace?.current_dir || hookData.cwd,
        modelName: formatModelName(hookData.model?.display_name || "Claude"),
        modelShort: shortenModelName(
          formatModelName(hookData.model?.display_name || "Claude"),
        ),
        hookData: hookData as unknown as Record<string, unknown>,
        currentTheme: ctx.theme,
        currentStyle: ctx.style,
      };

      const resolved = item.expr
        ? resolveToolbarExpr(item.expr, tctx) ?? ""
        : "";
      const visible = interpolateToolbarText(item.text, tctx);
      const scheme = item.scheme ?? "cc-candybar";
      const url = `${scheme}://${item.verb}/${encodeURIComponent(resolved)}`;
      parts.push(wrapOsc8(visible, url));
    }

    if (parts.length === 0) return null;
    const text = parts.join(sep);

    const segment: RenderedSegment = {
      type: "panel",
      text,
      bgColor: colors.sessionBg,
      fgColor: colors.sessionFg,
      bgHex: colors.hex?.sessionBg,
      fgHex: colors.hex?.sessionFg,
    };

    return this.buildLineFromSegments([segment], ctx.displayStyle);
  }

  // [LAW:single-enforcer] Builds PowerlineColors from a session-resolved
  // (theme, style) pair. Caller (buildCtx) handles random expansion before
  // we ever get here, so this function sees only concrete values.
  private computeThemeColors(theme: string, style: string): PowerlineColors {
    const colorMode = this.config.display.colorCompatibility || "auto";
    const resolved = colorMode === "auto" ? getColorSupport() : colorMode;
    const colorSupport =
      resolved === "ansi256"
        ? "ansi256" as const
        : resolved === "none"
          ? "none" as const
          : resolved === "ansi"
            ? "ansi" as const
            : "truecolor" as const;

    const effectiveTheme =
      this.config.theme === "custom" && this.config.colors?.custom
        ? "textual-dark"
        : theme;

    return resolveThemeColors({
      theme: effectiveTheme,
      style,
      themeMapping: this.config.themeMapping as
        | Record<string, SegmentOverride>
        | undefined,
      hueStep: this.config.hueStep,
      customColors: this.config.theme === "custom"
        ? this.config.colors?.custom
        : undefined,
      colorSupport,
    });
  }
}
