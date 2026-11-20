import type { RendererDiagnostics } from "../renderer-interface/interface.js";
import type { DaemonLogger, LogLine } from "../utils/logger.js";

// [LAW:effects-at-boundaries] Renderer components annotate the current
// answer. Only its host writes the log.
export class TurnLog {
  private active = false;
  private lines: [LogLine, ...LogLine[]] | undefined;

  readonly add: DaemonLogger = (level, line) => {
    if (!this.active)
      throw new Error("a renderer diagnostic was recorded outside a turn");
    const diagnostic = { level, line };
    if (this.lines === undefined) this.lines = [diagnostic];
    else this.lines.push(diagnostic);
  };

  // [LAW:no-ambient-temporal-coupling] Construction and each turn own their
  // lines through their finalizers. None can enter a successor.
  during<Answer extends object>(
    answer: () => Answer,
  ): Answer & RendererDiagnostics {
    if (this.active) throw new Error("renderer diagnostics already in scope");
    this.active = true;
    try {
      const result = answer();
      return this.lines === undefined
        ? result
        : { ...result, diagnostics: this.lines };
    } finally {
      this.active = false;
      this.lines = undefined;
    }
  }
}
