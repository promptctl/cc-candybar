import type { Drawing } from "../config/lanes.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import type { DrawnFrame } from "../dsl/render.js";
import { SessionEffects } from "../render/effect.js";
import type { RichText } from "@promptctl/rich-js";
import type { EffectId } from "../renderer-interface/interface.js";
import { KEPT_FAULTS } from "../renderer-interface/noted-faults.js";
import {
  idleAfterDraw,
  MenuIdle,
  type DrawnMenu,
  type Idle,
} from "./menu-idle.js";
import {
  combinedWarnings,
  warningChanges,
  type FrameWarnings,
} from "./render-warnings.js";

export type DrawSurface = Drawing["by"];
const SURFACES: readonly DrawSurface[] = ["request", "feed"];
const MAX_SESSIONS = 256;

export interface FrameLayout {
  readonly record: DrawnFrame["memory"]["record"];
  readonly segments: ReadonlyMap<string, readonly RichText[]>;
}

// [LAW:types-are-the-program] The immutable observations one draw produces.
// The renderer only keeps this value when the host confirms its presentation.
export interface FrameObservation {
  readonly layout: FrameLayout;
  readonly motion: DrawnFrame["memory"]["motion"];
  readonly diagnostics: FrameWarnings;
  readonly copies: ReadonlyMap<string, string>;
  readonly menu: DrawnMenu;
  readonly config: symbol;
}

export interface FrameCandidate {
  readonly session: SessionId;
  readonly by: DrawSurface;
  readonly target: symbol;
  readonly frame: FrameObservation;
}

interface AcceptedFrame extends Omit<
  FrameObservation,
  "layout" | "copies" | "motion" | "menu"
> {
  readonly id: EffectId;
  readonly target: symbol;
  // Once its view retires, keep presentation facts that do not hold a layout.
  readonly layout: FrameLayout | null;
  readonly copies: FrameObservation["copies"] | null;
}

interface SessionFrames {
  readonly surfaces: Partial<Record<DrawSurface, AcceptedFrame>>;
  readonly motion?: FrameObservation["motion"];
  readonly idle?: Idle;
}

const latestOf = ({ surfaces: { request, feed } }: SessionFrames) =>
  request !== undefined && (feed === undefined || request.id > feed.id)
    ? request
    : feed;

export interface Acceptance {
  readonly faults: string | null;
}

// [LAW:single-enforcer] These are the renderer's accepted frame values.
// Surface identities isolate layout while draw order gives the session one
// animation and idle timeline. Updating either commits one session record.
export class PresentedFrames {
  private readonly sessions = new Map<SessionId, SessionFrames>();
  private readonly configs = new WeakMap<object, symbol>();

  readonly menuIdle = new MenuIdle({
    get: (session) => this.sessions.get(session)?.idle,
    set: (session, idle) => {
      const prior = this.sessions.get(session) ?? { surfaces: {} };
      this.store(session, { ...prior, idle });
    },
    delete: (session) => {
      const prior = this.sessions.get(session);
      if (prior !== undefined)
        this.sessions.set(session, { ...prior, idle: undefined });
    },
    entries: () => this.idleEntries(),
  });

  constructor(
    private readonly evicted: (session: SessionId) => void = () => {},
    private readonly maxSessions = MAX_SESSIONS,
  ) {}

  private *idleEntries(): Iterable<readonly [SessionId, Idle]> {
    // A click/expiry changes the existing key in place during iteration.
    for (const [session, { idle }] of this.sessions)
      if (idle !== undefined) yield [session, idle];
  }

  private store(session: SessionId, value: SessionFrames): void {
    if (this.sessions.has(session)) {
      this.sessions.set(session, value);
      return;
    }
    this.sessions.set(session, value);
    for (const oldest of this.sessions.keys()) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(oldest);
      // [LAW:no-ambient-temporal-coupling] Losing the predecessor also
      // retires the old targets, so a pending older draw cannot repopulate it.
      this.evicted(oldest);
    }
  }

  // [LAW:no-shared-mutable-globals] The token identifies a config without
  // holding that config alive once its view's layout has retired.
  configOf(config: object): symbol {
    const held = this.configs.get(config);
    if (held !== undefined) return held;
    const token = Symbol();
    this.configs.set(config, token);
    return token;
  }

  accept(
    id: EffectId,
    { session, by, target, frame }: FrameCandidate,
  ): Acceptance | null {
    const prior = this.sessions.get(session) ?? { surfaces: {} };
    const previous = prior.surfaces[by];
    if (previous !== undefined && id <= previous.id) return null;
    const latest = latestOf(prior);
    const { motion, menu, ...surface } = frame;
    const next: AcceptedFrame = { ...surface, id, target };
    const newer = latest === undefined || id > latest.id;
    const change = warningChanges(surface.diagnostics, previous?.diagnostics);
    this.sessions.delete(session);
    this.store(session, {
      surfaces: { ...prior.surfaces, [by]: next },
      // [LAW:one-source-of-truth] Keep one motion cache, even when both
      // surfaces retain their layout. An older receipt cannot rewind it.
      motion: newer ? motion : prior.motion,
      idle: newer ? idleAfterDraw(prior.idle, menu) : prior.idle,
    });
    return { faults: change.faults === KEPT_FAULTS ? null : change.faults };
  }

  private on(session: SessionId, by: DrawSurface): AcceptedFrame | undefined {
    return this.sessions.get(session)?.surfaces[by];
  }

  layout(
    session: SessionId,
    by: DrawSurface,
    target: symbol,
  ): FrameLayout | undefined {
    const held = this.on(session, by);
    return held?.target === target ? (held.layout ?? undefined) : undefined;
  }

  diagnostics(session: SessionId, by: DrawSurface): FrameWarnings | undefined {
    return this.on(session, by)?.diagnostics;
  }

  warnings(session: SessionId, by: DrawSurface, config: symbol) {
    return combinedWarnings(
      SURFACES.flatMap((surface) => {
        const held = this.on(session, surface);
        return held !== undefined && (surface === by || held.config === config)
          ? [held.diagnostics]
          : [];
      }),
    );
  }

  effects(session: SessionId): SessionEffects<RenderedLine> {
    return new SessionEffects(session, this.sessions.get(session)?.motion);
  }

  copy(session: SessionId, by: DrawSurface, key: string): string | undefined {
    return this.on(session, by)?.copies?.get(key);
  }

  retireView(
    session: SessionId,
    targets: Readonly<Record<DrawSurface, symbol>>,
    successor: boolean,
  ): void {
    const prior = this.sessions.get(session);
    if (prior === undefined) return;
    const surfaces = { ...prior.surfaces };
    for (const by of SURFACES) {
      const held = surfaces[by];
      if (held === undefined || (successor && held.target !== targets[by]))
        continue;
      surfaces[by] = {
        ...held,
        layout: null,
        copies: successor ? held.copies : null,
      };
    }
    this.sessions.set(session, { ...prior, surfaces });
  }

  stopDrawing(session: SessionId, by: DrawSurface): void {
    const prior = this.sessions.get(session);
    const held = prior?.surfaces[by];
    if (prior === undefined || held === undefined) return;
    this.sessions.set(session, {
      ...prior,
      surfaces: {
        ...prior.surfaces,
        [by]: { ...held, layout: null, copies: null },
      },
    });
  }

  retire(session: SessionId): void {
    this.sessions.delete(session);
  }

  stats(): {
    readonly effects: { sessions: number; effects: number };
    readonly passages: number;
  } {
    let sessions = 0;
    let effects = 0;
    let passages = 0;
    for (const held of this.sessions.values()) {
      if (held.motion !== undefined) {
        sessions++;
        for (const effectsOfRow of held.motion.made.values())
          effects += effectsOfRow.size;
      }
      for (const by of SURFACES)
        passages += held.surfaces[by]?.layout?.record.passages?.size ?? 0;
    }
    return { effects: { sessions, effects }, passages };
  }
}
