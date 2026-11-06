// A tmux status line's range ids (docs/design/gather-and-renderer.md,
// section 18): `ccb` and a link id, a base36 number minted from the home's
// counter (src/daemon/link-id-allocator.ts), so two links never share an id.

// The prefix of every range id this lane marks, which the status line's click
// binding matches on (`#{m:ccb*,#{mouse_status_range}}`).
export const RANGE_PREFIX = "ccb";

// The links a session's status line keeps ids for beyond the frame it draws:
// a link that leaves the row and comes back within this many others keeps its
// id. A click resolves against the frame the row last drew, never this table.
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
// mints nothing. An LRU: a hit moves the link to the newest end, and once a
// frame is drawn the least recently drawn go while the table is over its cap.
// A link the frame drew is never one of them, so a row of more links than the
// cap keeps every id it draws. An evicted id finds nothing, as any stale one
// does, because the counter never issues it again.
export class LinkIds {
  private readonly ranges = new Map<string, string>();

  constructor(
    private readonly source: LinkIdSource,
    private readonly cap: number = LINK_IDS_PER_SURFACE,
  ) {}

  // [LAW:no-ambient-temporal-coupling] One frame drawn through the table:
  // `draw` names each link's range with `rangeOf`, and eviction waits until
  // the frame is drawn, so it never takes a link the frame holds.
  frame<T>(draw: (rangeOf: (url: string) => string | null) => T): T {
    const drawn = new Set<string>();
    const drawnAs = draw((url) => {
      drawn.add(url);
      return this.rangeOf(url);
    });
    for (const oldest of this.ranges.keys()) {
      if (this.ranges.size <= this.cap || drawn.has(oldest)) break;
      this.ranges.delete(oldest);
      this.source.evicted();
    }
    return drawnAs;
  }

  // The range id `url` is drawn under, or null while the counter can issue
  // none.
  private rangeOf(url: string): string | null {
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
    return range;
  }
}
