import {
  MAX_PRESENTED_SESSIONS,
  proposedValue,
  surfaceAfter,
  motionAfter,
  type DrawSurface,
} from "../renderer-interface/presentation.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import { LANE_NAMES } from "../config/lanes.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import type { DrawnFrame } from "../dsl/render.js";
import {
  CompiledEffects,
  NO_CLOCK,
  NO_EFFECTS,
  SessionEffects,
  holdEffects,
  holdMotion,
  restoreEffects,
} from "../render/effect.js";
import type {
  HeldMotion,
  SessionClock,
  SessionMotion,
  SurfaceEffects,
} from "../render/effect.js";
import { holdLayout, restoreLayout } from "../render/held-layout.js";
import type {
  HeldSurface,
  Ordered,
  PresentationInput,
  PresentedSession,
  ProposedPresentation,
} from "../renderer-interface/presentation.js";
import {
  motionChange,
  surfaceChange,
  proposeValue,
} from "./presentation-change.js";
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
  describeWarning,
  warningChanges,
  type FrameWarnings,
} from "./render-warnings.js";

export type { DrawSurface };

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
}

export interface FrameCandidate {
  readonly session: SessionId;
  readonly surface: DrawSurface;
  readonly target: symbol;
  readonly loadKey: string;
  readonly frame: FrameObservation;
}

interface AcceptedFrame extends Omit<
  FrameObservation,
  "layout" | "copies" | "motion" | "menu"
> {
  readonly order: number;
  readonly target: symbol;
  readonly portable?: Ordered<HeldSurface>;
  // Once its view retires, keep presentation facts that do not hold a layout.
  readonly layout: FrameLayout | null;
  readonly copies: FrameObservation["copies"] | null;
  // What this surface's frame drew under the session's clock.
  readonly effects: SurfaceEffects & Partial<Pick<SessionMotion, "frame">>;
}

interface SessionFrames {
  readonly surfaces: Partial<Record<DrawSurface, AcceptedFrame>>;
  readonly motion?: SessionClock;
  readonly portableMotion?: Ordered<HeldMotion>;
  readonly idle?: Idle;
  readonly idleOrder?: number;
}

// The surface whose frame was accepted last, which the session's shared
// timelines (the animation clock, menu idle) advance with.
const latestOf = (
  surfaces: SessionFrames["surfaces"],
): AcceptedFrame | undefined => {
  let latest: AcceptedFrame | undefined;
  for (const surface of LANE_NAMES) {
    const held = surfaces[surface];
    if (
      held !== undefined &&
      (latest === undefined || held.order > latest.order)
    )
      latest = held;
  }
  return latest;
};

export interface Acceptance {
  readonly faults: string | null;
}

export interface PortableDraw {
  readonly order: number;
  readonly surface: HeldSurface;
  readonly motion: HeldMotion;
}

// [LAW:single-enforcer] These are the renderer's accepted frame values.
// Surface identities isolate layout while draw order gives the session one
// animation and idle timeline. Updating either commits one session record.
export class PresentedFrames {
  private readonly sessions = new Map<SessionId, SessionFrames>();
  private readonly compiled = new CompiledEffects();

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
    private readonly maxSessions = MAX_PRESENTED_SESSIONS,
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

  propose(
    candidate: FrameCandidate,
    input: PresentationInput,
  ): { portable: PortableDraw; proposal: ProposedPresentation } {
    const { session, surface: by, frame, loadKey } = candidate;
    const prior = this.sessions.get(session);
    const bases = input.sessions.find((s) => s.session === session);
    const known = prior?.surfaces[by]?.portable;
    const knownMotion = prior?.portableMotion;
    const surface: HeldSurface = {
      layout: holdLayout(frame.layout.record, loadKey, bases?.revision ?? 0),
      effects: holdEffects(frame.motion),
      copies: [...frame.copies],
      warnings: frame.diagnostics.warnings.map((w) => w.warning),
      faults: frame.diagnostics.faults,
    };
    const motion = holdMotion(frame.motion);
    const surfaceProposal = proposeValue(
      known,
      bases?.bases[by],
      surface,
      surfaceChange,
    );
    const motionProposal = proposeValue(
      knownMotion,
      bases?.motion,
      motion,
      motionChange,
    );
    return {
      portable: {
        order: input.order,
        surface: proposedValue(known, surfaceProposal, surfaceAfter),
        motion: proposedValue(knownMotion, motionProposal, motionAfter),
      },
      proposal: {
        surface: surfaceProposal,
        motion: motionProposal,
        menu: { shown: frame.menu.shown, timeoutS: frame.menu.timeoutS },
      },
    };
  }

  resume(
    saved: PresentedSession,
    view: {
      state: { loadKey: string; config: object };
      presentationTargets: Record<DrawSurface, symbol>;
    },
    revision: number,
    localRevision: number,
  ) {
    const prior = this.sessions.get(saved.session) ?? { surfaces: {} };
    const surfaces = { ...prior.surfaces };
    for (const by of LANE_NAMES) {
      const held = saved.surfaces[by];
      if (!held) {
        if ((surfaces[by]?.order ?? Infinity) <= saved.motion.order)
          delete surfaces[by];
        continue;
      }
      if ((surfaces[by]?.order ?? -1) >= held.order) continue;
      const { layout, effects, copies, warnings, faults } = held.value;
      const record =
        layout.revision === revision
          ? restoreLayout(layout, view.state, localRevision)
          : undefined;
      surfaces[by] = {
        order: held.order,
        portable: held,
        target: view.presentationTargets[by],
        layout: record ? { record, segments: new Map() } : null,
        effects: restoreEffects(effects),
        copies: new Map(copies),
        diagnostics: { warnings: warnings.map(describeWarning), faults },
      };
    }
    const newer = saved.motion.order > (prior.portableMotion?.order ?? -1);
    this.store(saved.session, {
      ...prior,
      surfaces,
      ...(newer && {
        motion: saved.motion.value,
        portableMotion: saved.motion,
      }),
      ...(saved.idle.order > (prior.idleOrder ?? -1) && {
        idle: saved.idle.value,
        idleOrder: saved.idle.order,
      }),
    });
  }

  accept(
    id: EffectId,
    { session, surface: by, target, frame }: FrameCandidate,
    portable?: PortableDraw,
  ): Acceptance | null {
    const prior = this.sessions.get(session) ?? { surfaces: {} };
    const previous = prior.surfaces[by];
    const order = portable?.order ?? id;
    if (previous !== undefined && order <= previous.order) return null;
    const latest = latestOf(prior.surfaces);
    const { motion, menu, ...surface } = frame;
    const next: AcceptedFrame = {
      ...surface,
      order,
      target,
      effects: {
        placements: motion.placements,
        made: motion.made,
        frame: motion.frame,
      },
      ...(portable && { portable: { order, value: portable.surface } }),
    };
    const newer =
      latest === undefined ||
      order > (prior.portableMotion?.order ?? latest.order);
    const change = warningChanges(surface.diagnostics, previous?.diagnostics);
    this.sessions.delete(session);
    this.store(session, {
      surfaces: { ...prior.surfaces, [by]: next },
      // [LAW:one-source-of-truth] Keep one animation clock for the session,
      // while each surface keeps what its own frame drew under it. An older
      // receipt cannot rewind the clock.
      motion: newer ? holdMotion(motion) : prior.motion,
      portableMotion: newer
        ? portable && { order: portable.order, value: portable.motion }
        : prior.portableMotion,
      idle:
        order >= (prior.idleOrder ?? latest?.order ?? -1)
          ? idleAfterDraw(prior.idle, menu)
          : prior.idle,
      idleOrder: Math.max(prior.idleOrder ?? -1, order),
    });
    return { faults: change.faults === KEPT_FAULTS ? null : change.faults };
  }

  idleMoved(session: SessionId, order: number): void {
    const prior = this.sessions.get(session);
    if (prior) this.sessions.set(session, { ...prior, idleOrder: order });
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

  latestLayout(
    session: SessionId,
    targets: Readonly<Record<DrawSurface, symbol>>,
  ): FrameLayout | undefined {
    const drawn: SessionFrames["surfaces"] = {};
    for (const by of LANE_NAMES) {
      const frame = this.on(session, by);
      if (frame?.target === targets[by] && frame.layout !== null)
        drawn[by] = frame;
    }
    return latestOf(drawn)?.layout ?? undefined;
  }

  diagnostics(session: SessionId, by: DrawSurface): FrameWarnings | undefined {
    return this.on(session, by)?.diagnostics;
  }

  warnings(session: SessionId, by: DrawSurface) {
    return this.on(session, by)?.diagnostics.warnings ?? [];
  }

  effects(session: SessionId, by: DrawSurface): SessionEffects<RenderedLine> {
    const held = this.sessions.get(session);
    return new SessionEffects(
      session,
      {
        ...(held?.motion ?? NO_CLOCK),
        ...(held?.surfaces[by]?.effects ?? NO_EFFECTS),
      },
      this.compiled,
    );
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
    for (const by of LANE_NAMES) {
      const held = surfaces[by];
      if (held === undefined || (successor && held.target !== targets[by]))
        continue;
      surfaces[by] = {
        ...held,
        layout: null,
        portable: undefined,
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
        [by]: {
          ...held,
          layout: null,
          copies: null,
          portable: undefined,
          // A surface no longer drawn fades its placements back in when it is
          // drawn again, as one that was never drawn would.
          effects: NO_EFFECTS,
        },
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
      if (held.motion !== undefined) sessions++;
      for (const by of LANE_NAMES) {
        const surface = held.surfaces[by];
        for (const effectsOfRow of surface?.effects.made.values() ?? [])
          effects += effectsOfRow.size;
        passages += surface?.layout?.record.passages?.size ?? 0;
      }
    }
    return { effects: { sessions, effects }, passages };
  }
}
