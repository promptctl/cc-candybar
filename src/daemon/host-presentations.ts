import type { Tick } from "../utils/instant.js";
import type { SessionId } from "./foundations/session-id.js";
import type { StoreWrite } from "../renderer-interface/stored-state.js";
import {
  type EventInput,
  type EffectId,
  type RendererOutput,
} from "../renderer-interface/interface.js";
import { LANE_NAMES, perLane, type Lane } from "../config/lanes.js";
import { roleOf } from "./foundations/sighting-roles.js";
import {
  idleAfterDraw,
  MAX_PRESENTED_SESSIONS,
  surfaceAfter,
  proposedValue,
  type PresentationInput,
  type PresentedSession,
  type ProposedPresentation,
} from "../renderer-interface/presentation.js";

export type PresentationReader = WeakMap<object, WeakSet<object>>;

// [LAW:no-ambient-temporal-coupling] A lane's feed as an epoch: a new value
// each time the lane gains its first subscriber or loses its last. A draw
// presents only under the epoch it was drawn in.
interface FeedEpoch {
  readonly followed: boolean;
}
// [LAW:single-enforcer] Each surface has one drawer at a time: its lane's
// feed while the lane is followed, and Claude Code's statusline request while
// it is not, since cc-extra's statusline push shows a pushed frame in place
// of the command's answer.
type Drawer = "request" | "feed";
const drawerOf = ({ followed }: FeedEpoch): Drawer =>
  followed ? "feed" : "request";

interface Slot {
  image?: PresentedSession;
  readonly exportProblems: Partial<Record<Lane, string | null>>;
  revision: number;
  readonly feeds: Record<Lane, FeedEpoch>;
  readonly began: number;
}
interface Pinned {
  readonly slot: Slot;
  readonly feeds: Readonly<Record<Lane, FeedEpoch>>;
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

  // A lane gained its first subscriber or lost its last: its surface's drawer
  // changed, so what the old drawer showed retires with the draws still on
  // their way to it.
  feedTurned(session: SessionId, lane: Lane, followed: boolean): void {
    const slot = followed ? this.hold(session) : this.live.get(session);
    if (!slot) return;
    slot.feeds[lane] = { followed };
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
      feeds: perLane(() => ({ followed: false })),
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
          offers.push({ session, revision: slot.revision, bases: {} });
        continue;
      }
      const shown = LANE_NAMES.flatMap((lane) => {
        const held = prior.surfaces[lane];
        return held ? [[lane, held] as const] : [];
      });
      const facts = [prior.idle, ...shown.map(([, held]) => held)];
      const resume = facts.some((fact) => !observed.has(fact));
      if (!draws && !resume) continue;
      offers.push({
        session,
        revision: slot.revision,
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
        const pending = new Map<EffectId, () => (() => void) | undefined>();
        const stage = (
          id: EffectId,
          session: SessionId,
          by: Lane,
          drawer: Drawer,
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
              drawer,
              order,
              input.tick,
              base,
              proposal,
              exportProblem(session),
            ),
          );
        };
        // [LAW:one-source-of-truth] A `cc-candybar frames` client discards
        // its request's answer, so only Claude Code's own statusline client
        // shows one.
        const shownByClaude =
          event.kind === "request" &&
          roleOf(event.context.hints.client ?? null) === "statusline";
        for (const effect of output.effects)
          if (effect.kind === "present" && shownByClaude)
            stage(
              effect.id,
              effect.session,
              effect.surface,
              "request",
              effect.proposal,
            );
        for (const { session, lane, frame } of output.frames)
          if (frame.kind === "drawn")
            stage(frame.receipt, session, lane, "feed", frame.proposal);
        return (id, delivered) => {
          const take = pending.get(id);
          pending.delete(id);
          return delivered ? take?.() : undefined;
        };
      },
    };
  }
  // What the delivery of a draw does to the image: the surface's next record
  // when it presents, and undefined when it does not.
  private proposed(
    session: SessionId,
    by: Lane,
    drawer: Drawer,
    order: number,
    tick: Tick,
    base: Pinned,
    proposal: ProposedPresentation,
    problem: string | null,
  ): () => (() => void) | undefined {
    const { prior, slot, observed } = base;
    const epoch = base.feeds[by];
    const { surface, menu } = proposal;
    const nextSurface = {
      order,
      value: proposedValue(prior?.surfaces[by], surface, surfaceAfter),
    };
    return () => {
      const current = slot.image;
      if (
        this.live.get(session) !== slot ||
        slot.feeds[by] !== epoch ||
        drawerOf(epoch) !== drawer ||
        order <= (current?.surfaces[by]?.order ?? -1)
      )
        return undefined;
      slot.exportProblems[by] = problem;
      slot.image = {
        session,
        surfaces: { ...current?.surfaces, [by]: nextSurface },
        exportProblem: exportProblemOf(slot),
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
      const drawnIdle =
        slot.image.idle.order === order ? slot.image.idle : undefined;
      return () => {
        observed.add(nextSurface);
        if (drawnIdle) observed.add(drawnIdle);
      };
    };
  }
}

// [LAW:nothing-unseen] Every surface's export problem, each named by its lane.
const exportProblemOf = (slot: Slot): string | null =>
  LANE_NAMES.flatMap((lane) => {
    const problem = slot.exportProblems[lane];
    return problem == null ? [] : [`${lane}: ${problem}`];
  }).join("; ") || null;
