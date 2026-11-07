import fs from "node:fs";
import path from "node:path";

// A stand-in Claude Code's record of the session its process `pid` holds,
// written where Claude Code keeps it under its configuration directory
// (`configDir`): what makes a session the one its tmux pane runs
// (src/daemon/session-pane.ts). Written again, it is a `/clear`.
export function claudeHolds(
  configDir: string,
  pid: number,
  sessionId: string,
): void {
  const dir = path.join(configDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: configDir, status: "idle" }),
  );
}
