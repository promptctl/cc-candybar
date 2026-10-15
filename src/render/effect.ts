// The effects a session's bar wears, row by row: the bar's own loop
// (brandon-effects-2gka.d2i), each placement's that sets one
// (brandon-effects-2gka.bm1), and the fade a placement wears when it appears
// (brandon-effects-2gka.631).
//
// rich-js owns the effects themselves (`EFFECT_CATALOGUE`, `Effected`,
// `confined`): pure functions of a time `t` and the colours a frame draws. This
// module owns the facts about a SESSION those functions need and cannot know —
// when each effect came into force, which is that effect's own t = 0, the
// effect objects already made for its rows, which rich-js reuses a frame's
// settled shares on only when it is handed the same object again, and which
// placements the last frame drew, which is what makes a placement appear.

import {
  DEFAULT_TERMINAL_THEME,
  EFFECT_CATALOGUE,
  Effected,
  TerminalTheme,
  confined,
  type ColorRgba,
  type Effect,
  type LoopName,
  type Renderable,
  type RichText,
  type Transition,
} from "@promptctl/rich-js";

import {
  EFFECT_FLOOR,
  FOLLOW_BAR,
  type EffectName,
  type PlacementEffect,
} from "../themes/policy.js";
import type { Instant } from "../utils/instant.js";

// [LAW:types-are-the-program] The placement a laid cell belongs to and its
// `effect` setting: what a laid cell demands of its row (`LaidCell.placement`).
// Its id keys the clock of the placement's own effect and of its fade; its
// effect is the bar's (`FOLLOW_BAR`) or its own — `none` included, a still cell
// on a moving bar.
export interface CellPlacement {
  readonly id: string;
  readonly effect: PlacementEffect;
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
// and the same preset.
export interface FrameSource {
  readonly config: object;
  readonly preset: string;
}

// What one render asks of its fades: whether placements fade in at all
// (globals.transitions), what the frame is drawn from, and the ground a cell
// fades in from.
export interface FrameFades {
  readonly transitions: boolean;
  readonly source: FrameSource;
  readonly ground: ColorRgba;
}

// [LAW:types-are-the-program] What one row is drawn under: nothing, or an
// effect made for the row once the row's span is known. A still row has no
// `Effected` around it at all, so `none` draws exactly the bytes it always drew.
export type RowMotion =
  | { readonly kind: "still" }
  | {
      readonly kind: "moving";
      readonly wrap: (strip: Renderable, span: number) => Renderable;
    };

export const STILL: RowMotion = { kind: "still" };

// An effect made for one row — the bar's, or one placement's on that row — and
// the name and span it was made for.
interface RowEffect {
  readonly name: EffectName;
  readonly span: number;
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

// A placement fading in, on its own clock, as a render's event reports it.
export interface FadeFrame {
  readonly placement: string;
  readonly t: number;
}

// [LAW:types-are-the-program] What a render's placements were compared
// against: nothing, because transitions are off; nothing, because there is no
// earlier frame to compare (the session's first render, or the first after a
// click or a reload settled it — `fresh`); or the last frame (`compared`).
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
  // What the render's placements were compared against, and each one fading in.
  readonly basis: FadeBasis;
  readonly fades: readonly FadeFrame[];
}

// A placement that appeared, fading in: the instant it appeared, its fade's own
// t = 0, and the fade, made once — rich-js keeps each cell's place in it.
interface Arrival {
  readonly since: Instant;
  readonly fade: Transition;
}

// The last frame, as the next one compares against it: what it was drawn from,
// and each placement it drew, fading in or arrived (`null`).
interface DrawnFrame {
  readonly source: FrameSource;
  readonly placements: Map<string, Arrival | null>;
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
// `Effect` an `Effected` takes: every first stage is called with the frame's
// `drawn` at its own t, then the second stages fold over the cell. Each is
// confined to its own items' colours, so for any one colour of a cell at most
// one of them moves it. The `t` the `Effected` passes is not read: no clock
// here is the row's.
function together(parts: ReadonlyArray<{ t: number; effect: Effect }>): Effect {
  return (_t, drawn) => {
    const frames = parts.map(({ t, effect }) => effect(t, drawn));
    return (colors, cell) =>
      frames.reduce((moved, frame) => frame(moved, cell), colors);
  };
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
// client's: a cell fades in from the theme's `background`, the stand-in a
// `bg: "none"` cell's `{{ bgOf }}` answers with. Only the fade sees that
// ground; every contrast the loops measure stays on ASSUMED_TERMINAL.
function fromGround(effect: Effect, ground: ColorRgba): Effect {
  const terminal = new TerminalTheme(
    ground,
    ASSUMED_TERMINAL.foregroundColor,
    ASSUMED_TERMINAL.ansiColors,
    ASSUMED_TERMINAL.palette,
  );
  return (t, drawn) => effect(t, { ...drawn, theme: terminal });
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
export class SessionEffects {
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
  // bar's, or one placement's), with the name and span each was made for. One
  // whose span changes gets a new one; its clock does not restart. Each render
  // starts an empty map and keeps only what it draws, so a row that stopped
  // being drawn (a menu closed) takes its effects and their settled shares with
  // it.
  private made = new Map<string, Map<Scope, RowEffect>>();
  // [LAW:no-ambient-temporal-coupling] The last frame a placement's appearing
  // is measured against, or none: before the session's first render, and once
  // a click or a reload has settled the bar (`settle`, and a frame drawn from
  // another source) — so opening a menu, leaving arrange mode or switching
  // preset shows the new bar at once rather than fading it in.
  private drawn: DrawnFrame | null = null;
  // [LAW:nothing-unseen] What the latest render wore, for the render's event.
  private frame: EffectFrame = {
    effect: EFFECT_FLOOR,
    t: 0,
    made: 0,
    reused: 0,
    own: [],
    basis: "off",
    fades: [],
  };

  constructor(private readonly key: string) {}

  // The latest render's effects: the bar's, at what t, how many of its rows'
  // effects were made fresh rather than reused — one made every frame pays
  // rich-js's share settling every frame — and each placement's own.
  lastFrame(): EffectFrame {
    return this.frame;
  }

  // The effects this session holds: the ones its latest render drew, and the
  // fades still in flight.
  get heldCount(): number {
    const fading = [...(this.drawn?.placements.values() ?? [])].filter(
      (arrival) => arrival !== null,
    ).length;
    return [...this.made.values()].reduce((n, row) => n + row.size, fading);
  }

  // A click wrote this session's state: every fade in flight ends, and the
  // next frame has nothing to compare against.
  settle(): void {
    this.drawn = null;
  }

  /**
   * The motion of each row of a render drawn at `at` whose bar wears `name`,
   * given the row's strip items. Records an effect coming into force — the
   * bar's, or a placement's — when it differs from the last render's, so every
   * catalogue effect starts calm at its t = 0: pulse at rest, shimmer entering
   * from off the row, wheel at the theme's own hues. Records every placement
   * the render draws, and fades in each one the last frame did not.
   */
  motion(
    name: EffectName,
    at: Instant,
    fades: FrameFades,
  ): (row: string, items: readonly RowItem[]) => RowMotion {
    if (this.inForce?.name !== name) this.inForce = { name, since: at };
    const bar: Omit<Part, "owners"> = {
      scope: BAR_SCOPE,
      name,
      t: at - this.inForce.since,
    };
    const knownPlacements = this.placements;
    const placements = new Map<string, InForce>();
    this.placements = placements;
    const known = this.made;
    const made = new Map<string, Map<Scope, RowEffect>>();
    this.made = made;
    const own: OwnEffectFrame[] = [];
    const last = this.drawn;
    // [LAW:dataflow-not-control-flow] What this frame compares against is a
    // value: the last frame's placements, or none to compare at all.
    const basis: FadeBasis = !fades.transitions
      ? "off"
      : last !== null &&
          last.source.config === fades.source.config &&
          last.source.preset === fades.source.preset
        ? "compared"
        : "fresh";
    const before = basis === "compared" ? last!.placements : null;
    const drawn = new Map<string, Arrival | null>();
    this.drawn = { source: fades.source, placements: drawn };
    const fading: FadeFrame[] = [];
    const frame = {
      effect: name,
      t: bar.t,
      made: 0,
      reused: 0,
      own,
      basis,
      fades: fading,
    };
    this.frame = frame;

    // Whether a placement drawn in this frame is fading in, settled once per
    // frame: it appears now when the last frame, compared, did not draw it,
    // and keeps fading until its fade is done, when it has arrived.
    const arrivalOf = (id: string, span: number): Arrival | null => {
      if (drawn.has(id)) return drawn.get(id)!;
      const known =
        before === null
          ? null
          : before.has(id)
            ? before.get(id)!
            : {
                since: at,
                fade: EFFECT_CATALOGUE.transitions.fade({
                  span,
                  z: noiseOffset(`${this.key}@${id}`) * NOISE_DEPTH,
                }),
              };
      const arrival =
        known === null || known.fade.done(at - known.since) ? null : known;
      drawn.set(id, arrival);
      if (arrival !== null)
        fading.push({ placement: id, t: at - arrival.since });
      return arrival;
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
    const effectOf = (
      rowKey: string,
      part: Moving<Part>,
      span: number,
    ): Effect => {
      const row = made.get(rowKey) ?? new Map<Scope, RowEffect>();
      made.set(rowKey, row);
      const current = row.get(part.scope);
      if (current !== undefined) return current.effect;
      const last = known.get(rowKey)?.get(part.scope);
      const reuse = last?.name === part.name && last.span === span;
      // [LAW:one-source-of-truth] The bar's noise offset is its row's, as it
      // was before any placement wore its own, so a cell following the bar
      // draws the bytes it always drew.
      const z = noiseOffset(
        part.scope === BAR_SCOPE ? rowKey : `${rowKey}@${part.scope}`,
      );
      const effect = reuse
        ? last.effect
        : EFFECT_CATALOGUE.loops[part.name]({ span, z: z * NOISE_DEPTH });
      frame[reuse ? "reused" : "made"]++;
      row.set(part.scope, { name: part.name, span, effect });
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

    // Each placement of a row that is fading in, confined to its own items:
    // one fade per placement, drawn over whatever loop lights its cells.
    const fadesOf = (
      items: readonly RowItem[],
    ): Array<{ t: number; effect: Effect }> => {
      const owners = new Map<string, RichText[]>();
      for (const { owner, placement } of items)
        owners.set(placement.id, [...(owners.get(placement.id) ?? []), owner]);
      return [...owners].flatMap(([id, mine]) => {
        const span = mine.reduce((n, item) => n + item.cellLength, 0);
        const arrival = arrivalOf(id, span);
        return arrival === null
          ? []
          : [
              {
                t: at - arrival.since,
                effect: confined(
                  fromGround(arrival.fade.effect, fades.ground),
                  ...mine,
                ),
              },
            ];
      });
    };

    return (row, items) => {
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
      // nothing fading in is still — no `Effected` at all, so it draws the
      // bytes it always drew.
      const moving = parts.filter(isMoving);
      const appearing = fadesOf(items);
      if (moving.length === 0 && appearing.length === 0) return STILL;
      const rowKey = `${this.key}#${row}`;
      return {
        kind: "moving",
        wrap: (strip, span) =>
          new Effected(
            strip,
            together([
              ...moving.map((part) => {
                const effect = effectOf(rowKey, part, span);
                return {
                  t: part.t,
                  effect:
                    part.owners === undefined
                      ? effect
                      : confined(effect, ...part.owners),
                };
              }),
              ...appearing,
            ]),
            { t: bar.t, key: rowKey, theme: ASSUMED_TERMINAL },
          ),
      };
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
export class EffectSessions {
  private readonly sessions = new Map<string, SessionEffects>();

  constructor(private readonly maxSessions: number = MAX_SESSIONS) {}

  of(sessionId: string): SessionEffects {
    const known = this.sessions.get(sessionId) ?? new SessionEffects(sessionId);
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, known);
    for (const oldest of this.sessions.keys()) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(oldest);
    }
    return known;
  }

  // A click wrote this session's state: its bar settles
  // (`SessionEffects.settle`). A session this memory does not hold has drawn no
  // frame to settle.
  settle(sessionId: string): void {
    this.sessions.get(sessionId)?.settle();
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
