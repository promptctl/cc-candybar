import type { Tick } from "../utils/instant.js";
import type { SessionId } from "./foundations/session-id.js";
import type { StoreWrite } from "../renderer-interface/stored-state.js";
import {
  type EventInput,
  type EffectId,
  type Presentation,
  type RendererOutput,
} from "../renderer-interface/interface.js";
import { LANE_NAMES, type Lane } from "../config/lanes.js";
import {
  idleOfDraw,
  MAX_PRESENTED_SESSIONS,
  surfaceAfter,
  proposedValue,
  type PresentationInput,
  type PresentedSession,
  type ProposedPresentation,
} from "../renderer-interface/presentation.js";

export type PresentationReader = WeakMap<object, WeakSet<object>>;

// [LAW:one-source-of-truth] Each lane's turn and whether it is followed, as
// the host's subscriber book owns them.
export interface LaneTurn {
  readonly turn: number;
  readonly followed: boolean;
}
export interface LaneTurns {
  laneOf(session: SessionId, lane: Lane): LaneTurn;
}

// [LAW:types-are-the-program] Who drew a surface, and under which turn of its
// lane: the lane's feed, or Claude Code's statusline request.
export type Drawer =
  | { readonly by: "feed"; readonly lane: Lane; readonly turn: number }
  | { readonly by: "request"; readonly turn: number };

const surfaceOf = (drawer: Drawer): Lane =>
  drawer.by === "feed" ? drawer.lane : "statusline";

// [LAW:single-enforcer] Each surface has one drawer at a time: its lane's feed
// while the lane is followed, and Claude Code's statusline request while it
// is not, since cc-extra's statusline push shows a pushed frame in place of
// the command's answer. A turn is one drawer's period, so a draw is sent and
// presents only under the turn it was drawn in, and a surface drawn under an
// earlier turn is no longer the one shown.
export function drawsNow(
  lanes: LaneTurns,
  session: SessionId,
  drawer: Drawer,
): boolean {
  const { turn, followed } = lanes.laneOf(session, surfaceOf(drawer));
  return drawer.turn === turn && followed === (drawer.by === "feed");
}

interface Slot {
  image?: PresentedSession;
  // Who drew each surface of the image.
  readonly drawers: Partial<Record<Lane, Drawer>>;
  readonly exportProblems: Partial<Record<Lane, string | null>>;
  revision: number;
  readonly began: number;
}
interface Pinned {
  readonly slot: Slot;
  readonly prior?: PresentedSession;
  readonly observed: WeakSet<object>;
  // Claude Code's statusline request, under the turn its draw began in.
  readonly request: Drawer;
}

// What a delivered draw does to the image: presents, and says so once its
// write is observed, or says why it does not.
type Verdict =
  | { readonly presentation: "presented"; readonly settle: () => void }
  | { readonly presentation: Exclude<Presentation, "presented"> };

export interface PresentationTurn {
  readonly input: EventInput;
  readonly received: () => void;
  readonly drawn: (output: RendererOutput) => (id: EffectId) => Verdict;
}

// [LAW:single-enforcer] A socket's successful write is the sole writer of a
// surface's image. Its callback owns the immutable proposal and base until
// completion, independently of the renderer process that produced them.
export class HostPresentations {
  private order = 0;
  private readonly live = new Map<SessionId, Slot>();
  constructor(
    private readonly lanes: LaneTurns,
    private readonly limit = MAX_PRESENTED_SESSIONS,
  ) {}

  retire(session: SessionId): void {
    this.live.delete(session);
  }

  holds(session: SessionId): boolean {
    return this.live.has(session);
  }

  // [LAW:one-source-of-truth] The image as it stands: only the surfaces drawn
  // under their lane's current turn. What an earlier drawer showed is derived
  // away, never removed by an event the book would have to hear.
  private currentOf(
    session: SessionId,
    slot: Slot,
  ): PresentedSession | undefined {
    const { image } = slot;
    if (!image) return undefined;
    const current = LANE_NAMES.filter((lane) => {
      const drawer = slot.drawers[lane];
      return drawer !== undefined && drawsNow(this.lanes, session, drawer);
    });
    if (current.length === Object.keys(image.surfaces).length) return image;
    return {
      ...image,
      surfaces: Object.fromEntries(
        current.map((lane) => [lane, image.surfaces[lane]]),
      ),
      exportProblem: exportProblemOf(slot, current),
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
      drawers: {},
      exportProblems: {},
      revision: 0,
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
      const prior = this.currentOf(session, slot);
      pinned.set(session, {
        slot,
        prior,
        observed,
        request: {
          by: "request",
          turn: this.lanes.laneOf(session, "statusline").turn,
        },
      });
      // [LAW:one-source-of-truth] A draw is offered the image even when there
      // is none, so the renderer drops a record the host no longer holds (an
      // evicted slot's) rather than continue its motion.
      if (!prior) {
        if (draws || slot.revision)
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
        const pending = new Map<EffectId, () => Verdict>();
        // [LAW:no-silent-failure] Every draw is staged with what its delivery
        // will do: a draw with no proposal (its client shows no answer) is
        // shown nowhere, and one with no image pinned at its order (a due's
        // frame for a session the host no longer holds) has none to continue.
        const stage = (
          id: EffectId,
          session: SessionId,
          drawer: (base: Pinned) => Drawer,
          proposal?: ProposedPresentation,
        ) => {
          const base = pinned.get(session);
          pending.set(
            id,
            !proposal
              ? () => ({ presentation: "unshown" })
              : !base
                ? () => ({ presentation: "retired" })
                : this.proposed(
                    session,
                    drawer(base),
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
              ({ request }) => request,
              effect.proposal,
            );
        for (const { session, lane, turn, frame } of output.frames)
          if (frame.kind === "drawn")
            stage(
              frame.receipt,
              session,
              () => ({ by: "feed", lane, turn }),
              frame.proposal,
            );
        return (id) => {
          const take = pending.get(id);
          pending.delete(id);
          return take?.() ?? { presentation: "unshown" };
        };
      },
    };
  }
  // What the delivery of `drawer`'s draw does to the image.
  private proposed(
    session: SessionId,
    drawer: Drawer,
    order: number,
    tick: Tick,
    base: Pinned,
    proposal: ProposedPresentation,
    problem: string | null,
  ): () => Verdict {
    const { prior, slot, observed } = base;
    const { surface, menu } = proposal;
    const by = surfaceOf(drawer);
    const nextSurface = {
      order,
      value: proposedValue(prior?.surfaces[by], surface, surfaceAfter),
    };
    return () => {
      if (this.live.get(session) !== slot) return { presentation: "retired" };
      // [LAW:single-enforcer] The check that decided whether a feed's frame
      // was sent decides whether it presents.
      if (!drawsNow(this.lanes, session, drawer))
        return { presentation: "turned" };
      const current = slot.image;
      const held = current?.surfaces[by];
      if (held && slot.drawers[by]?.turn === drawer.turn && order <= held.order)
        return { presentation: "superseded" };
      slot.drawers[by] = drawer;
      slot.exportProblems[by] = problem;
      const surfaces = { ...current?.surfaces, [by]: nextSurface };
      slot.image = {
        session,
        surfaces,
        exportProblem: exportProblemOf(
          slot,
          LANE_NAMES.filter((lane) => surfaces[lane] !== undefined),
        ),
        idle: idleOfDraw(current?.idle, order, { ...menu, tick }),
      };
      const drawnIdle =
        slot.image.idle.order === order ? slot.image.idle : undefined;
      return {
        presentation: "presented",
        settle: () => {
          observed.add(nextSurface);
          if (drawnIdle) observed.add(drawnIdle);
        },
      };
    };
  }
}

// [LAW:nothing-unseen] Every shown surface's export problem, each named by
// its lane.
const exportProblemOf = (slot: Slot, lanes: readonly Lane[]): string | null =>
  lanes
    .flatMap((lane) => {
      const problem = slot.exportProblems[lane];
      return problem == null ? [] : [`${lane}: ${problem}`];
    })
    .join("; ") || null;
