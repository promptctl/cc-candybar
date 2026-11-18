import path from "node:path";
import {
  parseClientHints,
  type ClientHints,
} from "../../src/daemon/foundations/protocol";
import type { ViewFacts } from "../../src/renderer-interface/request-context";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { HOST } from "./host";

// The hints of a test client, which reports the empty Claude Code directory
// test setup isolates: a request with none means the default directory under
// the real home, and its transcripts would be read.
const TEST_HINTS = parseClientHints({
  claudeConfigDir: HOST.env.CLAUDE_CONFIG_DIR,
});

// The request a view is opened with and declares at (brandon-unfiled-3248.
// 8ro6, step 4): session `sessionId` in `cwd`, its client reporting `hints`.
export function viewFacts(
  cwd: string,
  sessionId = "s1",
  hints: ClientHints = TEST_HINTS,
): ViewFacts {
  return {
    hookData: {
      hook_event_name: "Status",
      session_id: sessionIdOf(sessionId),
      transcript_path: path.join(cwd, `${sessionId}.jsonl`),
      cwd,
      model: { id: "m", display_name: "M" },
      workspace: { current_dir: cwd, project_dir: cwd },
    },
    cwd,
    hints,
  };
}
