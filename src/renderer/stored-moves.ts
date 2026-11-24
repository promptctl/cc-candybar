// [LAW:one-source-of-truth] The sessions a renderer store moved since the
// host was last told, in the order they last moved, and for each whether
// what it holds moved or only its place: what the turn's stored writes carry,
// so the host's copy keeps the store's recency order.

import type { SessionId } from "../daemon/foundations/session-id";

export type Moved = "put" | "heard";

export class StoredMoves {
  private readonly moved = new Map<SessionId, Moved>();

  put(session: SessionId): void {
    this.moved.delete(session);
    this.moved.set(session, "put");
  }

  // A hearing after a put in the same turn is carried by the put, which
  // moves the entry to the newest end as the hearing did.
  heard(session: SessionId): void {
    const was = this.moved.get(session);
    this.moved.delete(session);
    this.moved.set(session, was ?? "heard");
  }

  drain<W>(write: (session: SessionId, moved: Moved) => W): W[] {
    const writes = [...this.moved].map(([session, moved]) =>
      write(session, moved),
    );
    this.moved.clear();
    return writes;
  }
}
