import type { Tick } from "../utils/instant.js";
import type { SessionId } from "./foundations/session-id.js";
import type { StoreWrite } from "../renderer-interface/stored-state.js";
import {
  type EventInput,
  type EffectId,
  type RendererOutput,
} from "../renderer-interface/interface.js";
import { LANE_NAMES, perLane, type Lane } from "../config/lanes.js";
import {
  idleAfterDraw,
  REQUEST_SURFACE,
  retiresWithFeed,
  MAX_PRESENTED_SESSIONS,
  motionAfter,
  surfaceAfter,
  type DrawSurface,
  proposedValue,
  type PresentationInput,
  type PresentedSession,
  type ProposedPresentation,
} from "../renderer-interface/presentation.js";

export type PresentationReader = WeakMap<object, WeakSet<object>>;
interface Slot {
  image?: PresentedSession;
  readonly exportProblems: Partial<Record<DrawSurface, string | null>>;
  revision: number;
  // [LAW:no-ambient-temporal-coupling] Each lane's feed lifetime: a frame
  // drawn for a lane whose last subscriber has since left cannot write its
  // surface's image.
  readonly feeds: Record<Lane, object>;
  readonly began: number;
  motionProblem?: string | null;
}
interface Pinned {
  readonly slot: Slot;
  readonly feeds: Readonly<Record<Lane, object>>;
  readonly prior?: PresentedSession;
  readonly observed: WeakSet<object>;
}

export interface PresentationTurn {
  readonly input: EventInput;
  readonly received: () => void;
  readonly drawn: (
    output: RendererOutput,
  ) => (id: EffectId, delivered: boolean) => (() => void) | undefined;
}

// [LAW:single-enforcer] A socket's successful write is the sole writer of a
// surface's image. Its callback owns the immutable proposal and base until
// completion, independently of the renderer process that produced them.
export class HostPresentations {
  private order = 0;
  private readonly live = new Map<SessionId, Slot>();
  constructor(private readonly limit = MAX_PRESENTED_SESSIONS) {}

  retire(session: SessionId): void {
    this.live.delete(session);
  }

  // A lane's last subscriber left: its surface is no longer shown, so its
  // image retires with the frames still on their way to it. Claude Code's
  // statusline is still drawn on request, so its image stands.
  stopFeed(session: SessionId, lane: Lane): void {
    const slot = this.live.get(session);
    if (!slot) return;
    slot.feeds[lane] = {};
    if (!retiresWithFeed(lane)) return;
    delete slot.exportProblems[lane];
    if (!slot.image?.surfaces[lane]) return;
    const { [lane]: _retired, ...surfaces } = slot.image.surfaces;
    slot.image = {
      ...slot.image,
      surfaces,
      exportProblem: exportProblemOf(slot),
    };
  }

  changed(revision: number, writes: readonly StoreWrite[]): void {
    for (const write of writes) {
      const slot = this.live.get(write.key);
      if (!slot) continue;
      if (
        (write.store === "session-state" && write.kind !== "heard") ||
        (write.store === "draft" &&
          (write.kind !== "modify" ||
            write.changes.some(
              (change) => change.kind === "pick" || change.kind === "file",
            )))
      )
        slot.revision = revision;
    }
  }

  private hold(session: SessionId): Slot {
    const prior = this.live.get(session) ?? {
      exportProblems: {},
      revision: 0,
      feeds: perLane(() => ({})),
      began: this.order,
    };
    this.live.delete(session);
    this.live.set(session, prior);
    if (this.live.size > this.limit)
      this.live.delete(this.live.keys().next().value!);
    return prior;
  }

  turn(
    input: EventInput,
    reader: PresentationReader,
    viewers: () => readonly SessionId[],
    exportProblem: (sid: SessionId) => string | null,
    owns: (sid: SessionId) => boolean,
  ): PresentationTurn | undefined {
    const { event } = input;
    let sessions: readonly SessionId[];
    switch (event.kind) {
      case "retire": {
        const slot = this.live.get(event.session);
        if (slot) reader.delete(slot);
        return undefined;
      }
      case "start":
        sessions = event.sessions.map(({ worldState }) => worldState.session);
        break;
      case "context":
      case "request":
        sessions = [event.context.hookData.session_id];
        break;
      case "click":
        sessions = event.click.scope === "session" ? [event.click.session] : [];
        break;
      case "due":
        sessions = viewers();
        break;
      default:
        return undefined;
    }
    const draws = event.kind === "request" || event.kind === "due";
    const order = ++this.order;
    const pinned = new Map<SessionId, Pinned>();
    const offers: Array<PresentationInput["sessions"][number]> = [];
    const arrived: Array<() => void> = [];
    for (const session of sessions) {
      const slot = draws ? this.hold(session) : this.live.get(session);
      if (!slot) continue;
      let observed = reader.get(slot);
      if (!observed) {
        observed = new WeakSet();
        reader.set(slot, observed);
      }
      const prior = slot.image;
      pinned.set(session, { slot, prior, observed, feeds: { ...slot.feeds } });
      if (!prior) {
        if (slot.revision)
          offers.push({
            session,
            revision: slot.revision,
            motion: 0,
            bases: {},
          });
        continue;
      }
      const shown = LANE_NAMES.flatMap((lane) => {
        const held = prior.surfaces[lane];
        return held ? [[lane, held] as const] : [];
      });
      const facts = [
        prior.motion,
        prior.idle,
        ...shown.map(([, held]) => held),
      ];
      const resume = facts.some((fact) => !observed.has(fact));
      if (!draws && !resume) continue;
      offers.push({
        session,
        revision: slot.revision,
        motion: prior.motion.order,
        bases: Object.fromEntries(
          shown.map(([lane, held]) => [lane, held.order]),
        ),
        ...(resume && { resume: prior }),
      });
      if (resume)
        arrived.push(() => {
          for (const fact of facts) observed.add(fact);
        });
    }
    const canMoveIdle =
      (event.kind === "click" && pinned.size > 0) ||
      (event.kind === "due" && this.live.size > 0);
    if (!canMoveIdle && (!pinned.size || (!draws && !offers.length)))
      return undefined;
    return {
      input: { ...input, presentation: { order, sessions: offers } },
      received: () => {
        for (const mark of arrived) mark();
      },
      drawn: (output) => {
        for (const { session, value } of output.idle ?? []) {
          if (
            !owns(session) ||
            (event.kind !== "due" &&
              !(event.kind === "click" && pinned.has(session)))
          )
            continue;
          const slot = this.live.get(session);
          if (
            !slot?.image ||
            slot.began > order ||
            slot.image.idle.order > order
          )
            continue;
          const idle = { order, value };
          slot.image = { ...slot.image, idle };
          reader.get(slot)?.add(idle);
        }
        const pending = new Map<EffectId, () => () => void>();
        const stage = (
          id: EffectId,
          session: SessionId,
          by: DrawSurface,
          fed: boolean,
          proposal?: ProposedPresentation,
        ) => {
          if (!proposal) return;
          const base = pinned.get(session);
          // A due already in the mailbox can still draw for a subscription
          // whose last viewer left. Its feed cannot advance an absent slot.
          if (!base) return;
          pending.set(
            id,
            this.proposed(
              session,
              by,
              fed,
              order,
              input.tick,
              base,
              proposal,
              exportProblem(session),
            ),
          );
        };
        for (const effect of output.effects)
          if (effect.kind === "present")
            stage(
              effect.id,
              effect.session,
              REQUEST_SURFACE,
              false,
              effect.proposal,
            );
        for (const { session, lane, frame } of output.frames)
          if (frame.kind === "drawn")
            stage(frame.receipt, session, lane, true, frame.proposal);
        return (id, delivered) => {
          const take = pending.get(id);
          pending.delete(id);
          return delivered ? take?.() : undefined;
        };
      },
    };
  }
  private proposed(
    session: SessionId,
    by: DrawSurface,
    // Whether a feed drew it, so its lane's feed lifetime gates it.
    fed: boolean,
    order: number,
    tick: Tick,
    base: Pinned,
    proposal: ProposedPresentation,
    problem: string | null,
  ): () => () => void {
    const { prior, slot, observed } = base;
    const earlier = prior?.surfaces[by];
    const { surface, motion, menu } = proposal;
    const nextSurface = {
      order,
      value: proposedValue(earlier, surface, surfaceAfter),
    };
    const nextMotion = {
      order,
      value: proposedValue(prior?.motion, motion, motionAfter),
    };
    return () => {
      let drawnIdle: object | undefined;
      if (
        this.live.get(session) === slot &&
        (!fed || slot.feeds[by] === base.feeds[by])
      ) {
        const current = slot.image;
        if (order > (current?.surfaces[by]?.order ?? -1)) {
          const latest = !current || order > current.motion.order;
          slot.exportProblems[by] = problem;
          if (latest) slot.motionProblem = problem;
          slot.image = {
            session,
            surfaces: { ...current?.surfaces, [by]: nextSurface },
            exportProblem: exportProblemOf(slot),
            motion: latest ? nextMotion : current.motion,
            idle:
              !current || order >= current.idle.order
                ? {
                    order,
                    value: idleAfterDraw(current?.idle.value, {
                      ...menu,
                      tick,
                    }),
                  }
                : current.idle,
          };
          if (slot.image.idle.order === order) drawnIdle = slot.image.idle;
        }
      }
      return () => {
        observed.add(nextSurface);
        observed.add(nextMotion);
        if (drawnIdle) observed.add(drawnIdle);
      };
    };
  }
}

// The first export problem of the surfaces the image holds, then its motion's.
const exportProblemOf = (slot: Slot): string | null =>
  LANE_NAMES.map((lane) => slot.exportProblems[lane]).find(
    (problem) => problem != null,
  ) ??
  slot.motionProblem ??
  null;
