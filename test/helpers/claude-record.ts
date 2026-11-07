import fs from "node:fs";
import path from "node:path";
import type { StartToken } from "../../src/daemon/process-fingerprint";

// The start a stand-in Claude Code's process has, as its record and its
// client's `parent` hint both name it.
export const CLAUDE_START = "Fri Nov  6 02:12:23 2026" as StartToken;

// A stand-in Claude Code's record of the session its process `pid` holds,
// written where Claude Code keeps it under its configuration directory
// (`configDir`), naming the process's start (`procStart`): what makes a
// session the one its tmux pane runs (src/daemon/session-pane.ts). Written
// again, it is a `/clear`.
export function claudeHolds(
  configDir: string,
  pid: number,
  sessionId: string,
  procStart: string = CLAUDE_START,
): void {
  const dir = path.join(configDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, procStart, cwd: configDir, status: "idle" }),
  );
}
