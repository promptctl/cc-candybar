import path from "node:path";
import { parseClientHints, type ClientHints } from "../../src/daemon/protocol";
import type { ViewFacts } from "../../src/daemon/render-payload";

// The request a view is opened with and declares at (brandon-unfiled-3248.
// 8ro6, step 4): session `sessionId` in `cwd`, its client reporting `hints`.
export function viewFacts(
  cwd: string,
  sessionId = "s1",
  hints: ClientHints = parseClientHints({}),
): ViewFacts {
  return {
    hookData: {
      hook_event_name: "Status",
      session_id: sessionId,
      transcript_path: path.join(cwd, `${sessionId}.jsonl`),
      cwd,
      model: { id: "m", display_name: "M" },
      workspace: { current_dir: cwd, project_dir: cwd },
    },
    cwd,
    hints,
  };
}
