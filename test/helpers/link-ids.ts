import { LinkIds, type LinkIdSource } from "../../src/tmux-status/link-ids";

// A link-id source in memory, in place of the home's counter
// (src/daemon/link-id-allocator.ts): ids from `start` up, none at all while
// `faulted`, and the counts a table reports.
export interface CountedIds extends LinkIdSource {
  faulted: boolean;
  readonly counts: { minted: number; reused: number; evicted: number };
}

export function countedIds(start = 0): CountedIds {
  let next = start;
  const counts = { minted: 0, reused: 0, evicted: 0 };
  const ids: CountedIds = {
    faulted: false,
    counts,
    next: () => {
      if (ids.faulted) return null;
      counts.minted++;
      return next++;
    },
    reused: () => void counts.reused++,
    evicted: () => void counts.evicted++,
  };
  return ids;
}

// A session's table over a fresh source: what a test of an encoding hands it.
export const freshLinkIds = (): LinkIds => new LinkIds(countedIds());
