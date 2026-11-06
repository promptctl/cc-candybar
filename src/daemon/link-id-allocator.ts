// [LAW:effects-at-boundaries] The home's link-id counter on disk: what every
// tmux status line's table mints its range ids through
// (src/tmux-status/link-ids.ts). Only the counter outlives the process, so a
// restarted renderer never reissues an id a stale row still carries.

import fs from "node:fs";
import { writeAtomic } from "../utils/atomic-write.js";
import type { Timekeeper } from "../time.js";
import type { LinkIdSource } from "../tmux-status/link-ids.js";

// Ids reserved per write of the file: a restart skips at most this many, and a
// busy daemon writes the file once per this many new links.
export const LINK_ID_BLOCK = 1024;

// [LAW:parse-dont-validate] A count of at most fifteen digits, so a block past
// it is still a safe integer and `ccb` with its base36 id stays within tmux's
// 15-byte range id.
const COUNT = /^\d{1,15}\n?$/;

export interface LinkIdStats {
  // Ids issued, and linked runs drawn under an id their link already held
  // (a link split across styled runs counts each).
  readonly minted: number;
  readonly reused: number;
  // Ids a table dropped over its cap.
  readonly evicted: number;
  // Blocks written to the file, and attempts that failed.
  readonly reservations: number;
  readonly faults: number;
}

export interface LinkIdAllocator extends LinkIdSource {
  // Why no id can be issued, as of the last attempt; null while ids can be.
  error(): string | null;
  stats(): LinkIdStats;
  close(): void;
}

export interface LinkIdAllocatorDeps {
  readonly file: string;
  readonly clock: Pick<Timekeeper, "after">;
  // How long a fault stands before the file is tried again.
  readonly retryMs: number;
  readonly log: (level: "info" | "error", line: string) => void;
}

// [LAW:no-ambient-temporal-coupling] Issuing ids from a block the file already
// holds past them, or faulted: no id issued, and the one timer that tries the
// file again armed.
type State =
  | { readonly kind: "ready"; next: number }
  | {
      readonly kind: "faulted";
      readonly reason: string;
      readonly clear: () => void;
    };

// [LAW:no-shared-mutable-globals] The one owner of the file: the socket lease
// makes one daemon per home, and each daemon has one allocator. Hi/lo: the file
// holds the next id no process has reserved, and a block is written there
// before any id in it is issued. Lazy, as the link key is: a daemon that
// draws no status line row touches no disk for it.
export function linkIdAllocator(deps: LinkIdAllocatorDeps): LinkIdAllocator {
  const { file, clock, retryMs, log } = deps;
  // The end of the last block reserved: every id issued is below it.
  let reserved = 0;
  let state: State = { kind: "ready", next: 0 };
  let minted = 0;
  let reused = 0;
  let evicted = 0;
  let reservations = 0;
  let faults = 0;

  // One attempt at the next block: the file's count or the end of the last
  // block, whichever is later, so a hand-lowered file never reissues an id.
  const reserve = (): State => {
    try {
      const base = Math.max(readCount(file), reserved);
      // [LAW:single-enforcer] Renamed over the count whole, so a reader sees
      // the old count or the new one, and a crash leaves one of them.
      writeAtomic(file, `${base + LINK_ID_BLOCK}\n`, 0o600);
      reserved = base + LINK_ID_BLOCK;
      reservations++;
      if (state.kind === "faulted")
        log("info", `link ids: ${file} reserved again`);
      return { kind: "ready", next: base };
    } catch (e) {
      faults++;
      const reason = `link ids: ${(e as Error).message}`;
      // [LAW:no-silent-failure] Logged once per distinct reason; every bar's ⚠
      // carries it for as long as it stands.
      if (state.kind !== "faulted" || state.reason !== reason)
        log("error", reason);
      // [LAW:no-ambient-temporal-coupling] The timer is the one retry, so a
      // broken file costs one attempt a period whatever the bar draws, and a
      // fault whose cause is gone clears whether anything mints or not.
      return {
        kind: "faulted",
        reason,
        clear: clock.after(retryMs, () => (state = reserve()), { unref: true }),
      };
    }
  };

  return {
    next() {
      if (state.kind === "ready" && state.next === reserved) state = reserve();
      if (state.kind === "faulted") return null;
      minted++;
      return state.next++;
    },
    reused: () => void reused++,
    evicted: () => void evicted++,
    error: () => (state.kind === "faulted" ? state.reason : null),
    stats: () => ({ minted, reused, evicted, reservations, faults }),
    close() {
      if (state.kind === "faulted") state.clear();
    },
  };
}

// [LAW:no-silent-failure] A file that holds no count is refused, naming it,
// never written over: a reset would reissue ids a stale row still carries.
function readCount(file: string): number {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  if (!COUNT.test(text)) {
    throw new Error(
      `${file} holds ${JSON.stringify(text.slice(0, 40))}, not a count: remove it and a new one is made, starting again from 0 (a click on a status row drawn before then may run a link drawn since)`,
    );
  }
  return Number(text.trim());
}
