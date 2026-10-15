// The looping effect a session's bar wears, row by row (brandon-effects-2gka.d2i).
//
// rich-js owns the effects themselves (`EFFECT_CATALOGUE.loops`, `Effected`):
// pure functions of a time `t` and the colours a frame draws. This module owns
// the two facts about a SESSION those functions need and cannot know — when the
// session's effect came into force, which is the effect's own t = 0, and the
// effect objects already made for its rows, which rich-js reuses a frame's
// settled shares on only when it is handed the same object again.

import {
  DEFAULT_TERMINAL_THEME,
  EFFECT_CATALOGUE,
  Effected,
  type Effect,
  type Renderable,
} from "@promptctl/rich-js";

import { EFFECT_FLOOR, type EffectName } from "../themes/policy.js";
import type { Instant } from "../utils/instant.js";

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

// One render's effect, as its event reports it.
export interface EffectFrame {
  readonly effect: EffectName;
  // Seconds since the effect came into force: the effect's own clock.
  readonly t: number;
  // Rows whose effect was made this render, and rows that reused last frame's.
  readonly made: number;
  readonly reused: number;
}

// [LAW:one-source-of-truth] The terminal an effect measures and writes against
// is the one rich-js assumes when a terminal names none — the assumption every
// contrast floor in this repo makes, because the detached daemon cannot see the
// client's terminal. `DEFAULT_TERMINAL_THEME` is that terminal's exported face
// (black ground, white text, the VGA sixteen); test/row-effect.test.ts holds it
// to the colours rich-js resolves for an unnamed terminal.
const ASSUMED_TERMINAL = DEFAULT_TERMINAL_THEME;

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
  private inForce: {
    readonly name: EffectName;
    readonly since: Instant;
  } | null = null;
  // The effect made for each row, with the span it was made for. A row whose
  // span changes gets a new one; the effect's clock does not restart.
  private readonly rows = new Map<
    number,
    { readonly span: number; readonly effect: Effect }
  >();
  // [LAW:nothing-unseen] What the latest render wore, for the render's event.
  private frame: EffectFrame = {
    effect: EFFECT_FLOOR,
    t: 0,
    made: 0,
    reused: 0,
  };

  constructor(private readonly key: string) {}

  // The latest render's effect: which one, at what t, and how many of its rows'
  // effects were made fresh rather than reused — a row made every frame pays
  // rich-js's share settling every frame.
  lastFrame(): EffectFrame {
    return this.frame;
  }

  /**
   * The motion of each row of a render drawn at `at` wearing `name`. Records
   * `name` coming into force when it differs from the last render's, so every
   * catalogue effect starts calm at its t = 0 — pulse at rest, shimmer entering
   * from off the row, wheel at the theme's own hues.
   */
  motion(name: EffectName, at: Instant): (row: number) => RowMotion {
    if (this.inForce?.name !== name) {
      this.inForce = { name, since: at };
      this.rows.clear();
    }
    const t = at - this.inForce.since;
    const frame = { effect: name, t, made: 0, reused: 0 };
    this.frame = frame;
    // [LAW:dataflow-not-control-flow] The domain's own discriminator: `none` is
    // the floor of the effect domain and has no catalogue entry, so its rows
    // are still; every other name is a loop the catalogue makes.
    if (name === EFFECT_FLOOR) return () => STILL;
    const make = EFFECT_CATALOGUE.loops[name];
    return (row) => ({
      kind: "moving",
      wrap: (strip, span) => {
        const rowKey = `${this.key}#${row}`;
        const known = this.rows.get(row);
        const reuse = known?.span === span;
        const effect = reuse
          ? known.effect
          : make({ span, z: noiseOffset(rowKey) * NOISE_DEPTH });
        frame[reuse ? "reused" : "made"]++;
        this.rows.set(row, { span, effect });
        return new Effected(strip, effect, {
          t,
          key: rowKey,
          theme: ASSUMED_TERMINAL,
        });
      },
    });
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
}
