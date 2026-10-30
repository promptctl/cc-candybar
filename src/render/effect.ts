// The effects a session's bar wears, row by row: the bar's own loop
// (brandon-effects-2gka.d2i), each placement's that sets one
// (brandon-effects-2gka.bm1), and the transitions a placement passes through
// as it appears (brandon-effects-2gka.631) and leaves (brandon-effects-2gka.3vt).
//
// rich-js owns the effects themselves (`EFFECT_CATALOGUE`, `Effected`,
// `confined`): each made from the frame it draws into an animation of how that
// frame's colours move, read at a time `t`. This
// module owns the facts about a SESSION those functions need and cannot know —
// when each effect came into force, which is that effect's own t = 0, the
// effect objects already made for its rows, which rich-js reuses a frame's
// settled shares on only when it is handed the same object again, and what
// each placement the last frame drew, which is what makes a placement appear,
// and what one that leaves replays as it dissolves.

import {
  Animation,
  DEFAULT_TERMINAL_THEME,
  EFFECT_CATALOGUE,
  Effected,
  TerminalTheme,
  Timeline,
  confined,
  type ColorRgba,
  type Effect,
  type EffectFrame as CellFrame,
  type LoopName,
  type Renderable,
  type RichText,
  type TransitionName,
} from "@promptctl/rich-js";

import {
  EFFECT_FLOOR,
  FOLLOW_BAR,
  type EffectName,
  type PlacementEffect,
} from "../themes/policy.js";
import type { AnimationTime, Instant } from "../utils/instant.js";
import { CLOSING_FLASH, flashBegins } from "../config/menu-timeout.js";
import type {
  Drawing,
  FrameRecord,
  FrameSource,
  Returned,
} from "./frame-memory.js";

// [LAW:types-are-the-program] The placement a laid cell belongs to, its
// `effect` setting and its ground: what a laid cell demands of its row
// (`LaidCell.placement`). Its id keys the clock of the placement's own effect
// and of its fade; its effect is the bar's (`FOLLOW_BAR`) or its own — `none`
// included, a still cell on a moving bar; its ground is what it fades in from.
export interface CellPlacement {
  readonly id: string;
  readonly effect: PlacementEffect;
  // [LAW:one-source-of-truth] The placement's palette's `background`
  // (`groundOf`): the stand-in its `bg: "none"` cells' `{{ bgOf }}` answers
  // with for the terminal ground the detached daemon cannot see.
  readonly ground: ColorRgba;
}

// One item of a row's strip — the strip stamps its cells with the item itself,
// which is how `confined` tells one item's cells from another's — and the
// placement whose cell it is.
export interface RowItem {
  readonly owner: RichText;
  readonly placement: CellPlacement;
}

// What one render asks of its transitions: whether placements pass through
// them at all (globals.transitions), what the frame is drawn from, the view's
// record of the last frame it drew from that same source (`FrameMemory.from`,
// none when the last was drawn from another), how the lines a placement
// returned divide (`Returned`), and how a placement that leaves replays one of
// its rows.
export interface FrameTransitions<Line> {
  readonly transitions: boolean;
  readonly source: FrameSource;
  readonly last: FrameRecord<Line> | null;
  readonly returned: (id: string, lines: readonly Line[]) => Returned<Line>;
  readonly hold: (line: Line) => Line;
}

// [LAW:no-ambient-temporal-coupling] One render's motion: what each placement
// the walk reaches draws, each row's motion, and the moment the frame is
// drawn. What the frame drew becomes what the next one compares against only
// then, so a render that throws part-way leaves the last drawn frame in place
// rather than a half-recorded one.
export interface FrameMotion<Line> {
  // The walk reports each placement with the lines it returned and draws what
  // comes back: those lines — or, while it leaves the bar, the rows it held of
  // its last drawing in place of its own, not drawn again
  // (brandon-effects-2gka.p04: the payload that hides a placement is often one
  // its template errors on), beside the deeper lines it returned.
  readonly placed: (id: string, lines: readonly Line[]) => readonly Line[];
  readonly row: (
    row: string,
    kind: RowKind,
    items: readonly RowItem[],
  ) => RowMotion;
  readonly drawn: () => void;
}

// [LAW:types-are-the-program] What one row is drawn under: nothing, or an
// effect made for the row and the frame's instant on the host clock, which
// rich-js hands a placed `Effected` through the frame it is drawn in, and which
// each of its parts' timelines maps to the part's own time. A still row has
// no `Effected` around it at all, so `none` draws exactly the bytes it always
// drew.
export type RowMotion =
  | { readonly kind: "still" }
  | {
      readonly kind: "moving";
      readonly time: number;
      readonly wrap: (strip: Renderable) => Renderable;
    };

export const STILL: RowMotion = { kind: "still" };

// [LAW:types-are-the-program] What a row of the bar is: one of the bar's own,
// or one an open menu added — a disclosure body, a dropped `{{ menu }}` —
// which is what flashes before the menus close.
export type RowKind = "bar" | "menu";

// [LAW:types-are-the-program] The flash an idle session's menus wear before
// they close on their own (src/config/menu-timeout.ts): none while no idle
// period runs, or the idle period — when it began and how long it lasts — and
// the colours a lit hold draws every cell in: a fill, and the text that reads
// on it.
export type MenuFlash = null | {
  readonly idleSince: Instant;
  readonly timeoutS: number;
  readonly fill: ColorRgba;
  readonly text: ColorRgba;
};

// An effect made for one row — the bar's, or one placement's on that row — and
// the name it was made for.
interface RowEffect {
  readonly name: EffectName;
  readonly effect: Effect;
}

// When an effect came into force: its own t = 0, on the animation clock.
interface InForce {
  readonly name: EffectName;
  readonly since: AnimationTime;
}

// [LAW:types-are-the-program] One frame's reading of the session's animation
// clock (brandon-menus-sjhy.nt2): the wall instant the frame is drawn at, and
// the session's animation timeline — rich-js's map from the host clock to
// animation time, at the speed it runs at from this frame on. Read once before
// the walk (`SessionEffects.clockAt`) and handed to every consumer — the
// templates' `frames`, and `motion` — so all of a frame's animations run on one
// timeline; kept as the clock's anchor once the frame is drawn.
// [LAW:one-source-of-truth] Every animation of a frame is drawn at `wall` and
// says when it next changes on that one host clock, carried there by
// `Timeline.run`, so a frame's cells, whatever drew them, say one time.
export interface FrameClock {
  readonly wall: Instant;
  readonly timeline: Timeline;
}

// The animation time the session's clock reads at the frame's instant.
export const animationAt = (clock: FrameClock): AnimationTime =>
  Timeline.at(clock.timeline, clock.wall) as AnimationTime;

// A placement wearing its own effect in one render, as its event reports it.
export interface OwnEffectFrame {
  readonly placement: string;
  readonly effect: EffectName;
  readonly t: number;
}

// A placement fading in or dissolving out, on its own clock, as a render's
// event reports it.
export interface PassageFrame {
  readonly placement: string;
  readonly t: number;
}

// [LAW:types-are-the-program] What a render's placements were compared
// against: nothing, because transitions are off; nothing, because there is no
// earlier frame drawn from the same source (the session's first render, or the
// first after a reload or a write to its state — `fresh`); or the last frame
// (`compared`).
export type FadeBasis = "off" | "fresh" | "compared";

// One render's effects, as its event reports them.
export interface EffectFrame {
  readonly effect: EffectName;
  // Seconds since the effect came into force: the effect's own clock.
  readonly t: number;
  // The rate the animation clock ran at for this frame.
  readonly speed: number;
  // Effects made for rows this render, and ones that reused last frame's.
  readonly made: number;
  readonly reused: number;
  // Each placement the render drew wearing its own effect, on its own clock.
  readonly own: readonly OwnEffectFrame[];
  // What the render's placements were compared against, the revision of the
  // session state it was drawn from, each placement fading in, and each one
  // dissolving out.
  readonly basis: FadeBasis;
  readonly revision: number;
  readonly fades: readonly PassageFrame[];
  readonly leaves: readonly PassageFrame[];
}

// A placement passing through a transition: a `fade` in as it appears, a
// `dissolve` out as it leaves. Since the instant it began, its own t = 0, made
// once. [LAW:types-are-the-program] It keeps when the transition is over and
// the one effect to draw, veiling toward the placement's ground; the
// transition as made veils toward the terminal's, so it is not kept.
interface Passage {
  readonly name: TransitionName;
  readonly since: AnimationTime;
  readonly done: (t: number) => boolean;
  readonly effect: Effect;
}

// A placement the frame drew — for one leaving, what it held of its last
// drawing — and the transition it is passing through, or none.
interface Placed<Line> {
  readonly drawing: Drawing<Line>;
  readonly passage: Passage | null;
}

// [LAW:types-are-the-program] Whose effect a part of a row is: the bar's, or
// the placement's of that id. The bar's is a symbol, which no placement id can
// equal — a placement is free to be named `bar`.
const BAR_SCOPE = Symbol("bar");
type Scope = typeof BAR_SCOPE | string;

// Which effect of a row a cell is drawn under, and on which clock.
interface Part {
  // What the row's made effect is kept under, so every cell following the bar
  // shares one.
  readonly scope: Scope;
  readonly name: EffectName;
  readonly t: number;
  // The items it is confined to, or none: the whole row.
  readonly owners: readonly RichText[] | undefined;
}

// A part wearing a catalogue loop: every effect name but the floor.
type Moving<P extends { name: EffectName }> = P & { readonly name: LoopName };
function isMoving<P extends { name: EffectName }>(part: P): part is Moving<P> {
  return part.name !== EFFECT_FLOOR;
}

// [LAW:one-type-per-behavior] Several effects, each on its own clock, as the one
// `Effect` an `Effected` takes: every part's animation is made from the frame's
// `drawn` and run on the timeline it counts on — a map from the host clock the
// row is drawn on to the part's own `t` — then the frames fold over the cell in
// the order given. The loops are confined to disjoint items, so at most one of
// them moves any one colour; a transition is confined to its placement's items,
// which a loop may light too, and comes after the loops so it veils the lit
// colours — the order is the meaning. Composed with `Animation.all`, the row
// changes when the soonest of its parts does, on the host clock, so a row whose
// parts all hold still says so, and one that moves says exactly when.
// [LAW:types-are-the-program] Which clock a part counts on is a value it
// carries, not a rule here: the session's animation timeline for what is
// decoration, the host clock for what counts down to a real moment.
interface RowPart {
  readonly timeline: Timeline;
  readonly effect: Effect;
}
function together(parts: readonly RowPart[]): Effect {
  return (drawn) =>
    Animation.map(
      Animation.all(
        parts.map(({ timeline, effect }) =>
          Timeline.run(timeline, effect(drawn)),
        ),
      ),
      (frames): CellFrame =>
        (colors, cell) =>
          frames.reduce((moved, part) => part(moved, cell), colors),
    );
}

// [LAW:one-source-of-truth] The terminal an effect measures and writes against
// is the one rich-js assumes when a terminal names none — the assumption every
// contrast floor in this repo makes, because the detached daemon cannot see the
// client's terminal. `DEFAULT_TERMINAL_THEME` is that terminal's exported face
// (black ground, white text, the VGA sixteen); test/row-effect.test.ts holds it
// to the colours rich-js resolves for an unnamed terminal.
const ASSUMED_TERMINAL = DEFAULT_TERMINAL_THEME;

// [LAW:one-source-of-truth] rich-js veils a fade toward the ground of the
// terminal its frame is drawn on (`Drawn.theme`), and the daemon cannot see the
// client's: a cell fades in from, and dissolves into, its placement's ground
// (`CellPlacement`). Only the transitions see that ground; every contrast the
// loops measure stays on ASSUMED_TERMINAL.
function fromGround(effect: Effect, ground: ColorRgba): Effect {
  const terminal = new TerminalTheme(
    ground,
    ASSUMED_TERMINAL.foregroundColor,
    ASSUMED_TERMINAL.ansiColors,
    ASSUMED_TERMINAL.palette,
  );
  return (drawn) => effect({ ...drawn, theme: terminal });
}

// [LAW:one-source-of-truth] A loop on a bar measures the ROW — its cells'
// extent places a shimmer's band and spaces sparkle's fireflies — and paints
// only the colours it is confined to. rich-js `confined` also narrows the cells
// it hands the effect, so the bar's effect around a placement at a row's edge
// would be measured on a shorter row and every cell following the bar would
// move by the setting. The narrowing keeps deciding which colours are painted;
// the loop is handed the row's frame.
function paintedOn(effect: Effect, owners: readonly object[]): Effect {
  return (row) => confined(() => effect(row), ...owners)(row);
}

// FNV-1a over a string, as a fraction in [0, 1): where an element sits in an
// effect's noise, so two sessions' bars — and two rows of one bar — do not move
// in lockstep.
function noiseOffset(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

// How far apart in the noise two elements' `z` may land: wide enough that two
// rows of one bar and two sessions' bars are unrelated stretches of it.
const NOISE_DEPTH = 4096;

// [LAW:one-source-of-truth] An idle period's flash (`CLOSING_FLASH`) as one
// animation of what a menu row's cells are drawn in, from the idle period's
// start: dark, as drawn, until the flash `begins` seconds in, then its holds —
// lit, every cell in the flash's fill and text (a cap keeps the terminal's side
// and wears the fill, as it wore the cell it caps), and dark. Held between
// turns, so a host draws a new frame only when one turns — the first lit hold
// included — and never after the last.
function closingFlash(
  fill: ColorRgba,
  text: ColorRgba,
  begins: number,
): Effect {
  const lit: CellFrame = (look, { terminal }) => ({
    ...look,
    bg: terminal.bg ? look.bg : fill,
    fg: terminal.fg ? look.fg : terminal.bg ? fill : text,
  });
  const dark: CellFrame = (colors) => colors;
  const holds = CLOSING_FLASH.reduceRight<Animation<CellFrame>>(
    (after, { lit: on, seconds }) =>
      Animation.sequence(Animation.constant(on ? lit : dark), seconds, after),
    Animation.constant(dark),
  );
  const idle = Animation.sequence(Animation.constant(dark), begins, holds);
  return () => idle;
}

/**
 * [LAW:no-shared-mutable-globals] One session's effect memory, owned by whoever
 * keeps the session (the daemon, per session id; a compile-only render, for the
 * one render it draws). Its only writer is `motion`, called once per render.
 */
export class SessionEffects<Line> {
  // [LAW:no-ambient-temporal-coupling] The instant the resolved effect last
  // changed to its current value: the effect's own t = 0 is a recorded fact,
  // never inferred from when renders happened to arrive.
  private inForce: InForce | null = null;
  // [LAW:no-ambient-temporal-coupling] The session's animation timeline as
  // its last drawn frame left it — where the clock stood and the speed it ran
  // at from there: the anchor every later reading is measured from, so a
  // change of speed changes the clock's slope from the frame it lands in and
  // never its reading, so no loop jumps phase. The host clock itself before
  // the session's first frame.
  private anchor: Timeline = Timeline.play(0);
  // The same fact for each placement wearing its own effect, by placement id,
  // kept for the placements the latest render drew: one that stopped being
  // drawn starts its effect again at t = 0 when it is drawn again, as the
  // effect comes into force for it again.
  private placements = new Map<string, InForce>();
  // The effects made for the rows the latest render drew, by row and scope (the
  // bar's, or one placement's), with the name each was made for. Each render
  // starts an empty map and keeps only what it draws, so a row that stopped
  // being drawn (a menu closed) takes its effects and their settled shares with
  // it.
  private made = new Map<string, Map<Scope, RowEffect>>();
  // The transitions in flight at the last frame drawn, by placement — what a
  // placement's appearing and leaving go on from when the next frame is drawn
  // from the same source as the view's record of it (`FrameRecord`) — or
  // null: no frame drawn, or the last drawn with transitions off, which
  // nothing compares against.
  private passages: ReadonlyMap<string, Passage> | null = null;
  // [LAW:nothing-unseen] What the latest render wore, for the render's event.
  private frame: EffectFrame = {
    effect: EFFECT_FLOOR,
    t: 0,
    speed: 1,
    made: 0,
    reused: 0,
    own: [],
    basis: "off",
    revision: 0,
    fades: [],
    leaves: [],
  };

  constructor(private readonly key: string) {}

  // The latest render's effects: the bar's, at what t, how many of its rows'
  // effects were made fresh rather than reused — one made every frame pays
  // rich-js's share settling every frame — and each placement's own.
  lastFrame(): EffectFrame {
    return this.frame;
  }

  // The effects this session holds: the ones its latest render drew, and the
  // transitions still in flight.
  get heldCount(): number {
    const passing = this.passages?.size ?? 0;
    return [...this.made.values()].reduce((n, row) => n + row.size, passing);
  }

  /**
   * The session's animation clock read at the wall instant `at`, running at
   * `speed` from it on (`Timeline.withRate`: no jump at `at`). The time since
   * the last drawn frame passed at the speed in force then; before the first
   * frame the timeline is the host clock itself, so a session that has only
   * ever run at 1x reads the wall instant at every frame. Reads only: the frame
   * that draws keeps it as the anchor (`drawn`).
   */
  clockAt(at: Instant, speed: number): FrameClock {
    return { wall: at, timeline: Timeline.withRate(this.anchor, at, speed) };
  }

  /**
   * The motion of each row of a render drawn at `clock` whose bar wears `name`,
   * given the row's strip items. Records an effect coming into force — the
   * bar's, or a placement's — when it differs from the last render's, so every
   * catalogue effect starts calm at its t = 0: pulse at rest, shimmer entering
   * from off the row, wheel at the theme's own hues. Records every placement
   * the render draws, fades in each one the last frame did not, and dissolves
   * out each one the last frame drew and this one does not. All of it is kept
   * once the frame is `drawn`.
   */
  motion(
    name: EffectName,
    clock: FrameClock,
    given: FrameTransitions<Line>,
    flash: MenuFlash = null,
  ): FrameMotion<Line> {
    // Every animation of the frame reads the animation clock: `at` is the
    // time it reads, and every `since` is a reading of the same clock.
    const at = animationAt(clock);
    // [LAW:one-source-of-truth] A part `t` seconds into its own clock at this
    // frame counts on the session's timeline, sought so it reads `t` at the
    // frame's instant: it moves at the session's speed, and says when it next
    // changes on the host clock.
    const onSession = (t: number): Timeline =>
      Timeline.seek(clock.timeline, clock.wall, t);
    const inForce =
      this.inForce?.name === name ? this.inForce : { name, since: at };
    const bar: Omit<Part, "owners"> = {
      scope: BAR_SCOPE,
      name,
      t: at - inForce.since,
    };
    const knownPlacements = this.placements;
    const placements = new Map<string, InForce>();
    const known = this.made;
    const made = new Map<string, Map<Scope, RowEffect>>();
    const own: OwnEffectFrame[] = [];
    const { last } = given;
    const inFlight = this.passages;
    // [LAW:dataflow-not-control-flow] What this frame compares against is a
    // value: the last frame's placements, or none to compare at all.
    const basis: FadeBasis = !given.transitions
      ? "off"
      : inFlight !== null && last !== null
        ? "compared"
        : "fresh";
    // [LAW:one-source-of-truth] What a placement last drew is the view's
    // record; what it was passing through then is this memory's.
    const before =
      basis === "compared"
        ? (id: string): Placed<Line> | undefined => {
            const record = last!.placements.get(id);
            return record?.kind === "drew"
              ? {
                  drawing: record.drawing,
                  passage: inFlight!.get(id) ?? null,
                }
              : undefined;
          }
        : null;
    const reachedIds = new Set<string>();
    const passages = new Map<string, Passage>();
    const fading: PassageFrame[] = [];
    const leaving: PassageFrame[] = [];
    const frame = {
      effect: name,
      t: bar.t,
      speed: clock.timeline.rate,
      made: 0,
      reused: 0,
      own,
      basis,
      revision: given.source.revision,
      fades: fading,
      leaves: leaving,
    };

    // A transition beginning at this render's instant for the placement `id`
    // drew, veiling toward the ground it drew on.
    const begin = (
      transition: TransitionName,
      id: string,
      { ground }: Drawing<Line>,
    ): Passage => {
      const begun = EFFECT_CATALOGUE.transitions[transition]({
        z: noiseOffset(`${this.key}@${id}`) * NOISE_DEPTH,
      });
      return {
        name: transition,
        since: at,
        done: (t) => begun.done(t),
        effect: fromGround(begun.effect, ground),
      };
    };
    const over = ({ since, done }: Passage): boolean => done(at - since);

    // [LAW:types-are-the-program] What a placement passes through in this
    // frame, settled once, where the walk reaches it. One drawn now fades in
    // when the frame compared against did not draw it — or drew it leaving —
    // and keeps fading until its fade is over. One that draws nothing and was
    // drawn in that frame leaves now, holding what it drew there; one already
    // leaving keeps leaving, its held lines unchanged, until its dissolve is
    // over, when it is gone.
    const shown = (
      id: string,
      drawing: Drawing<Line>,
      last: Placed<Line> | undefined,
    ): Placed<Line> => ({
      drawing,
      passage:
        before === null
          ? null
          : last === undefined || last.passage?.name === "dissolve"
            ? begin("fade", id, drawing)
            : last.passage !== null && !over(last.passage)
              ? last.passage
              : null,
    });
    const gone = (
      id: string,
      last: Placed<Line> | undefined,
    ): Placed<Line> | undefined => {
      // A placement that held nothing — it laid no row of its own, or went
      // with what it opened — has nothing to replay, so it is simply gone.
      if (
        last === undefined ||
        last.drawing.opened ||
        last.drawing.own.length === 0
      )
        return undefined;
      if (last.passage?.name === "dissolve")
        return over(last.passage) ? undefined : last;
      const held = { ...last.drawing, own: last.drawing.own.map(given.hold) };
      return { drawing: held, passage: begin("dissolve", id, held) };
    };
    // [LAW:single-enforcer] One placement, one passage per frame: the walk
    // reaches each placement once, and an id reached twice would settle two
    // passages under one name, the second overwriting the first.
    const reached = (id: string, lines: readonly Line[]): readonly Line[] => {
      if (reachedIds.has(id))
        throw new Error(`placement "${id}" was reached twice in one frame`);
      reachedIds.add(id);
      const last = before?.(id);
      const { drawing, deeper } = given.returned(id, lines);
      const now = drawing === null ? gone(id, last) : shown(id, drawing, last);
      if (now === undefined) return lines;
      if (now.passage !== null) {
        passages.set(id, now.passage);
        (now.passage.name === "fade" ? fading : leaving).push({
          placement: id,
          t: at - now.passage.since,
        });
      }
      return drawing === null ? [...now.drawing.own, ...deeper] : lines;
    };

    const ownPart = (
      placement: string,
      name: EffectName,
    ): Omit<Part, "owners"> => {
      const last = placements.get(placement) ?? knownPlacements.get(placement);
      const since = last?.name === name ? last : { name, since: at };
      const t = at - since.since;
      if (!placements.has(placement)) {
        placements.set(placement, since);
        own.push({ placement, effect: name, t });
      }
      return { scope: placement, name, t };
    };
    // The effect a moving part's cells are drawn under, made once per row and
    // scope: every cell following the bar shares the bar's.
    const effectOf = (rowKey: string, part: Moving<Part>): Effect => {
      const row = made.get(rowKey) ?? new Map<Scope, RowEffect>();
      made.set(rowKey, row);
      const current = row.get(part.scope);
      if (current !== undefined) return current.effect;
      const last = known.get(rowKey)?.get(part.scope);
      const reuse = last?.name === part.name;
      // [LAW:one-source-of-truth] The bar's noise offset is its row's, as it
      // was before any placement wore its own, so a cell following the bar
      // draws the bytes it always drew.
      const z = noiseOffset(
        part.scope === BAR_SCOPE ? rowKey : `${rowKey}@${part.scope}`,
      );
      const effect = reuse
        ? last.effect
        : EFFECT_CATALOGUE.loops[part.name]({ z: z * NOISE_DEPTH });
      frame[reuse ? "reused" : "made"]++;
      row.set(part.scope, { name: part.name, effect });
      return effect;
    };

    // [LAW:one-type-per-behavior] A row's parts by scope: each effect the row
    // wears, once, confined to every item wearing it.
    const byScope = (items: readonly RowItem[]): Part[] => {
      const parts = new Map<Scope, Part & { owners: RichText[] }>();
      for (const { owner, placement } of items) {
        const part =
          placement.effect === FOLLOW_BAR
            ? bar
            : ownPart(placement.id, placement.effect);
        const seen = parts.get(part.scope);
        if (seen === undefined)
          parts.set(part.scope, { ...part, owners: [owner] });
        else seen.owners.push(owner);
      }
      return [...parts.values()];
    };

    // Each placement of a row passing through a transition, confined to its
    // own items: one per placement, drawn over whatever loop lights its cells.
    // With transitions off the walk compared nothing, so nothing passes.
    const passagesOf = (items: readonly RowItem[]): RowPart[] => {
      const byPlacement = new Map<string, RichText[]>();
      for (const { owner, placement } of items) {
        const mine = byPlacement.get(placement.id);
        if (mine === undefined) byPlacement.set(placement.id, [owner]);
        else mine.push(owner);
      }
      return [...byPlacement].flatMap(([id, owners]) => {
        const passage = passages.get(id) ?? null;
        return passage === null
          ? []
          : [
              {
                timeline: onSession(at - passage.since),
                effect: confined(passage.effect, ...owners),
              },
            ];
      });
    };

    // [LAW:dataflow-not-control-flow] A menu row wears the flash for the whole
    // of an idle period, dark until it begins, so the row says when it starts;
    // every other row, and every row while no idle period runs, wears nothing
    // more. The flash counts down to the moment the daemon's timer closes the
    // menus (src/daemon/menu-idle.ts), a moment on the host clock, so it runs
    // there at rate 1 whatever the animation speed.
    const flashPart: RowPart[] =
      flash === null
        ? []
        : [
            {
              timeline: Timeline.play(flash.idleSince),
              effect: closingFlash(
                flash.fill,
                flash.text,
                flashBegins(flash.timeoutS),
              ),
            },
          ];
    const flashing = (kind: RowKind): RowPart[] =>
      kind === "menu" ? flashPart : [];

    const row = (
      rowName: string,
      kind: RowKind,
      items: readonly RowItem[],
    ): RowMotion => {
      // [LAW:dataflow-not-control-flow] Each item is drawn under its own
      // effect or the bar's. rich-js confines an effect to the colours of the
      // items it names and has no complement, so "the bar's everywhere else" is
      // the bar's confined to every item following it; with no item wearing
      // its own, everywhere else is the whole row, and the bar's needs no
      // confining.
      const parts: readonly Part[] = items.some(
        (i) => i.placement.effect !== FOLLOW_BAR,
      )
        ? byScope(items)
        : [{ ...bar, owners: undefined }];
      // `none` is the floor of the effect domain and has no catalogue entry:
      // a part wearing it is drawn as it stands, and a row of such parts with
      // nothing passing through a transition is still — no `Effected` at all,
      // so it draws the bytes it always drew.
      const moving = parts.filter(isMoving);
      const passing = passagesOf(items);
      const flashed = flashing(kind);
      if (moving.length === 0 && passing.length === 0 && flashed.length === 0)
        return STILL;
      const rowKey = `${this.key}#${rowName}`;
      return {
        kind: "moving",
        time: clock.wall,
        wrap: (strip) =>
          new Effected(
            strip,
            together([
              ...moving.map((part) => {
                const effect = effectOf(rowKey, part);
                return {
                  timeline: onSession(part.t),
                  effect:
                    part.owners === undefined
                      ? effect
                      : paintedOn(effect, part.owners),
                };
              }),
              ...passing,
              // Last, so a lit hold is the flash's over whatever a fade
              // veils: the menu is about to close.
              ...flashed,
            ]),
            { key: rowKey, theme: ASSUMED_TERMINAL },
          ),
      };
    };

    return {
      // [LAW:dataflow-not-control-flow] With transitions off nothing is
      // compared or kept, so every placement draws exactly what it returned.
      placed: basis === "off" ? (_id, lines) => lines : reached,
      row,
      drawn: () => {
        this.anchor = clock.timeline;
        this.inForce = inForce;
        this.placements = placements;
        this.made = made;
        // A frame drawn with transitions off is kept as no frame at all:
        // nothing can be compared against it.
        this.passages = basis === "off" ? null : passages;
        this.frame = frame;
      },
    };
  }
}

// The cap on sessions whose effect memory the daemon keeps — the same bound its
// session state keeps, so an idle session's memory goes when its state would.
const MAX_SESSIONS = 256;

/**
 * [LAW:no-shared-mutable-globals] Every session's effect memory, by session id:
 * single owner, hard cap, least-recently-rendered evicted first. A session whose
 * memory was evicted (or a restarted daemon) starts its effect again at t = 0.
 */
export class EffectSessions<Line> {
  private readonly sessions = new Map<string, SessionEffects<Line>>();

  constructor(private readonly maxSessions: number = MAX_SESSIONS) {}

  of(sessionId: string): SessionEffects<Line> {
    const known =
      this.sessions.get(sessionId) ?? new SessionEffects<Line>(sessionId);
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, known);
    for (const oldest of this.sessions.keys()) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(oldest);
    }
    return known;
  }

  // [LAW:nothing-unseen] What this memory holds, for the daemon's stats: every
  // effect made for a row keeps rich-js's settled shares, so their count is the
  // size that grows.
  getStats(): { sessions: number; effects: number } {
    let effects = 0;
    for (const session of this.sessions.values()) effects += session.heldCount;
    return { sessions: this.sessions.size, effects };
  }
}
