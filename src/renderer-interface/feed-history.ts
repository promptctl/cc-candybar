// [LAW:one-source-of-truth] A feed's changed-draw rate compares only the
// visible runs at their output depth. The attempted frame crosses the wire
// already. The host and renderer keep the same projection of that frame.
import { compareStructural } from "mobx";
import { isPlainObject } from "../config/loader/validate-core.js";
import { LANES, type Lane } from "../config/lanes.js";
import type { Frame, Row, WireFrame } from "../render/frame.js";
import type { Instant, Tick } from "../utils/instant.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { FeedFrame, SessionViewers } from "./interface.js";

export type FeedSchedule =
  | { readonly kind: "waiting"; readonly next: null }
  | {
      readonly kind: "frame";
      readonly next: Tick;
      readonly change: Instant | null;
    }
  | { readonly kind: "retry"; readonly next: Tick };

interface FeedContent {
  readonly depth: Frame["depth"];
  readonly rows: ReadonlyArray<Row["runs"]>;
}

export type FeedComparison =
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "drawn"; readonly bar: FeedContent };

// Each lane's last attempted frame: every surface is drawn its own.
export type FeedComparisons = Readonly<Partial<Record<Lane, FeedComparison>>>;

function contentOf({ depth, rows }: WireFrame): FeedContent {
  return { depth, rows: rows.map((row) => row.runs) };
}

export function comparisonOf(frame: FeedFrame): FeedComparison {
  return frame.kind === "failed"
    ? { kind: "failed", message: frame.message }
    : { kind: "drawn", bar: contentOf(frame.bar) };
}

// Whether a lane's frame changed from the one drawn for it before.
export function changedDraw(
  previous: FeedComparison | undefined,
  current: FeedComparison,
): boolean {
  if (current.kind === "failed")
    return previous?.kind !== "failed" || previous.message !== current.message;
  return (
    previous?.kind !== "drawn" || !compareStructural(previous.bar, current.bar)
  );
}

// A changed draw contributes one tick per lane whose frame it changed,
// including a draw a subscriber later refused. Receipt and rate have distinct
// owners.
export interface FeedUpdate {
  readonly sequence: number;
  readonly session: SessionId;
  readonly schedule: FeedSchedule;
  readonly viewers?: true;
  readonly changed?: readonly Lane[];
}

export interface FeedHistory {
  readonly viewers: SessionViewers;
  readonly schedule: FeedSchedule;
  readonly last: Tick | null;
  readonly frames: FeedComparisons;
  readonly rates: Readonly<Partial<Record<Lane, readonly Tick[]>>>;
}

export interface FeedResume {
  readonly session: SessionId;
  readonly history: FeedHistory | null;
  readonly exportProblem: string | null;
}

export const RATE_WINDOW_S = 1;

// [LAW:single-enforcer] Membership in the rolling second is the same at a
// live draw, at handoff, and in the host's reconstruction of an attempt.
export function activeTicks(ticks: readonly Tick[], tick: Tick): Tick[] {
  return ticks.filter((sent) => sent > tick - RATE_WINDOW_S && sent <= tick);
}

// One-way state observations can only bring a watched feed forward.
export interface FeedAdvance {
  readonly sequence: number;
  readonly session: SessionId;
  readonly next: Tick;
}

function isSchedule(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  switch (value.kind) {
    case "waiting":
      return value.next === null && Object.keys(value).length === 2;
    case "frame":
      return (
        Number.isFinite(value.next) &&
        (value.change === null || Number.isFinite(value.change)) &&
        Object.keys(value).length === 3
      );
    case "retry":
      return Number.isFinite(value.next) && Object.keys(value).length === 2;
    default:
      return false;
  }
}

// [LAW:parse-dont-validate] A draw and its comparison refer to exactly
// the same attempt. Check the pairing before the host can publish a frame,
// including an answer which omitted the history field altogether. A session's
// attempt is one frame per lane, each lane at most once.
export function validFeedUpdates(value: unknown, frames: unknown): boolean {
  if (!Array.isArray(frames)) return false;
  if (value === undefined) return frames.length === 0;
  if (!Array.isArray(value)) return false;
  const attempts = new Set<string>();
  const drawn = new Set<string>();
  for (const frame of frames) {
    if (
      !isPlainObject(frame) ||
      typeof frame.session !== "string" ||
      typeof frame.lane !== "string" ||
      !Object.hasOwn(LANES, frame.lane)
    )
      return false;
    const key = JSON.stringify([frame.session, frame.lane]);
    if (drawn.has(key)) return false;
    drawn.add(key);
    attempts.add(frame.session);
  }
  const seen = new Set<string>();
  for (const update of value) {
    if (
      !isPlainObject(update) ||
      typeof update.session !== "string" ||
      !update.session.length ||
      seen.has(update.session) ||
      !Number.isSafeInteger(update.sequence) ||
      Number(update.sequence) <= 0 ||
      !isSchedule(update.schedule) ||
      (update.viewers !== undefined && update.viewers !== true) ||
      Object.keys(update).length !==
        3 +
          Number(update.viewers !== undefined) +
          Number(update.changed !== undefined)
    )
      return false;
    seen.add(update.session);
    if (update.changed === undefined) continue;
    if (
      !attempts.delete(update.session) ||
      !Array.isArray(update.changed) ||
      !update.changed.every(
        (lane) => typeof lane === "string" && Object.hasOwn(LANES, lane),
      ) ||
      new Set(update.changed).size !== update.changed.length
    )
      return false;
  }
  return attempts.size === 0;
}

export function validFeedAdvances(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (advance) =>
        isPlainObject(advance) &&
        Object.keys(advance).length === 3 &&
        Number.isSafeInteger(advance.sequence) &&
        Number(advance.sequence) > 0 &&
        typeof advance.session === "string" &&
        advance.session.length > 0 &&
        Number.isFinite(advance.next),
    )
  );
}

export function validFeedResumes(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((resume) => {
      if (
        !isPlainObject(resume) ||
        typeof resume.session !== "string" ||
        !resume.session ||
        (resume.exportProblem !== null &&
          typeof resume.exportProblem !== "string")
      )
        return false;
      const h = resume.history;
      return (
        h === null ||
        (isPlainObject(h) &&
          isSchedule(h.schedule) &&
          (h.last === null || Number.isFinite(h.last)) &&
          isPlainObject(h.viewers) &&
          isPlainObject(h.viewers.lanes) &&
          isPlainObject(h.rates) &&
          Object.entries(h.rates).every(
            ([lane, ticks]) =>
              Object.hasOwn(LANES, lane) &&
              Array.isArray(ticks) &&
              ticks.every(Number.isFinite),
          ) &&
          isPlainObject(h.frames) &&
          Object.entries(h.frames).every(
            ([lane, frame]) =>
              Object.hasOwn(LANES, lane) &&
              isPlainObject(frame) &&
              (frame.kind === "failed"
                ? typeof frame.message === "string"
                : frame.kind === "drawn" &&
                  isPlainObject(frame.bar) &&
                  Array.isArray(frame.bar.rows)),
          ))
      );
    })
  );
}
