// The one record describing the segment a template is being evaluated for.
//
// [LAW:one-source-of-truth] Several template features need to know something
// about the enclosing segment — `{{ menu }}` derives its identity from the
// segment's name, `{{ color }}` must read the segment's own (transposed)
// palette, `{{ bgOf }}` must read the segment's own resolved background. Each
// of those could have carried its own published "current segment" pointer, and
// then two features could disagree about which segment is current. One record,
// one publisher, one clock.
//
// [LAW:no-ambient-temporal-coupling] This is *published state*, not ambient
// context: the render walk sets it before evaluating a segment's templates and
// clears it after, and nothing else writes it. The phase structure within a
// segment is likewise state rather than luck — `bg` is genuinely undefined
// while the `bg:` template is itself being evaluated, because at that moment
// the background is the thing being computed. Readers get a message naming the
// phase instead of a plausible-looking wrong color.

import type { ColorRgba, Palette } from "@promptctl/rich-js";
import type { Disclosure } from "../themes/decor.js";

export interface ActiveSegment {
  /** The segment's declared name — `{{ menu }}` derives its identity from it. */
  readonly segName: string;
  /**
   * The disclosure this segment would open: the vocabulary hue its address
   * was dealt, at its band depth. A `{{ menu }}`'s body colours its option
   * cells as items of THIS band, and the walk draws the segment itself as the
   * band's trigger when the body is open — one record, so the trigger and the
   * items it opens cannot be coloured from two different hues.
   */
  readonly disclosure: Disclosure;
  /**
   * The palette this segment's colors resolve from: the base theme (session
   * choice over config default, or an explicit per-segment `palette:` pin)
   * after the render's look.
   *
   * Template bodies read colors through THIS, not through a palette captured
   * when the config was loaded — otherwise `{{ color "primary" }}` inside a
   * segment paints from a different palette than the cell it sits in.
   */
  readonly palette: Palette;
  /**
   * The segment's resolved background, once known: the authored `bg:`, else
   * the tint its address was dealt.
   *
   * Undefined during evaluation of the segment's own `bg:` template — the
   * ordering is bg, then fg, then body, and a background cannot be an input to
   * computing itself.
   */
  bg: ColorRgba | undefined;
}

/** The published pointer. Null between segments. */
export interface ActiveSegmentRef {
  current: ActiveSegment | null;
}

export function createActiveSegmentRef(): ActiveSegmentRef {
  return { current: null };
}

/**
 * Read the active segment, or fail with a message that says *why* nothing is
 * active rather than what is missing.
 *
 * [LAW:no-defensive-null-guards] Null here is never a state to route around —
 * it means a segment-scoped template function fired outside a segment render,
 * which is either a wiring bug or an author using the function somewhere it
 * cannot mean anything (a variable template, a node `when`). Both need to be
 * seen, and in cc-candybar a thrown template error surfaces as a visible ⚠
 * cell that `cc-candybar check` fails on. [LAW:no-silent-failure]
 */
export function requireActiveSegment(
  ref: ActiveSegmentRef,
  func: string,
): ActiveSegment {
  const active = ref.current;
  if (active === null) {
    throw new Error(
      `{{ ${func} }} is only available inside a segment's templates — ` +
        `there is no active segment here. Segment-scoped functions cannot be ` +
        `used in variable declarations or layout-node "when" predicates, ` +
        `which are evaluated outside any segment.`,
    );
  }
  return active;
}
