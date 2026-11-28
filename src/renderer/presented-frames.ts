import {
  idleOfDraw,
  MAX_PRESENTED_SESSIONS,
  proposedValue,
  surfaceAfter,
} from "../renderer-interface/presentation.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import { LANE_NAMES, type Lane } from "../config/lanes.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import type { DrawnFrame } from "../dsl/render.js";
import {
  CompiledEffects,
  SurfaceMemory,
  holdEffects,
  holdClock,
  restoreEffects,
  type KeptMotion,
} from "../render/effect.js";
import { holdLayout, restoreLayout } from "../render/held-layout.js";
import type {
  HeldSurface,
  Ordered,
  PresentationInput,
  PresentedSession,
  ProposedPresentation,
} from "../renderer-interface/presentation.js";
import { surfaceChange, proposeValue } from "./presentation-change.js";
import type { RichText } from "@promptctl/rich-js";
import type { EffectId } from "../renderer-interface/interface.js";
import { KEPT_FAULTS } from "../renderer-interface/noted-faults.js";
import { MenuIdle, type DrawnMenu, type Idle } from "./menu-idle.js";
import {
  describeWarning,
  warningChanges,
  type FrameWarnings,
} from "./render-warnings.js";

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
  readonly surface: Lane;
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
  // What this surface's frame drew and its clock, for its next draw.
  readonly motion: KeptMotion;
}

interface SessionFrames {
  readonly surfaces: Partial<Record<Lane, AcceptedFrame>>;
  readonly idle?: Idle;
  readonly idleOrder?: number;
}

// The surface whose frame was accepted last, which the session's menu idle
// period advances with: the period closes the session's menus, so it is the
// session's, never one surface's.
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
}

// [LAW:single-enforcer] These are the renderer's accepted frame values.
// Each surface keeps its own layout, effects and clock, while draw order
// gives the session one idle timeline. Updating either commits one session
// record.
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
    const surface: HeldSurface = {
      layout: holdLayout(frame.layout.record, loadKey, bases?.revision ?? 0),
      clock: holdClock(frame.motion),
      effects: holdEffects(frame.motion),
      copies: [...frame.copies],
      warnings: frame.diagnostics.warnings.map((w) => w.warning),
      faults: frame.diagnostics.faults,
    };
    const surfaceProposal = proposeValue(
      known,
      bases?.bases[by],
      surface,
      surfaceChange,
    );
    return {
      portable: {
        order: input.order,
        surface: proposedValue(known, surfaceProposal, surfaceAfter),
      },
      proposal: {
        surface: surfaceProposal,
        menu: { shown: frame.menu.shown, timeoutS: frame.menu.timeoutS },
      },
    };
  }

  resume(
    saved: PresentedSession,
    view: {
      state: { loadKey: string; config: object };
      presentationTargets: Record<Lane, symbol>;
    },
    revision: number,
    localRevision: number,
  ) {
    const prior = this.sessions.get(saved.session) ?? { surfaces: {} };
    const surfaces = { ...prior.surfaces };
    for (const by of LANE_NAMES) {
      const held = saved.surfaces[by];
      // A surface the saved image no longer holds, and no newer than it,
      // retired there.
      if (!held) {
        if ((surfaces[by]?.order ?? Infinity) <= saved.idle.order)
          delete surfaces[by];
        continue;
      }
      if ((surfaces[by]?.order ?? -1) >= held.order) continue;
      const { layout, clock, effects, copies, warnings, faults } = held.value;
      const record =
        layout.revision === revision
          ? restoreLayout(layout, view.state, localRevision)
          : undefined;
      surfaces[by] = {
        order: held.order,
        portable: held,
        target: view.presentationTargets[by],
        layout: record ? { record, segments: new Map() } : null,
        motion: { ...clock, ...restoreEffects(effects) },
        copies: new Map(copies),
        diagnostics: { warnings: warnings.map(describeWarning), faults },
      };
    }
    this.store(saved.session, {
      ...prior,
      surfaces,
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
      motion,
      ...(portable && { portable: { order, value: portable.surface } }),
    };
    const change = warningChanges(surface.diagnostics, previous?.diagnostics);
    this.sessions.delete(session);
    const idle = idleOfDraw(
      prior.idle && {
        order: prior.idleOrder ?? latest?.order ?? -1,
        value: prior.idle,
      },
      order,
      menu,
    );
    this.store(session, {
      surfaces: { ...prior.surfaces, [by]: next },
      idle: idle.value,
      idleOrder: Math.max(prior.idleOrder ?? -1, order),
    });
    return { faults: change.faults === KEPT_FAULTS ? null : change.faults };
  }

  idleMoved(session: SessionId, order: number): void {
    const prior = this.sessions.get(session);
    if (prior) this.sessions.set(session, { ...prior, idleOrder: order });
  }

  private on(session: SessionId, by: Lane): AcceptedFrame | undefined {
    return this.sessions.get(session)?.surfaces[by];
  }

  layout(
    session: SessionId,
    by: Lane,
    target: symbol,
  ): FrameLayout | undefined {
    const held = this.on(session, by);
    return held?.target === target ? (held.layout ?? undefined) : undefined;
  }

  latestLayout(
    session: SessionId,
    targets: Readonly<Record<Lane, symbol>>,
  ): FrameLayout | undefined {
    const drawn = Object.fromEntries(
      LANE_NAMES.flatMap((by) => {
        const frame = this.on(session, by);
        return frame?.target === targets[by] && frame.layout !== null
          ? [[by, frame] as const]
          : [];
      }),
    );
    return latestOf(drawn)?.layout ?? undefined;
  }

  diagnostics(session: SessionId, by: Lane): FrameWarnings | undefined {
    return this.on(session, by)?.diagnostics;
  }

  warnings(session: SessionId, by: Lane) {
    return this.on(session, by)?.diagnostics.warnings ?? [];
  }

  // What the surface's next draw reads: its accepted frame's effects and
  // clock, and none for a surface that draws from the start.
  effects(session: SessionId, by: Lane): SurfaceMemory<RenderedLine> {
    return new SurfaceMemory(
      session,
      this.on(session, by)?.motion,
      this.compiled,
    );
  }

  copy(session: SessionId, by: Lane, key: string): string | undefined {
    return this.on(session, by)?.copies?.get(key);
  }

  retireView(
    session: SessionId,
    targets: Readonly<Record<Lane, symbol>>,
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

  // [LAW:one-source-of-truth] The host's image is the presentation. A
  // surface it no longer offers at this surface's order (its lane's drawer
  // turned, or its image retired) is no record a draw continues: it fades
  // its placements in and starts its clock as one never drawn would.
  offered(session: SessionId, bases: Partial<Record<Lane, number>>): void {
    const prior = this.sessions.get(session);
    if (prior === undefined) return;
    const stale = LANE_NAMES.filter(
      (lane) =>
        prior.surfaces[lane] !== undefined &&
        prior.surfaces[lane].order !== bases[lane],
    );
    if (stale.length === 0) return;
    const surfaces = { ...prior.surfaces };
    for (const lane of stale) delete surfaces[lane];
    this.sessions.set(session, { ...prior, surfaces });
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
      if (LANE_NAMES.some((by) => held.surfaces[by]?.motion)) sessions++;
      for (const by of LANE_NAMES) {
        const surface = held.surfaces[by];
        for (const effectsOfRow of surface?.motion.made.values() ?? [])
          effects += effectsOfRow.size;
        passages += surface?.layout?.record.passages?.size ?? 0;
      }
    }
    return { effects: { sessions, effects }, passages };
  }
}
