// [LAW:one-source-of-truth] One record for the segment a template is evaluating, so
// two template features cannot disagree about which segment is current.
// [LAW:no-ambient-temporal-coupling] The walk publishes it; nothing else writes it.

import type { ColorRgba, Palette } from "@promptctl/rich-js";
import type { Disclosure } from "../themes/decor.js";

export interface ActiveSegment {
  readonly segName: string;
  /** The band this segment opens; its trigger and the items it opens share one hue. */
  readonly disclosure: Disclosure;
  /** Colours resolve from THIS palette, not one captured when the config loaded. */
  readonly palette: Palette;
  /** Undefined while the segment's own `bg:` runs — the order is bg, fg, body. */
  bg: ColorRgba | undefined;
}

export interface ActiveSegmentRef {
  current: ActiveSegment | null;
}

export function createActiveSegmentRef(): ActiveSegmentRef {
  return { current: null };
}

/**
 * [LAW:no-defensive-null-guards][LAW:no-silent-failure] Null means a
 * segment-scoped function fired outside a segment render — a bug to surface.
 */
export function requireActiveSegment(
  ref: ActiveSegmentRef,
  spelling: string,
): ActiveSegment {
  const active = ref.current;
  if (active === null) {
    throw new Error(
      `${spelling} is only available inside a segment's templates — ` +
        `there is no active segment here. Segment-scoped functions cannot be ` +
        `used in variable declarations or layout-node "when" predicates, ` +
        `which are evaluated outside any segment.`,
    );
  }
  return active;
}
