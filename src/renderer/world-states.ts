// The world state of every session a renderer holds, as the host handed it in
// (src/renderer-interface/interface.ts): written only by a `context`, which carries the
// document read at its request's keys, and by a `world-state`, and dropped by
// a `retire`. A view's source reads its session's document here
// (src/renderer/session-source.ts), so the renderer stamps nothing.

import { compareStructural, observable, runInAction } from "mobx";
import {
  heardContextOf,
  type CheckedRenderRequest,
  type SessionContext,
} from "../renderer-interface/request-context";
import type { SessionId } from "../daemon/foundations/session-id";
import type { WorldState } from "../facts/world-state";
import type { RequestFacts } from "../daemon/foundations/request-event";

export class WorldStates {
  // [LAW:single-enforcer] Told every document taken, with the record of the
  // turn that took it, so the doctor can take its reading from that turn.
  constructor(
    private readonly took: (document: WorldState, record: RequestFacts) => void,
  ) {}

  private readonly contexts = new Map<SessionId, SessionContext>();

  // [LAW:one-source-of-truth] One document per session, the newest handed in.
  private readonly documents = observable.map<SessionId, WorldState>(
    undefined,
    { deep: false },
  );

  // [LAW:no-ambient-temporal-coupling] The host hands each session's documents
  // in `seq` order, from its collector alone; a document older than the one
  // held breaks that order, and an equal `seq` that is not the held document is
  // a second minting of one number. Both are the host's bug, said, never
  // drawn. The held document stays itself when handed in again, so nothing
  // reading it wakes.
  take(document: WorldState, record: RequestFacts): void {
    const held = this.documents.get(document.session);
    if (held !== undefined && document.seq <= held.seq) {
      if (document.seq === held.seq && compareStructural(document, held))
        return;
      throw new Error(
        `world state seq ${document.seq} for session ${JSON.stringify(document.session)} does not follow the held seq ${held.seq}`,
      );
    }
    runInAction(() => this.documents.set(document.session, document));
    this.took(document, record);
  }

  // [LAW:no-defensive-null-guards] The host delivers a session's `context`,
  // which carries its document, ahead of each of its requests, and a `retire`
  // drops the document with the view: a session with none here is the host's
  // bug, so the read throws, naming it.
  of(session: SessionId): WorldState {
    const document = this.documents.get(session);
    if (document === undefined)
      throw new Error(
        `no world state for session ${JSON.stringify(session)}: the host hands one in with the context ahead of every request`,
      );
    return document;
  }

  // [LAW:one-source-of-truth] Every session the renderer holds a document
  // of: from its context until its retire.
  sessions(): readonly SessionId[] {
    return [...this.documents.keys()];
  }

  // A session's context, as its `context` handed it in: kept beside its
  // document, for as long as it, so a live session's context is always the
  // one its document was read at.
  heard(req: CheckedRenderRequest): void {
    this.contexts.set(req.hookData.session_id, heardContextOf(req));
  }

  // The newest context of a live session, or null for one the renderer does
  // not hold.
  contextOf(session: SessionId): SessionContext | null {
    return this.contexts.get(session) ?? null;
  }

  drop(session: SessionId): void {
    this.contexts.delete(session);
    runInAction(() => this.documents.delete(session));
  }
}
