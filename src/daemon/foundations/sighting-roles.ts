import type { ClientHint } from "../../client-hint";
import type { ClaudeHookData } from "../../utils/claude";

// [LAW:one-source-of-truth] What the one mark Claude Code leaves says of
// whether it has answered: `current_usage` is null before the first response
// and right after a /compact. A payload without the field — a Claude Code
// before 2.0.70, or before `context_window` — says nothing either way.
export type Answered = "yes" | "no" | "unknown";

export function answeredOf(
  hookData: Pick<ClaudeHookData, "context_window">,
): Answered {
  const usage = hookData.context_window?.current_usage;
  return usage === null ? "no" : usage === undefined ? "unknown" : "yes";
}

// [LAW:one-source-of-truth] Which client drew a sighting: Claude Code's
// statusline (native, the Node fallback, or a client too old to report), or
// a `cc-candybar frames` display, whose motion the daemon's feed pushes.
export const SIGHTING_ROLES = ["statusline", "frames"] as const;
export type SightingRole = (typeof SIGHTING_ROLES)[number];
export const roleOf = (client: ClientHint | null): SightingRole =>
  client?.kind === "frames" ? "frames" : "statusline";
