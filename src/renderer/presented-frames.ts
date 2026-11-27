import {
  MAX_PRESENTED_SESSIONS,
  proposedValue,
  surfaceAfter,
  motionAfter,
  type DrawSurface,
} from "../renderer-interface/presentation.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { RenderedLine } from "../dsl/node-registry.js";
import type { DrawnFrame } from "../dsl/render.js";
import {
  CompiledEffects,
  SessionEffects,
  holdMotion,
  restoreMotion,
} from "../render/effect.js";
import type { HeldMotion } from "../render/effect.js";
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
  combinedWarnings,
  describeWarning,
  warningChanges,
  type FrameWarnings,
} from "./render-warnings.js";

export type { DrawSurface };
const SURFACES: readonly DrawSurface[] = ["request", "feed"];

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
}

interface SessionFrames {
  readonly surfaces: Partial<Record<DrawSurface, AcceptedFrame>>;
  readonly motion?: ReturnType<typeof restoreMotion>;
  readonly portableMotion?: Ordered<HeldMotion>;
  readonly idle?: Idle;
  readonly idleOrder?: number;
}

const latestOf = ({ request, feed }: SessionFrames["surfaces"]) =>
  request !== undefined && (feed === undefined || request.order > feed.order)
    ? request
    : feed;

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
  private readonly configs = new WeakMap<object, symbol>();
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

  // [LAW:no-shared-mutable-globals] The token identifies a config without
  // holding that config alive once its view's layout has retired.
  configOf(config: object): symbol {
    const held = this.configs.get(config);
    if (held !== undefined) return held;
    const token = Symbol();
    this.configs.set(config, token);
    return token;
  }

  propose(
    candidate: FrameCandidate,
    input: PresentationInput,
  ): { portable: PortableDraw; proposal: ProposedPresentation } {
    const { session, by, frame, loadKey } = candidate;
    const prior = this.sessions.get(session);
    const bases = input.sessions.find((s) => s.session === session);
    const known = prior?.surfaces[by]?.portable;
    const knownMotion = prior?.portableMotion;
    const surface: HeldSurface = {
      layout: holdLayout(frame.layout.record, loadKey, bases?.revision ?? 0),
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
    for (const by of SURFACES) {
      const held = saved.surfaces[by];
      if (!held) {
        if ((surfaces[by]?.order ?? Infinity) <= saved.motion.order)
          delete surfaces[by];
        continue;
      }
      if ((surfaces[by]?.order ?? -1) >= held.order) continue;
      const { layout, copies, warnings, faults } = held.value;
      const record =
        layout.revision === revision
          ? restoreLayout(layout, view.state, localRevision)
          : undefined;
      surfaces[by] = {
        order: held.order,
        portable: held,
        target: view.presentationTargets[by],
        config: record ? this.configOf(view.state.config) : Symbol(),
        layout: record ? { record, segments: new Map() } : null,
        copies: new Map(copies),
        diagnostics: { warnings: warnings.map(describeWarning), faults },
      };
    }
    const newer = saved.motion.order > (prior.portableMotion?.order ?? -1);
    this.store(saved.session, {
      ...prior,
      surfaces,
      ...(newer && {
        motion: restoreMotion(saved.motion.value),
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
    { session, by, target, frame }: FrameCandidate,
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
      ...(portable && { portable: { order, value: portable.surface } }),
    };
    const newer =
      latest === undefined ||
      order > (prior.portableMotion?.order ?? latest.order);
    const change = warningChanges(surface.diagnostics, previous?.diagnostics);
    this.sessions.delete(session);
    this.store(session, {
      surfaces: { ...prior.surfaces, [by]: next },
      // [LAW:one-source-of-truth] Keep one motion cache, even when both
      // surfaces retain their layout. An older receipt cannot rewind it.
      motion: newer ? motion : prior.motion,
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
    const drawn = (by: DrawSurface) => {
      const frame = this.on(session, by);
      return frame?.target === targets[by] && frame.layout !== null
        ? frame
        : undefined;
    };
    return (
      latestOf({ request: drawn("request"), feed: drawn("feed") })?.layout ??
      undefined
    );
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
    return new SessionEffects(
      session,
      this.sessions.get(session)?.motion,
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
    for (const by of SURFACES) {
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
        [by]: { ...held, layout: null, copies: null, portable: undefined },
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
