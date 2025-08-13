import type { ClaudeHookData } from "./index";
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
  SegmentRenderer,
  PowerlineSymbols,
  AnySegmentConfig,
  GitSegmentConfig,
  UsageSegmentConfig,
  MetricsSegmentConfig,
} from "./segments";

export class PowerlineRenderer {
  private readonly symbols: PowerlineSymbols;
  private readonly usageProvider: UsageProvider;
  private readonly contextProvider: ContextProvider;
  private readonly gitService: GitService;
  private readonly tmuxService: TmuxService;
  private readonly metricsProvider: MetricsProvider;
  private readonly segmentRenderer: SegmentRenderer;

  constructor(private readonly config: PowerlineConfig) {
    this.symbols = this.initializeSymbols();
    this.usageProvider = new UsageProvider();
    this.contextProvider = new ContextProvider();
    this.gitService = new GitService();
    this.tmuxService = new TmuxService();
    this.metricsProvider = new MetricsProvider();
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

  async generateStatusline(hookData: ClaudeHookData): Promise<string> {
    const usageInfo = this.needsUsageInfo()
      ? await this.usageProvider.getUsageInfo(hookData.session_id)
      : null;

    const contextInfo = this.needsContextInfo()
      ? this.contextProvider.calculateContextTokens(
          hookData.transcript_path,
          hookData.model?.id
        )
      : null;

    const metricsInfo = this.needsMetricsInfo()
      ? await this.metricsProvider.getMetricsInfo(hookData.session_id)
      : null;

    const lines = this.config.display.lines
      .map((lineConfig) =>
        this.renderLine(
          lineConfig,
          hookData,
          usageInfo,
          contextInfo,
          metricsInfo
        )
      )
      .filter((line) => line.length > 0);

    return lines.join("\n");
  }

  private renderLine(
    lineConfig: LineConfig,
    hookData: ClaudeHookData,
    usageInfo: UsageInfo | null,
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null
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
        contextInfo,
        metricsInfo,
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
    contextInfo: ContextInfo | null,
    metricsInfo: MetricsInfo | null,
    colors: PowerlineColors,
    currentDir: string
  ) {
    switch (segment.type) {
      case "directory":
        return this.segmentRenderer.renderDirectory(hookData, colors);

      case "git":
        if (!this.needsGitInfo()) return null;
        const showSha = (segment.config as GitSegmentConfig)?.showSha || false;
        const gitInfo = this.gitService.getGitInfo(
          currentDir,
          showSha,
          hookData.workspace?.project_dir
        );
        return gitInfo
          ? this.segmentRenderer.renderGit(gitInfo, colors, showSha)
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
          metricsConfig
        );

      default:
        return null;
    }
  }

  private initializeSymbols(): PowerlineSymbols {
    const isMinimalStyle = this.config.display.style === "minimal";

    return {
      right: isMinimalStyle ? "" : "\uE0B0",
      branch: "⑂",
      model: "⚡",
      git_clean: "✓",
      git_dirty: "●",
      git_conflicts: "⚠",
      git_ahead: "↑",
      git_behind: "↓",
      session_cost: "⊡",
      context_time: "◷",
      metrics_response: "⧖",
      metrics_duration: "⧗",
      metrics_messages: "⟐",
      metrics_burn: "⟢",
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

    return {
      reset: "\x1b[0m",
      modeBg: hexToAnsi(colorTheme.directory.bg, true),
      modeFg: hexToAnsi(colorTheme.directory.fg, false),
      gitBg: hexToAnsi(colorTheme.git.bg, true),
      gitFg: hexToAnsi(colorTheme.git.fg, false),
      modelBg: hexToAnsi(colorTheme.model.bg, true),
      modelFg: hexToAnsi(colorTheme.model.fg, false),
      sessionBg: hexToAnsi(colorTheme.session.bg, true),
      sessionFg: hexToAnsi(colorTheme.session.fg, false),
      tmuxBg: hexToAnsi(colorTheme.tmux.bg, true),
      tmuxFg: hexToAnsi(colorTheme.tmux.fg, false),
      contextBg: hexToAnsi(colorTheme.context.bg, true),
      contextFg: hexToAnsi(colorTheme.context.fg, false),
      metricsBg: hexToAnsi(colorTheme.metrics.bg, true),
      metricsFg: hexToAnsi(colorTheme.metrics.fg, false),
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
      case "tmux":
        return colors.tmuxBg;
      case "context":
        return colors.contextBg;
      case "metrics":
        return colors.metricsBg;
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
