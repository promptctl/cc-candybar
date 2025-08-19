import type { ClaudeHookData } from "./utils/claude";
import type { PowerlineColors } from "./themes";
import type { PowerlineConfig, LineConfig } from "./config/loader";
import { hexToAnsi, extractBgToFg } from "./utils/colors";
import { getTheme } from "./themes";
import {
  UsageProvider,
  UsageInfo,
  ContextProvider,
  ContextInfo,
  GitService,
  TmuxService,
  MetricsProvider,
  MetricsInfo,
  VersionProvider,
  VersionInfo,
  SegmentRenderer,
  PowerlineSymbols,
  AnySegmentConfig,
  DirectorySegmentConfig,
  GitSegmentConfig,
  UsageSegmentConfig,
  MetricsSegmentConfig,
  BlockSegmentConfig,
  TodaySegmentConfig,
  VersionSegmentConfig,
} from "./segments";
import { BlockProvider, BlockInfo } from "./segments/block";
import { TodayProvider, TodayInfo } from "./segments/today";

export class PowerlineRenderer {
  private readonly symbols: PowerlineSymbols;
  private readonly usageProvider: UsageProvider;
  private readonly blockProvider: BlockProvider;
  private readonly todayProvider: TodayProvider;
  private readonly contextProvider: ContextProvider;
  private readonly gitService: GitService;
  private readonly tmuxService: TmuxService;
  private readonly metricsProvider: MetricsProvider;
  private readonly versionProvider: VersionProvider;
  private readonly segmentRenderer: SegmentRenderer;

  constructor(private readonly config: PowerlineConfig) {
    this.symbols = this.initializeSymbols();
    this.usageProvider = new UsageProvider();
    this.blockProvider = new BlockProvider();
    this.todayProvider = new TodayProvider();
    this.contextProvider = new ContextProvider();
    this.gitService = new GitService();
    this.tmuxService = new TmuxService();
    this.metricsProvider = new MetricsProvider();
    this.versionProvider = new VersionProvider();
    this.segmentRenderer = new SegmentRenderer(config, this.symbols);
  }

  private needsUsageInfo(): boolean {
    return this.config.display.lines.some(
      (line) => line.segments.session?.enabled
    );
  }

  private needsGitInfo(): boolean {
    return this.config.display.lines.some((line) => line.segments.git?.enabled);
  }

  private needsTmuxInfo(): boolean {
    return this.config.display.lines.some(
      (line) => line.segments.tmux?.enabled
    );
  }

  private needsContextInfo(): boolean {
    return this.config.display.lines.some(
      (line) => line.segments.context?.enabled
    );
  }

  private needsMetricsInfo(): boolean {
    return this.config.display.lines.some(
      (line) => line.segments.metrics?.enabled
    );
  }

  private needsBlockInfo(): boolean {
    return this.config.display.lines.some(
      (line) => line.segments.block?.enabled
    );
  }

  private needsTodayInfo(): boolean {
    return this.config.display.lines.some(
      (line) => line.segments.today?.enabled
    );
  }

  private needsVersionInfo(): boolean {
    return this.config.display.lines.some(
      (line) => line.segments.version?.enabled
    );
  }

  async generateStatusline(hookData: ClaudeHookData): Promise<string> {
    const usageInfo = this.needsUsageInfo()
      ? await this.usageProvider.getUsageInfo(hookData.session_id)
      : null;

    const blockInfo = this.needsBlockInfo()
      ? await this.blockProvider.getActiveBlockInfo()
      : null;

    const todayInfo = this.needsTodayInfo()
      ? await this.todayProvider.getTodayInfo()
      : null;

    const contextInfo = this.needsContextInfo()
      ? await this.contextProvider.calculateContextTokens(
          hookData.transcript_path,
          hookData.model?.id
        )
      : null;

    const metricsInfo = this.needsMetricsInfo()
      ? await this.metricsProvider.getMetricsInfo(hookData.session_id)
      : null;

    const versionInfo = this.needsVersionInfo()
      ? await this.versionProvider.getVersionInfo()
      : null;

    const lines = this.config.display.lines
      .map((lineConfig) =>
        this.renderLine(
          lineConfig,
          hookData,
          usageInfo,
          blockInfo,
          todayInfo,
          contextInfo,
          metricsInfo,
          versionInfo
        )
      )
      .filter((line) => line.length > 0);

    return lines.join("\n");
  }

  private renderLine(
    lineConfig: LineConfig,
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    versionInfo: VersionInfo | null
  ): string {
    const colors = this.getThemeColors();
    const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";

    const segments = Object.entries(lineConfig.segments)
      .filter(
        ([_, config]: [string, AnySegmentConfig | undefined]) => config?.enabled
      )
      .map(([type, config]: [string, AnySegmentConfig]) => ({ type, config }));

    let line = colors.reset;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) continue;

      const isLast = i === segments.length - 1;
      const nextSegment = !isLast ? segments[i + 1] : null;
      const nextBgColor = nextSegment
        ? this.getSegmentBgColor(nextSegment.type, colors)
        : "";

      const segmentData = this.renderSegment(
        segment,
        hookData,
        usageInfo,
        blockInfo,
        todayInfo,
        contextInfo,
        metricsInfo,
        versionInfo,
        colors,
        currentDir
      );

      if (segmentData) {
        line += this.formatSegment(
          segmentData.bgColor,
          segmentData.fgColor,
          segmentData.text,
          isLast ? undefined : nextBgColor
        );
      }
    }

    return line;
  }

  private renderSegment(
    segment: { type: string; config: AnySegmentConfig },
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    blockInfo: BlockInfo | null,
    todayInfo: TodayInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    versionInfo: VersionInfo | null,
    colors: PowerlineColors,
    currentDir: string
  ) {
    switch (segment.type) {
      case "directory":
        return this.segmentRenderer.renderDirectory(
          hookData,
          colors,
          segment.config as DirectorySegmentConfig
        );

      case "git":
        if (!this.needsGitInfo()) return null;
        const gitConfig = segment.config as GitSegmentConfig;
        const gitInfo = this.gitService.getGitInfo(
          currentDir,
          {
            showSha: gitConfig?.showSha,
            showWorkingTree: gitConfig?.showWorkingTree,
            showOperation: gitConfig?.showOperation,
            showTag: gitConfig?.showTag,
            showTimeSinceCommit: gitConfig?.showTimeSinceCommit,
            showStashCount: gitConfig?.showStashCount,
            showUpstream: gitConfig?.showUpstream,
            showRepoName: gitConfig?.showRepoName,
          },
          hookData.workspace?.project_dir
        );
        return gitInfo
          ? this.segmentRenderer.renderGit(gitInfo, colors, gitConfig)
          : null;

      case "model":
        return this.segmentRenderer.renderModel(hookData, colors);

      case "session":
        if (!usageInfo) return null;
        const usageType =
          (segment.config as UsageSegmentConfig)?.type || "cost";
        return this.segmentRenderer.renderSession(usageInfo, colors, usageType);

      case "tmux":
        if (!this.needsTmuxInfo()) return null;
        const tmuxSessionId = this.tmuxService.getSessionId();
        return this.segmentRenderer.renderTmux(tmuxSessionId, colors);

      case "context":
        if (!this.needsContextInfo()) return null;
        return this.segmentRenderer.renderContext(contextInfo, colors);

      case "metrics":
        const metricsConfig = segment.config as MetricsSegmentConfig;
        return this.segmentRenderer.renderMetrics(
          metricsInfo,
          colors,
          blockInfo,
          metricsConfig
        );

      case "block":
        if (!blockInfo) return null;
        const blockConfig = segment.config as BlockSegmentConfig;
        return this.segmentRenderer.renderBlock(blockInfo, colors, blockConfig);

      case "today":
        if (!todayInfo) return null;
        const todayType =
          (segment.config as TodaySegmentConfig)?.type || "cost";
        return this.segmentRenderer.renderToday(todayInfo, colors, todayType);

      case "version":
        if (!versionInfo) return null;
        const versionConfig = segment.config as VersionSegmentConfig;
        return this.segmentRenderer.renderVersion(
          versionInfo,
          colors,
          versionConfig
        );

      default:
        return null;
    }
  }

  private initializeSymbols(): PowerlineSymbols {
    const isMinimalStyle = this.config.display.style === "minimal";

    return {
      right: isMinimalStyle ? "" : "\uE0B0",
      branch: "⎇",
      model: "⚡",
      git_clean: "✓",
      git_dirty: "●",
      git_conflicts: "⚠",
      git_ahead: "↑",
      git_behind: "↓",
      git_worktree: "⧉",
      git_tag: "⌂",
      git_sha: "♯",
      git_upstream: "→",
      git_stash: "⧇",
      git_time: "◷",
      session_cost: "§",
      block_cost: "◱",
      today_cost: "☉",
      context_time: "◔",
      metrics_response: "⧖",
      metrics_last_response: "Δ",
      metrics_duration: "⧗",
      metrics_messages: "⟐",
      metrics_burn: "⟢",
      version: "◈",
    };
  }

  private getThemeColors(): PowerlineColors {
    const theme = this.config.theme;
    let colorTheme;

    if (theme === "custom") {
      colorTheme = this.config.colors?.custom;
      if (!colorTheme) {
        throw new Error(
          "Custom theme selected but no colors provided in configuration"
        );
      }
    } else {
      colorTheme = getTheme(theme);
      if (!colorTheme) {
        console.warn(
          `Built-in theme '${theme}' not found, falling back to 'dark' theme`
        );
        colorTheme = getTheme("dark")!;
      }
    }

    const fallbackTheme = getTheme("dark")!;

    return {
      reset: "\x1b[0m",
      modeBg: hexToAnsi(
        colorTheme.directory?.bg || fallbackTheme.directory.bg,
        true
      ),
      modeFg: hexToAnsi(
        colorTheme.directory?.fg || fallbackTheme.directory.fg,
        false
      ),
      gitBg: hexToAnsi(colorTheme.git?.bg || fallbackTheme.git.bg, true),
      gitFg: hexToAnsi(colorTheme.git?.fg || fallbackTheme.git.fg, false),
      modelBg: hexToAnsi(colorTheme.model?.bg || fallbackTheme.model.bg, true),
      modelFg: hexToAnsi(colorTheme.model?.fg || fallbackTheme.model.fg, false),
      sessionBg: hexToAnsi(
        colorTheme.session?.bg || fallbackTheme.session.bg,
        true
      ),
      sessionFg: hexToAnsi(
        colorTheme.session?.fg || fallbackTheme.session.fg,
        false
      ),
      blockBg: hexToAnsi(colorTheme.block?.bg || fallbackTheme.block.bg, true),
      blockFg: hexToAnsi(colorTheme.block?.fg || fallbackTheme.block.fg, false),
      todayBg: hexToAnsi(colorTheme.today?.bg || fallbackTheme.today.bg, true),
      todayFg: hexToAnsi(colorTheme.today?.fg || fallbackTheme.today.fg, false),
      tmuxBg: hexToAnsi(colorTheme.tmux?.bg || fallbackTheme.tmux.bg, true),
      tmuxFg: hexToAnsi(colorTheme.tmux?.fg || fallbackTheme.tmux.fg, false),
      contextBg: hexToAnsi(
        colorTheme.context?.bg || fallbackTheme.context.bg,
        true
      ),
      contextFg: hexToAnsi(
        colorTheme.context?.fg || fallbackTheme.context.fg,
        false
      ),
      metricsBg: hexToAnsi(
        colorTheme.metrics?.bg || fallbackTheme.metrics.bg,
        true
      ),
      metricsFg: hexToAnsi(
        colorTheme.metrics?.fg || fallbackTheme.metrics.fg,
        false
      ),
      versionBg: hexToAnsi(
        colorTheme.version?.bg || fallbackTheme.version.bg,
        true
      ),
      versionFg: hexToAnsi(
        colorTheme.version?.fg || fallbackTheme.version.fg,
        false
      ),
    };
  }

  private getSegmentBgColor(
    segmentType: string,
    colors: PowerlineColors
  ): string {
    switch (segmentType) {
      case "directory":
        return colors.modeBg;
      case "git":
        return colors.gitBg;
      case "model":
        return colors.modelBg;
      case "session":
        return colors.sessionBg;
      case "block":
        return colors.blockBg;
      case "today":
        return colors.todayBg;
      case "tmux":
        return colors.tmuxBg;
      case "context":
        return colors.contextBg;
      case "metrics":
        return colors.metricsBg;
      case "version":
        return colors.versionBg;
      default:
        return colors.modeBg;
    }
  }

  private formatSegment(
    bgColor: string,
    fgColor: string,
    text: string,
    nextBgColor?: string
  ): string {
    let output = `${bgColor}${fgColor} ${text} `;

    const reset = "\x1b[0m";

    if (nextBgColor) {
      const arrowFgColor = extractBgToFg(bgColor);
      output += `${reset}${nextBgColor}${arrowFgColor}${this.symbols.right}`;
    } else {
      output += `${reset}${extractBgToFg(bgColor)}${this.symbols.right}${reset}`;
    }

    return output;
  }
}
