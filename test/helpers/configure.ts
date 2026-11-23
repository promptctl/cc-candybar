import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../../src/config/loader/edit-mode";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { VerbContext } from "../../src/renderer/verbs";
import { bookedContext } from "./click";

// Edit mode on, as entering it leaves the session: an edit open over the
// session's config, holding edit mode's own keys.
export function arrange(ctx: VerbContext, sessionId: SessionId): void {
  if (ctx.edits.draft(sessionId) !== null) return;
  const origin = bookedContext(ctx.sessionState, sessionId)!.durable.origin;
  ctx.edits.open(
    sessionId,
    origin,
    ctx.snapshotFor(origin),
    new Map([[EDIT_MODE_KEY, EDIT_MODE_ARRANGE]]),
  );
}

// Configuring is a level inside arranging: the configure key names the one
// placement whose settings hang open.
export function configurePlacement(
  ctx: VerbContext,
  sessionId: SessionId,
  preset: string,
  id: string,
  segment: string = id,
): void {
  arrange(ctx, sessionId);
  ctx.sessionState.set(
    sessionId,
    EDIT_CONFIGURE_KEY,
    configureMember({ preset, id, segment }),
  );
}
