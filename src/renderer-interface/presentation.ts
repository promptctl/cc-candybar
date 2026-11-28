// [LAW:no-ambient-temporal-coupling] A draw's order is the host's order of
// dispatch. Its delivery token belongs to the worker and can restart at boot.
import type { SessionId } from "../daemon/foundations/session-id.js";
import type { Lane } from "../config/lanes.js";
import type { HeldLayout } from "../render/held-layout.js";
import type { HeldEffects, HeldMotion } from "../render/effect.js";
import type { RenderWarning } from "../dsl/render.js";
import type { Tick } from "../utils/instant.js";
import type { Crosses } from "./crosses.js";

// [LAW:types-are-the-program] What a presentation belongs to: the surface it
// was shown on, never who asked for the draw. Hover, a transition and what a
// copy click copies are facts of one surface, so a record two surfaces shared
// would be wrong for one of them.
export type DrawSurface = Lane;
// The surface a render request's answer is shown on: Claude Code's statusline.
export const REQUEST_SURFACE: DrawSurface = "statusline";
// [LAW:single-enforcer] Whether a surface's presentation retires when its
// lane's last subscriber leaves: every surface's but the one requests still
// draw, which is still shown.
export const retiresWithFeed = (surface: DrawSurface): boolean =>
  surface !== REQUEST_SURFACE;
export const MAX_PRESENTED_SESSIONS = 256;
export interface HeldSurface {
  readonly layout: HeldLayout;
  readonly effects: HeldEffects;
  readonly copies: ReadonlyArray<readonly [string, string]>;
  readonly warnings: readonly RenderWarning[];
  readonly faults: string;
}
export interface PresentedMenu {
  readonly shown: boolean;
  readonly timeoutS: number;
}
export interface HeldIdle extends PresentedMenu {
  readonly since: Tick;
}
export interface IdleUpdate {
  readonly session: SessionId;
  readonly value: HeldIdle;
}
export interface Ordered<T> {
  readonly order: number;
  readonly value: T;
}
export interface PresentedSession {
  readonly session: SessionId;
  // The host classifies the inputs from which these retained cells came.
  // Only a proven image can become the first input of an exported recording.
  readonly exportProblem: string | null;
  readonly surfaces: Readonly<
    Partial<Record<DrawSurface, Ordered<HeldSurface>>>
  >;
  readonly motion: Ordered<HeldMotion>;
  readonly idle: Ordered<HeldIdle>;
}

// The host pins the version it offers for the duration of the draw and its
// delivery. A worker that holds that version can describe just its changes.
export interface PresentationInput {
  readonly order: number;
  readonly sessions: ReadonlyArray<{
    readonly session: SessionId;
    readonly revision: number;
    readonly bases: Readonly<Partial<Record<DrawSurface, number>>>;
    readonly motion: number;
    readonly resume?: PresentedSession;
  }>;
}

type EntryList = ReadonlyArray<readonly [string, unknown]>;
type Changes<L extends EntryList> = ReadonlyArray<
  readonly [L[number][0], L[number][1] | null]
>;

export interface SurfaceChange {
  readonly source?: Pick<
    HeldLayout,
    "config" | "preset" | "revision" | "width"
  >;
  readonly placements?: Changes<HeldLayout["placements"]>;
  readonly rules?: HeldLayout["rules"];
  readonly passages?: HeldLayout["passages"];
  readonly effects?: {
    readonly placements?: Changes<HeldEffects["placements"]>;
    readonly made?: Changes<HeldEffects["made"]>;
  };
  readonly copies?: Changes<HeldSurface["copies"]>;
  readonly warnings?: readonly RenderWarning[];
  readonly faults?: string;
}

export interface MotionChange {
  readonly anchor?: HeldMotion["anchor"];
  readonly inForce?: HeldMotion["inForce"];
}

export type Proposal<Value, Change> =
  | { readonly kind: "whole"; readonly value: Value }
  | { readonly kind: "change"; readonly base: number; readonly change: Change };

export interface ProposedPresentation {
  readonly surface: Proposal<HeldSurface, SurfaceChange>;
  readonly motion: Proposal<HeldMotion, MotionChange>;
  readonly menu: PresentedMenu;
}

export const PROPOSALS_CROSS: Crosses<ProposedPresentation> = true;
export const PRESENTATIONS_CROSS: Crosses<PresentationInput> = true;

// Both ends materialize a change against the same immutable predecessor.
export function proposedValue<V, C>(
  prior: Ordered<V> | undefined,
  proposal: Proposal<V, C>,
  apply: (before: V, change: C) => V,
): V {
  if (proposal.kind === "whole") return proposal.value;
  if (!prior || prior.order !== proposal.base)
    throw new Error(
      "presentation change names a different base from the one offered",
    );
  return apply(prior.value, proposal.change);
}

function applyEntries<K extends string, V>(
  before: ReadonlyArray<readonly [K, V]>,
  edits?: ReadonlyArray<readonly [K, V | null]>,
): ReadonlyArray<readonly [K, V]> {
  if (edits === undefined) return before;
  const next = new Map(before);
  for (const [key, value] of edits) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return [...next];
}

export function surfaceAfter(
  prior: HeldSurface,
  change: SurfaceChange,
): HeldSurface {
  if (Object.keys(change).length === 0) return prior;
  const {
    placements,
    copies,
    rules,
    passages,
    source,
    effects,
    warnings,
    faults,
  } = change;
  return {
    layout:
      source || placements || rules || passages !== undefined
        ? {
            ...prior.layout,
            ...source,
            placements: applyEntries(prior.layout.placements, placements),
            rules: rules ?? prior.layout.rules,
            passages: passages === undefined ? prior.layout.passages : passages,
          }
        : prior.layout,
    effects: effects
      ? {
          placements: applyEntries(
            prior.effects.placements,
            effects.placements,
          ),
          made: applyEntries(prior.effects.made, effects.made),
        }
      : prior.effects,
    copies: applyEntries(prior.copies, copies),
    warnings: warnings ?? prior.warnings,
    faults: faults ?? prior.faults,
  };
}

export function motionAfter(
  prior: HeldMotion,
  change: MotionChange,
): HeldMotion {
  if (Object.keys(change).length === 0) return prior;
  return {
    anchor: change.anchor ?? prior.anchor,
    inForce: change.inForce === undefined ? prior.inForce : change.inForce,
  };
}

// [LAW:no-ambient-temporal-coupling] An older draw cannot undo a click or
// reopen an idle period that already expired while its delivery was pending.
export function idleAfterDraw(
  prior: HeldIdle | undefined,
  menu: PresentedMenu & { readonly tick: Tick },
): HeldIdle {
  const { tick, shown, timeoutS } = menu;
  if (prior === undefined) return { since: tick, shown, timeoutS };
  if (tick < prior.since) return prior;
  const since = shown && !prior.shown ? tick : prior.since;
  return { since, shown, timeoutS };
}
