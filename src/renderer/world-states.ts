// The world state of every session a renderer holds, as the host handed it in
// (src/renderer/interface.ts): written only by a `request`, which carries the
// document read at its own keys, and by a `world-state`, and dropped by a
// `retire`. A view's source reads its session's document here
// (src/daemon/session-source.ts), so the renderer stamps nothing.

import { compareStructural, observable, runInAction } from "mobx";
import type { SessionId } from "../daemon/session-id";
import type { WorldState } from "../facts/world-state";

export class WorldStates {
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
  take(document: WorldState): void {
    const held = this.documents.get(document.session);
    if (held !== undefined && document.seq <= held.seq) {
      if (document.seq === held.seq && compareStructural(document, held))
        return;
      throw new Error(
        `world state seq ${document.seq} for session ${JSON.stringify(document.session)} does not follow the held seq ${held.seq}`,
      );
    }
    runInAction(() => this.documents.set(document.session, document));
  }

  // [LAW:no-defensive-null-guards] Every view opens from a request, which
  // carries its document, or reopens a session that already has one, and a
  // `retire` drops the document with the view: a session with none here is
  // the host's bug, so the read throws, naming it.
  of(session: SessionId): WorldState {
    const document = this.documents.get(session);
    if (document === undefined)
      throw new Error(
        `no world state for session ${JSON.stringify(session)}: the host hands one in with every request`,
      );
    return document;
  }

  drop(session: SessionId): void {
    runInAction(() => this.documents.delete(session));
  }
}
