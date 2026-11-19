// The live sessions the host handed in. A context admits both the request
// and its document. A later world update can replace only a live document.

import { compareStructural, observable, runInAction } from "mobx";
import {
  heardContextOf,
  type CheckedRenderRequest,
  type SessionContext,
} from "../renderer-interface/request-context.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { WorldState } from "../facts/world-state.js";

// [LAW:one-source-of-truth] A session's context and document have one lifetime.
interface LiveSession {
  readonly context: CheckedRenderRequest;
  readonly document: WorldState;
}

export class WorldStates {
  private readonly live = observable.map<SessionId, LiveSession>(undefined, {
    deep: false,
  });

  open(context: CheckedRenderRequest, document: WorldState): void {
    const session = context.hookData.session_id;
    if (document.session !== session)
      throw new Error(
        `world state for session ${JSON.stringify(document.session)} arrived with context for ${JSON.stringify(session)}`,
      );
    const held = this.live.get(session);
    const next = nextDocument(document, held?.document);
    if (held?.context === context && held.document === next) return;
    runInAction(() => this.live.set(session, { context, document: next }));
  }

  // [LAW:no-ambient-temporal-coupling] Only context can admit a session.
  // A world update that arrives after retirement cannot bring it back.
  take(document: WorldState): boolean {
    const held = this.live.get(document.session);
    if (held === undefined) return false;
    const next = nextDocument(document, held.document);
    if (next !== held.document)
      runInAction(() =>
        this.live.set(document.session, {
          context: held.context,
          document: next,
        }),
      );
    return true;
  }

  of(session: SessionId): WorldState {
    return this.require(session).document;
  }

  requestOf(session: SessionId): CheckedRenderRequest {
    return this.require(session).context;
  }

  sessions(): readonly SessionId[] {
    return [...this.live.keys()];
  }

  contextOf(session: SessionId): SessionContext | null {
    const held = this.live.get(session);
    return held === undefined ? null : heardContextOf(held.context);
  }

  drop(session: SessionId): void {
    runInAction(() => this.live.delete(session));
  }

  // [LAW:no-silent-failure] The host admits a session before asking for its
  // first draw. A request outside that lifetime reports what went wrong.
  private require(session: SessionId): LiveSession {
    const held = this.live.get(session);
    if (held === undefined)
      throw new Error(
        `no world state for session ${JSON.stringify(session)}: the host hands one in with the context ahead of every request`,
      );
    return held;
  }
}

// [LAW:single-enforcer] Admission and collector pushes use the same sequence
// rule. A repeated document keeps its identity so its readers need not wake.
function nextDocument(
  document: WorldState,
  held: WorldState | undefined,
): WorldState {
  if (held === undefined || document.seq > held.seq) return document;
  if (document.seq === held.seq && compareStructural(document, held))
    return held;
  throw new Error(
    `world state seq ${document.seq} for session ${JSON.stringify(document.session)} does not follow the held seq ${held.seq}`,
  );
}
