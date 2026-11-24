import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { FileRetirement } from "../../src/daemon/file-rewrites";
import type {
  Dropped,
  SessionFileStorage,
} from "../../src/daemon/session-state-file";

// What a per-session file in memory reads as: its sessions and what the load
// dropped of them, or a read that failed.
export type HeldRead<V> =
  | {
      readonly kind: "ok";
      readonly sessions: ReadonlyMap<SessionId, V>;
      readonly dropped?: readonly Dropped[];
    }
  | { readonly kind: "failed"; readonly reason: string };

// A per-session file in memory: what it reads as, every save, every set-aside
// and every flush. A set-aside that fails throws `refuseAside`.
export function heldStorage<V>(
  read: HeldRead<V> = { kind: "ok", sessions: new Map() },
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
  const storage: SessionFileStorage<V> = {
    file,
    observe: () => ({
      result:
        read.kind === "ok"
          ? {
              kind: "ok",
              value: { sessions: read.sessions, dropped: read.dropped ?? [] },
            }
          : { kind: "failed", reason: read.reason, file },
      paths: [file],
      source: file,
    }),
    setAside: (aside) => {
      if (options.refuseAside !== undefined) throw options.refuseAside;
      asides.push(aside);
    },
    save: (snapshot) => {
      options.save?.(snapshot);
      saves.push(new Map(snapshot));
    },
    flush: () => {
      flushes += 1;
      return options.flush?.() ?? Promise.resolve();
    },
  };
  return { storage, saves, asides, flushes: () => flushes };
}
