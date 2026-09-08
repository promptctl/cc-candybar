// [LAW:effects-at-boundaries] No ambient randomness: every generator takes its rng.

import type { Address, Distribution } from "../../src/themes/decor";

export type Rng = () => number;

export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const drawInt = (rng: Rng, bound: number): number => Math.floor(rng() * bound);

/** [LAW:parse-dont-validate] A draw from nothing is a broken test premise. */
export function drawFrom<T>(rng: Rng, items: readonly T[]): T {
  const item = items[drawInt(rng, items.length)];
  if (item === undefined) throw new Error("drawFrom: nothing to draw from");
  return item;
}

export interface Shape {
  readonly children: readonly Shape[];
}

/** The child indices from the root — a node's identity across shape edits. */
export type Path = readonly number[];

export interface ShapeBounds {
  readonly maxDepth: number;
  readonly maxWidth: number;
}

export function drawShape(rng: Rng, bounds: ShapeBounds, depth = 0): Shape {
  const width = depth >= bounds.maxDepth ? 0 : drawInt(rng, bounds.maxWidth + 1);
  return {
    children: Array.from({ length: width }, () => drawShape(rng, bounds, depth + 1)),
  };
}

/** A shape carries no placer field; the test chooses the distribution. */
export function allNodes(
  shape: Shape,
  distribution: Distribution,
): readonly { path: Path; address: Address }[] {
  const out: { path: Path; address: Address }[] = [];
  const walk = (node: Shape, path: Path, address: Address): void => {
    out.push({ path, address });
    node.children.forEach((child, index) =>
      walk(child, [...path, index], [
        ...address,
        { index, count: node.children.length, distribution },
      ]),
    );
  };
  walk(shape, [], []);
  return out;
}

const childAt = (node: Shape, index: number): Shape => {
  const child = node.children[index];
  if (child === undefined) throw new Error(`no child ${index} of ${node.children.length}`);
  return child;
};

export const nodeAt = (shape: Shape, path: Path): Shape => path.reduce(childAt, shape);

export function withChildren(shape: Shape, path: Path, children: readonly Shape[]): Shape {
  if (path.length === 0) return { children };
  const [head, ...rest] = path;
  return {
    children: shape.children.map((child, index) =>
      index === head ? withChildren(child, rest, children) : child,
    ),
  };
}

export const withSiblingAdded = (shape: Shape, path: Path): Shape =>
  withChildren(shape, path, [...nodeAt(shape, path).children, { children: [] }]);

export function withChildrenPermuted(shape: Shape, path: Path, rng: Rng): Shape {
  const keyed = nodeAt(shape, path).children.map((child) => ({ child, key: rng() }));
  return withChildren(
    shape,
    path,
    keyed.sort((a, b) => a.key - b.key).map(({ child }) => child),
  );
}

export const isUnder = (ancestor: Path, path: Path): boolean =>
  path.length >= ancestor.length && ancestor.every((index, i) => path[i] === index);

export const pathKey = (path: Path): string => path.join(".");

/** No rng is shared across tests, so an isolated run replays a full run's draws. */
export function drawShapes(
  baseSeed: number,
  count: number,
  bounds: ShapeBounds,
): readonly { seed: number; shape: Shape }[] {
  return Array.from({ length: count }, (_, i) => {
    const seed = baseSeed + i;
    return { seed, shape: drawShape(seededRng(seed), bounds) };
  });
}
