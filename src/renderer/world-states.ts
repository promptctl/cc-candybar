// The world state of every session a renderer holds, as the host handed it in
// (src/renderer-interface/interface.ts): written only by a `config`, which carries the
// document read at its request's keys, and by a `world-state`, and dropped by
// a `retire`. A view's source reads its session's document here
// (src/renderer/session-source.ts), so the renderer stamps nothing.

import { compareStructural, observable, runInAction } from "mobx";
import type { SessionId } from "../daemon/foundations/session-id";
import type { Fact } from "../facts/fact";
import type { Update, WorldState } from "../facts/world-state";

// [LAW:one-source-of-truth] The update is one fact the host restamps for
// every session and hands in session by session, so the one held is the
// latest change any document carried: a document handed in late, carrying
// the fact as it stood before, moves nothing.
const later = (held: Fact<Update> | null, next: Fact<Update>): Fact<Update> =>
  next.kind === "pending"
    ? (held ?? next)
    : held === null || held.kind === "pending" || next.at >= held.at
      ? next
      : held;

export class WorldStates {
  // [LAW:one-source-of-truth] One document per session, the newest handed in.
  private readonly documents = observable.map<SessionId, WorldState>(
    undefined,
    { deep: false },
  );
  // [LAW:one-source-of-truth] The update the newest document handed in says:
  // the daemon's facts are one value every session's document carries, so the
  // newest one is current for all of them. Null before the first.
  private readonly update = observable.box<Fact<Update> | null>(null, {
    deep: false,
  });

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
    runInAction(() => {
      this.documents.set(document.session, document);
      this.update.set(later(this.update.get(), document.daemon.update.newer));
    });
  }

  // [LAW:no-defensive-null-guards] The host delivers a session's `config`,
  // which carries its document, ahead of each of its requests, and a `retire`
  // drops the document with the view: a session with none here is the host's
  // bug, so the read throws, naming it.
  of(session: SessionId): WorldState {
    const document = this.documents.get(session);
    if (document === undefined)
      throw new Error(
        `no world state for session ${JSON.stringify(session)}: the host hands one in with the config ahead of every request`,
      );
    return document;
  }

  newestUpdate(): Fact<Update> | null {
    return this.update.get();
  }

  drop(session: SessionId): void {
    runInAction(() => this.documents.delete(session));
  }
}
