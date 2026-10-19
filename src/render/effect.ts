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
  type Transition,
  type TransitionName,
} from "@promptctl/rich-js";

import {
  EFFECT_FLOOR,
  FOLLOW_BAR,
  type EffectName,
  type PlacementEffect,
} from "../themes/policy.js";
import type { Instant } from "../utils/instant.js";

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

// What a frame is drawn from. A placement appears only between two frames
// drawn from the same config — one object per load, so a reload is another —
// the same preset, the same revision of the session's state
// (`SessionStateReader.revision`), so whatever a write to it reveals — a
// click opening a menu, leaving arrange mode, an undo — shows at once, and the
// same width, which a row held from the last frame was sized for. Not the
// palette: a rule-chosen theme or style moves on the very payload that hides a
// placement, and a held row keeps the colours it was drawn in as it dissolves.
export interface FrameSource {
  readonly config: object;
  readonly preset: string;
  readonly revision: number;
  readonly width: number;
}

// What one render asks of its transitions: whether placements pass through
// them at all (globals.transitions), what the frame is drawn from, how the
// lines a placement returned divide (`Returned`), and how a placement that
// leaves replays one of its rows.
export interface FrameTransitions<Line> {
  readonly transitions: boolean;
  readonly source: FrameSource;
  readonly returned: (id: string, lines: readonly Line[]) => Returned<Line>;
  readonly hold: (line: Line) => Line;
}

// [LAW:types-are-the-program] The lines a placement returned, divided: what
// it drew of its own, and the lines of deeper bands hung under it — a menu it
// dropped, a body it opened — which are never held. While it leaves, its held
// rows take the place of its own rows (one that renders empty still returns an
// empty one), and only the deeper lines are drawn beside them.
export interface Returned<Line> {
  readonly drawing: Drawing<Line> | null;
  readonly deeper: readonly Line[];
}

// [LAW:types-are-the-program] What a placement drew in one frame, or nothing
// when it laid no cell: the rows it would replay leaving — its own, or none
// when a menu it dropped or a body it opened hangs under them, since it goes
// at once with what it opened rather than leaving an open trigger over nothing
// — and the ground it fades in from and dissolves into
// (`CellPlacement.ground`).
export interface Drawing<Line> {
  readonly own: readonly Line[];
  readonly ground: ColorRgba;
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
  readonly row: (row: string, items: readonly RowItem[]) => RowMotion;
  readonly drawn: () => void;
}

// [LAW:types-are-the-program] What one row is drawn under: nothing, or an
// effect made for the row. A still row has no
// `Effected` around it at all, so `none` draws exactly the bytes it always drew.
export type RowMotion =
  | { readonly kind: "still" }
  | {
      readonly kind: "moving";
      readonly wrap: (strip: Renderable) => Renderable;
    };

export const STILL: RowMotion = { kind: "still" };

// An effect made for one row — the bar's, or one placement's on that row — and
// the name it was made for.
interface RowEffect {
  readonly name: EffectName;
  readonly effect: Effect;
}

// When an effect came into force: its own t = 0.
interface InForce {
  readonly name: EffectName;
  readonly since: Instant;
}

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

// Whether anything the frame drew moves: the bar's effect, a placement's own,
// or a placement fading in or dissolving out. A frame that moves differs from
// the next one at any instant; one that does not changes only when its data
// does.
export function frameMoves(frame: EffectFrame): boolean {
  return (
    frame.effect !== EFFECT_FLOOR ||
    frame.own.some((o) => o.effect !== EFFECT_FLOOR) ||
    frame.fades.length > 0 ||
    frame.leaves.length > 0
  );
}

// A placement passing through a transition: a `fade` in as it appears, a
// `dissolve` out as it leaves. Since the instant it began, its own t = 0, made
// once from the placement's ground — rich-js keeps each cell's place in it.
interface Passage {
  readonly name: TransitionName;
  readonly since: Instant;
  readonly transition: Transition;
}

// A placement the frame drew — for one leaving, what it held of its last
// drawing — and the transition it is passing through, or none.
interface Placed<Line> {
  readonly drawing: Drawing<Line>;
  readonly passage: Passage | null;
}

// The last frame, as the next one compares against it: what it was drawn from,
// and each placement it drew.
interface DrawnFrame<Line> {
  readonly source: FrameSource;
  readonly placements: Map<string, Placed<Line>>;
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
// `drawn` and run on the row's clock, `rowT` being its own `t` — a part `t`
// seconds into its own clock at `rowT` began at `rowT - t` — then the frames
// fold over the cell in the order given. The loops are confined to disjoint
// items, so at most one of them moves any one colour; a transition is confined
// to its placement's items, which a loop may light too, and comes after the
// loops so it veils the lit colours — the order is the meaning. Composed with
// `Animation.all`, the row changes when the soonest of its parts does, so a row
// whose parts all hold still says so.
function together(
  rowT: number,
  parts: ReadonlyArray<{ t: number; effect: Effect }>,
): Effect {
  return (drawn) =>
    Animation.map(
      Animation.all(
        parts.map(({ t, effect }) =>
          Timeline.run(Timeline.play(rowT - t), effect(drawn)),
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
  // The last frame drawn, which a placement's appearing and leaving are
  // measured against when the next is drawn from the same source; none before
  // the session's first.
  private drawn: DrawnFrame<Line> | null = null;
  // [LAW:nothing-unseen] What the latest render wore, for the render's event.
  private frame: EffectFrame = {
    effect: EFFECT_FLOOR,
    t: 0,
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
    const passing = [...(this.drawn?.placements.values() ?? [])].filter(
      ({ passage }) => passage !== null,
    ).length;
    return [...this.made.values()].reduce((n, row) => n + row.size, passing);
  }

  /**
   * The motion of each row of a render drawn at `at` whose bar wears `name`,
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
    at: Instant,
    given: FrameTransitions<Line>,
  ): FrameMotion<Line> {
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
    const last = this.drawn;
    // [LAW:dataflow-not-control-flow] What this frame compares against is a
    // value: the last frame's placements, or none to compare at all.
    const basis: FadeBasis = !given.transitions
      ? "off"
      : last !== null &&
          last.source.config === given.source.config &&
          last.source.preset === given.source.preset &&
          last.source.revision === given.source.revision &&
          last.source.width === given.source.width
        ? "compared"
        : "fresh";
    const before = basis === "compared" ? last!.placements : null;
    const placed = new Map<string, Placed<Line>>();
    const fading: PassageFrame[] = [];
    const leaving: PassageFrame[] = [];
    const frame = {
      effect: name,
      t: bar.t,
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
      const made = EFFECT_CATALOGUE.transitions[transition]({
        z: noiseOffset(`${this.key}@${id}`) * NOISE_DEPTH,
      });
      return {
        name: transition,
        since: at,
        transition: {
          effect: fromGround(made.effect, ground),
          done: (t) => made.done(t),
        },
      };
    };
    const over = ({ since, transition }: Passage): boolean =>
      transition.done(at - since);

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
      if (last === undefined || last.drawing.own.length === 0) return undefined;
      if (last.passage?.name === "dissolve")
        return over(last.passage) ? undefined : last;
      const held = { ...last.drawing, own: last.drawing.own.map(given.hold) };
      return { drawing: held, passage: begin("dissolve", id, held) };
    };
    // [LAW:single-enforcer] One placement, one passage per frame: the walk
    // reaches each placement once, and an id reached twice would settle two
    // passages under one name, the second overwriting the first.
    const reached = (id: string, lines: readonly Line[]): readonly Line[] => {
      if (placed.has(id))
        throw new Error(`placement "${id}" was reached twice in one frame`);
      const last = before?.get(id);
      const { drawing, deeper } = given.returned(id, lines);
      const now = drawing === null ? gone(id, last) : shown(id, drawing, last);
      if (now === undefined) return lines;
      placed.set(id, now);
      if (now.passage !== null)
        (now.passage.name === "fade" ? fading : leaving).push({
          placement: id,
          t: at - now.passage.since,
        });
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
    const passagesOf = (
      items: readonly RowItem[],
    ): Array<{ t: number; effect: Effect }> => {
      const byPlacement = new Map<string, RichText[]>();
      for (const { owner, placement } of items) {
        const mine = byPlacement.get(placement.id);
        if (mine === undefined) byPlacement.set(placement.id, [owner]);
        else mine.push(owner);
      }
      return [...byPlacement].flatMap(([id, owners]) => {
        const passage = placed.get(id)?.passage ?? null;
        return passage === null
          ? []
          : [
              {
                t: at - passage.since,
                effect: confined(passage.transition.effect, ...owners),
              },
            ];
      });
    };

    const row = (rowName: string, items: readonly RowItem[]): RowMotion => {
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
      if (moving.length === 0 && passing.length === 0) return STILL;
      const rowKey = `${this.key}#${rowName}`;
      return {
        kind: "moving",
        wrap: (strip) =>
          new Effected(
            strip,
            together(bar.t, [
              ...moving.map((part) => {
                const effect = effectOf(rowKey, part);
                return {
                  t: part.t,
                  effect:
                    part.owners === undefined
                      ? effect
                      : paintedOn(effect, part.owners),
                };
              }),
              ...passing,
            ]),
            { t: bar.t, key: rowKey, theme: ASSUMED_TERMINAL },
          ),
      };
    };

    return {
      // [LAW:dataflow-not-control-flow] With transitions off nothing is
      // compared or kept, so every placement draws exactly what it returned.
      placed: basis === "off" ? (_id, lines) => lines : reached,
      row,
      drawn: () => {
        this.inForce = inForce;
        this.placements = placements;
        this.made = made;
        // A frame drawn with transitions off is kept as no frame at all:
        // nothing can be compared against it.
        this.drawn =
          basis === "off" ? null : { source: given.source, placements: placed };
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
