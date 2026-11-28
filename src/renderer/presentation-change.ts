// [LAW:effects-at-boundaries] Compare the facts a surface's next draw reads.
// A ticking effect changes its pixels without changing its placement recipe.
import { samePlainValue } from "../utils/plain.js";
import type { HeldMotion } from "../render/effect.js";
import type {
  HeldSurface,
  MotionChange,
  Ordered,
  Proposal,
  SurfaceChange,
} from "../renderer-interface/presentation.js";

function edits<K extends string, V>(
  before: ReadonlyArray<readonly [K, V]>,
  after: ReadonlyArray<readonly [K, V]>,
): ReadonlyArray<readonly [K, V | null]> | undefined {
  if (before === after) return undefined;
  const prior = new Map(before);
  const changed: Array<readonly [K, V | null]> = [];
  for (const [key, value] of after) {
    if (!prior.has(key) || !samePlainValue(prior.get(key), value))
      changed.push([key, value]);
    prior.delete(key);
  }
  for (const key of prior.keys()) changed.push([key, null]);
  return changed.length ? changed : undefined;
}

export function surfaceChange(
  before: HeldSurface,
  after: HeldSurface,
): SurfaceChange {
  const { placements, rules, passages, ...source } = after.layout;
  const prior = before.layout;
  const changedSource =
    source.config !== prior.config ||
    source.width !== prior.width ||
    source.preset !== prior.preset ||
    source.revision !== prior.revision;
  const changedPlacements = edits(prior.placements, placements);
  const effectPlacements = edits(
    before.effects.placements,
    after.effects.placements,
  );
  const made = edits(before.effects.made, after.effects.made);
  const copies = edits(before.copies, after.copies);
  const clock = motionChange(before.clock, after.clock);
  return {
    ...(changedSource && { source }),
    ...(changedPlacements && { placements: changedPlacements }),
    ...(!samePlainValue(prior.rules, rules) && { rules }),
    ...(!samePlainValue(prior.passages, passages) && { passages }),
    ...(Object.keys(clock).length > 0 && { clock }),
    ...((effectPlacements || made) && {
      effects: {
        ...(effectPlacements && { placements: effectPlacements }),
        ...(made && { made }),
      },
    }),
    ...(copies && { copies }),
    ...(!samePlainValue(before.warnings, after.warnings) && {
      warnings: after.warnings,
    }),
    ...(after.faults !== before.faults && { faults: after.faults }),
  };
}

function motionChange(before: HeldMotion, after: HeldMotion): MotionChange {
  return {
    ...(!samePlainValue(before.anchor, after.anchor) && {
      anchor: after.anchor,
    }),
    ...(!samePlainValue(before.inForce, after.inForce) && {
      inForce: after.inForce,
    }),
  };
}

export function proposeValue<V, C>(
  prior: Ordered<V> | undefined,
  base: number | undefined,
  value: V,
  diff: (before: V, after: V) => C,
): Proposal<V, C> {
  return prior && prior.order === base
    ? { kind: "change", base, change: diff(prior.value, value) }
    : { kind: "whole", value };
}
