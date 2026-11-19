import {
  configureMember,
  EDIT_CONFIGURE_KEY,
} from "../../src/config/loader/edit-mode";
import type { VerbContext } from "../../src/renderer/verbs";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import { bookedContext } from "./click";

// Edit mode on, as the click entering it leaves it: an edit open over the
// config the session renders from. Edit chrome lives only in an open edit.
export function arrange(ctx: VerbContext, sessionId: SessionId): void {
  if (ctx.edits.draft(sessionId) !== null) return;
  const booked = bookedContext(ctx.sessionState, sessionId);
  if (booked === null)
    throw new Error(`session ${sessionId} has rendered nothing to edit`);
  const { origin } = booked.durable;
  ctx.edits.open(sessionId, origin, ctx.snapshotFor(origin));
}

// Configuring is a level inside arranging: edit mode on, and the configure key
// naming the one placement whose settings hang open.
export function configurePlacement(
  ctx: VerbContext,
  sessionId: SessionId,
  preset: string,
  id: string,
): void {
  arrange(ctx, sessionId);
  ctx.edits.view.set(sessionId, EDIT_CONFIGURE_KEY, configureMember(preset, id));
}
