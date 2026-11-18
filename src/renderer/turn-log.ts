// [LAW:effects-at-boundaries] The renderer's log: each line it says is held
// for the output of the turn it was said in, and the host writes it to its
// one log. A line said as the renderer is built leaves with its first turn.

import type { LoggedLine } from "../renderer-interface/interface.js";
import type { DaemonLogger } from "../utils/logger.js";

export class TurnLog {
  private lines: LoggedLine[] = [];

  readonly log: DaemonLogger = (level, line) => {
    this.lines.push({ level, line });
  };

  // What was said since the last drain, in the order it was said.
  drain(): readonly LoggedLine[] {
    const lines = this.lines;
    this.lines = [];
    return lines;
  }
}
