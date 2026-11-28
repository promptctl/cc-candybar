// [LAW:one-source-of-truth] A subscription belongs to the daemon. Its last
// attempted draw and its next deadline live until the last subscriber leaves,
// even when the process drawing the subscription changes in between.
import type { Lane } from "../config/lanes.js";
import type {
  EventInput,
  FeedFrame,
  RendererOutput,
} from "../renderer-interface/interface.js";
import {
  activeTicks,
  comparisonOf,
  sameTurn,
  type FeedAdvance,
  type FeedHistory,
  type FeedResume,
  type FeedUpdate,
} from "../renderer-interface/feed-history.js";
import type { Tick } from "../utils/instant.js";
import type { SessionId } from "./foundations/session-id.js";

interface Subscription {
  since: number;
  reader?: object;
  installed: boolean;
  latest?: Pick<FeedUpdate, "sequence" | "schedule">;
  history: FeedHistory | null;
  exportProblem: string | null;
}

export class HostFeedHistory {
  private readonly watched = new Map<SessionId, Subscription>();
  private order = 0;

  watching(session: SessionId, present: boolean): void {
    if (!present) this.watched.delete(session);
    else if (!this.watched.has(session))
      this.watched.set(session, {
        since: ++this.order,
        installed: false,
        history: null,
        exportProblem: null,
      });
  }

  moved(session: SessionId): void {
    const feed = this.watched.get(session);
    if (!feed) return;
    feed.since = ++this.order;
    feed.reader = undefined;
    feed.latest = undefined;
    feed.installed = false;
  }

  // One-way reactions only advance ordinary deadlines. A notification from
  // a process which no longer owns this feed cannot affect its successor.
  advanced(reader: object, changes: readonly FeedAdvance[]): void {
    for (const { session, next, sequence } of changes) {
      const slot = this.watched.get(session);
      if (slot?.reader !== reader || sequence <= (slot.latest?.sequence ?? 0))
        continue;
      const schedule = { kind: "frame", next, change: null } as const;
      slot.latest = { sequence, schedule };
      if (slot.history) slot.history = { ...slot.history, schedule };
    }
  }

  turn(
    input: EventInput,
    reader: object,
    owns: (session: SessionId) => boolean,
  ) {
    const order = ++this.order;
    const { event, tick } = input;
    const viewers =
      event.kind === "start" || event.kind === "viewers"
        ? event.viewers
        : undefined;
    const feedResumes: FeedResume[] = [];
    for (const key of Object.keys(viewers ?? {})) {
      const session = key as SessionId;
      const slot = this.watched.get(session);
      if (!slot || !owns(session) || (slot.reader === reader && slot.installed))
        continue;
      if (slot.reader !== reader) slot.latest = undefined;
      slot.reader = reader;
      slot.installed = false;
      feedResumes.push({
        session,
        history: slot.history,
        exportProblem: slot.exportProblem,
      });
    }
    return {
      input: feedResumes.length ? { ...input, feedResumes } : input,
      took: (
        output: Pick<RendererOutput, "feedUpdates" | "frames">,
        problem: (session: SessionId) => string | null,
      ) => {
        if (!output.feedUpdates?.length) return;
        const frames = new Map<SessionId, Array<[Lane, FeedFrame]>>();
        for (const { session, lane, frame } of output.frames)
          frames.set(session, [...(frames.get(session) ?? []), [lane, frame]]);
        for (const update of output.feedUpdates) {
          const { session, schedule, changed } = update;
          const slot = this.watched.get(session);
          if (
            !slot ||
            slot.since > order ||
            slot.reader !== reader ||
            !owns(session)
          )
            continue;
          const history = slot.history;
          const seen = update.viewers ? viewers?.[session] : history?.viewers;
          if (!seen)
            throw new Error(
              `feed for ${session} reported a schedule without viewers`,
            );
          const drawn = frames.get(session);
          const kept = (lane: Lane): boolean =>
            sameTurn(seen, history?.viewers, lane);
          let rates = history?.rates ?? {};
          if (update.viewers || changed?.length) {
            const next: Partial<Record<Lane, readonly Tick[]>> = {};
            for (const lane of Object.keys(seen.lanes) as Lane[]) {
              const ticks = kept(lane)
                ? activeTicks(rates[lane] ?? [], tick)
                : [];
              if (changed?.includes(lane)) ticks.push(tick);
              next[lane] = ticks;
            }
            rates = next;
          }
          // An observation can arrive while the promise for an earlier turn
          // is landing. Keep the later schedule while accepting the actual
          // frame and rate changes from that numbered answer.
          if (!slot.latest || slot.latest.sequence < update.sequence)
            slot.latest = { sequence: update.sequence, schedule };
          slot.history = {
            viewers: seen,
            schedule: slot.latest.schedule,
            rates,
            last: drawn ? tick : (history?.last ?? null),
            frames: Object.fromEntries(
              (Object.keys(seen.lanes) as Lane[]).flatMap((lane) => {
                const now = drawn?.find(([of]) => of === lane)?.[1];
                const held = now
                  ? comparisonOf(now)
                  : kept(lane)
                    ? history?.frames[lane]
                    : undefined;
                return held ? [[lane, held]] : [];
              }),
            ),
          };
          if (drawn) slot.exportProblem = problem(session);
          if (update.viewers) slot.installed = true;
        }
      },
    };
  }
}
