import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { FileRetirement } from "../../src/daemon/file-rewrites";
import type { SessionFileStorage } from "../../src/daemon/session-state-file";
import {
  Landings,
  type Dropped,
  type Landed,
} from "../../src/daemon/foundations/stored-file";

// What a per-session file in memory reads as: none, its sessions and what
// the load dropped of them, or a read that failed.
export type HeldRead<V> =
  | { readonly kind: "absent" }
  | {
      readonly kind: "ok";
      readonly sessions: ReadonlyMap<SessionId, V>;
      readonly dropped?: readonly Dropped[];
    }
  | { readonly kind: "failed"; readonly reason: string };

// A per-session file in memory: what it reads as, every save, every set-aside
// and every flush. A set-aside that fails throws `refuseAside`.
export function heldStorage<V>(
  read: HeldRead<V> = { kind: "absent" },
  options: {
    readonly file?: string;
    readonly refuseAside?: Error;
    readonly save?: (snapshot: ReadonlyMap<SessionId, V>) => void;
    readonly flush?: () => Promise<void>;
  } = {},
) {
  const file = options.file ?? "/state/store.json";
  const saves: Array<ReadonlyMap<SessionId, V>> = [];
  const asides: FileRetirement[] = [];
  let flushes = 0;
  const landings = new Landings();
  const storage: SessionFileStorage<V> = {
    file,
    observe: () => ({
      result:
        read.kind === "failed"
          ? { kind: "failed", reason: read.reason, file }
          : {
              kind: "ok",
              value:
                read.kind === "ok"
                  ? { sessions: read.sessions, dropped: read.dropped ?? [] }
                  : { sessions: new Map(), dropped: [] },
            },
      paths: [file],
      source: read.kind === "absent" ? null : file,
    }),
    setAside: () => {
      if (options.refuseAside !== undefined) throw options.refuseAside;
      const aside = { from: file, to: `${file}.unread-${asides.length}` };
      asides.push(aside);
      return aside;
    },
    save: (snapshot) => {
      options.save?.(snapshot);
      saves.push(new Map(snapshot));
    },
    landed: (listener) => landings.listen(listener),
    flush: () => {
      flushes += 1;
      return options.flush?.() ?? Promise.resolve();
    },
  };
  // What a write of this file came to, as its storage tells the holder.
  const land = (landed: Landed): void => void landings.tell(landed);
  return { storage, saves, asides, flushes: () => flushes, land };
}
