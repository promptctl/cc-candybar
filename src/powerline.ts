import type { ClaudeHookData, PowerlineColors } from "./types";
import type { PowerlineConfig, LineConfig } from "./types/config";
import { hexToAnsi, extractBgToFg } from "./lib/colors";
import { getTheme } from "./themes";
import { UsageProvider } from "./lib/usage-provider";
import { GitService } from "./lib/git-service";
import { TmuxService } from "./lib/tmux-service";
import { SegmentRenderer, PowerlineSymbols } from "./lib/segment-renderer";

export class PowerlineRenderer {
  private readonly symbols: PowerlineSymbols;
  private readonly usageProvider: UsageProvider;
  private readonly gitService: GitService;
  private readonly tmuxService: TmuxService;
  private readonly segmentRenderer: SegmentRenderer;

  constructor(private readonly config: PowerlineConfig) {
    this.symbols = this.initializeSymbols();
    this.usageProvider = new UsageProvider();
    this.gitService = new GitService();
    this.tmuxService = new TmuxService();
    this.segmentRenderer = new SegmentRenderer(config, this.symbols);
  }

  async generateStatusline(hookData: ClaudeHookData): Promise<string> {
    const usageInfo = await this.usageProvider.getUsageInfo(
      hookData.session_id
    );

    let sessionBlockInfo = null;
    if (this.needsSessionBlock()) {
      sessionBlockInfo = await this.usageProvider.getSessionBlockInfo();
    }

    const lines = this.config.display.lines
      .map((lineConfig) =>
        this.renderLine(lineConfig, hookData, usageInfo, sessionBlockInfo)
      )
      .filter((line) => line.length > 0);

    return lines.join("\n");
  }

  private needsSessionBlock(): boolean {
    return this.config.display.lines.some(
      (line) => line.segments.block?.enabled
    );
  }

  private renderLine(
    lineConfig: LineConfig,
    hookData: ClaudeHookData,
    usageInfo: any,
    sessionBlockInfo: any
  ): string {
    const colors = this.getThemeColors();
    const currentDir = hookData.workspace?.current_dir || hookData.cwd || "/";

    const segments = Object.entries(lineConfig.segments)
      .filter(([_, config]: [string, any]) => config?.enabled)
      .map(([type, config]: [string, any]) => ({ type, config }));

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
        sessionBlockInfo,
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
    segment: any,
    hookData: ClaudeHookData,
    usageInfo: any,
    sessionBlockInfo: any,
    colors: any,
    currentDir: string
  ) {
    switch (segment.type) {
      case "directory":
        return this.segmentRenderer.renderDirectory(hookData, colors);

      case "git":
        const showSha = segment.config?.showSha || false;
        const gitInfo = this.gitService.getGitInfo(currentDir, showSha);
        return gitInfo
          ? this.segmentRenderer.renderGit(gitInfo, colors, showSha)
          : null;

      case "model":
        return this.segmentRenderer.renderModel(hookData, colors);

      case "session":
        const usageType = segment.config?.type || "cost";
        return this.segmentRenderer.renderSession(usageInfo, colors, usageType);

      case "today":
        const todayType = segment.config?.type || "cost";
        return this.segmentRenderer.renderToday(usageInfo, colors, todayType);

      case "block":
        const blockType = segment.config?.type || "cost";
        return this.segmentRenderer.renderBlock(
          sessionBlockInfo,
          colors,
          blockType
        );

      case "tmux":
        const tmuxSessionId = this.tmuxService.getSessionId();
        return this.segmentRenderer.renderTmux(tmuxSessionId, colors);

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
      session_cost: "Session",
      daily_cost: "Today",
      block_cost: "Block",
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
      todayBg: hexToAnsi(colorTheme.today.bg, true),
      todayFg: hexToAnsi(colorTheme.today.fg, false),
      blockBg: hexToAnsi(colorTheme.block.bg, true),
      blockFg: hexToAnsi(colorTheme.block.fg, false),
      burnLowBg: hexToAnsi(colorTheme.today.bg, true),
      burnFg: hexToAnsi(colorTheme.today.fg, false),
      tmuxBg: hexToAnsi(colorTheme.tmux.bg, true),
      tmuxFg: hexToAnsi(colorTheme.tmux.fg, false),
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
      case "today":
        return colors.burnLowBg;
      case "block":
        return colors.blockBg;
      case "tmux":
        return colors.tmuxBg;
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
