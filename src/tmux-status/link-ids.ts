// A tmux status line's range ids (docs/design/gather-and-renderer.md,
// section 18): `ccb` and a link id, a base36 number minted from the home's
// counter (src/daemon/link-id-allocator.ts), so two links never share an id.

// The prefix of every range id this lane marks, which the status line's click
// binding matches on (`#{m:ccb*,#{mouse_status_range}}`).
export const RANGE_PREFIX = "ccb";

// The links a session's status line keeps ids for: enough for every link a row
// draws, so a row tmux has not refreshed yet still resolves.
export const LINK_IDS_PER_SURFACE = 256;

// [LAW:effects-at-boundaries] What a table mints through: the home's counter,
// and the counts it keeps of what every table did.
export interface LinkIdSource {
  // The next link id, or null while none can be issued: the source's error
  // says why, in the bar's ⚠.
  next(): number | null;
  reused(): void;
  evicted(): void;
}

// [LAW:one-source-of-truth] One session's status line's ids, keyed by the
// link's content, so a re-draw of a link reuses its id and an animating row
// mints nothing. An LRU: a hit moves the link to the newest end, and the
// least recently drawn goes once the table is over its cap. An evicted id
// finds nothing, as any stale one does, because the counter never issues it
// again.
export class LinkIds {
  private readonly ranges = new Map<string, string>();

  constructor(
    private readonly source: LinkIdSource,
    private readonly cap: number = LINK_IDS_PER_SURFACE,
  ) {}

  // The range id `url` is drawn under, or null while the counter can issue
  // none.
  rangeOf(url: string): string | null {
    const held = this.ranges.get(url);
    if (held !== undefined) {
      this.ranges.delete(url);
      this.ranges.set(url, held);
      this.source.reused();
      return held;
    }
    const id = this.source.next();
    if (id === null) return null;
    const range = RANGE_PREFIX + id.toString(36);
    this.ranges.set(url, range);
    for (const oldest of this.ranges.keys()) {
      if (this.ranges.size <= this.cap) break;
      this.ranges.delete(oldest);
      this.source.evicted();
    }
    return range;
  }
}
