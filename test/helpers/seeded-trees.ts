// Seeded generator of layout-tree SHAPES for property tests over the address
// -> colour function (candybar-render-ai7.1). The repo has no fast-check; a
// tree shape is a few lines to generate deterministically, and a seeded run
// is reproducible from its seed alone — a failure names the seed, not a dice roll.
//
// [LAW:effects-at-boundaries] No ambient randomness: every generator takes the
// rng it draws from.

import type { Address } from "../../src/themes/decor";

/** A deterministic PRNG (mulberry32) — uniform in [0, 1). */
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

/** Integer in [0, bound). */
export const drawInt = (rng: Rng, bound: number): number => Math.floor(rng() * bound);

/**
 * One of `items`. [LAW:parse-dont-validate] A draw from nothing is a broken
 * test premise, so it fails loudly here instead of surfacing as an undefined
 * three assertions later.
 */
export function drawFrom<T>(rng: Rng, items: readonly T[]): T {
  const item = items[drawInt(rng, items.length)];
  if (item === undefined) throw new Error("drawFrom: nothing to draw from");
  return item;
}

/** A shape only: nodes carry nothing but children. */
export interface Shape {
  readonly children: readonly Shape[];
}

/** The child indices from the root — a node's identity across shape edits. */
export type Path = readonly number[];

export interface ShapeBounds {
  readonly maxDepth: number;
  readonly maxWidth: number;
}

/** A random shape: each node gets 0..maxWidth children until maxDepth. */
export function drawShape(rng: Rng, bounds: ShapeBounds, depth = 0): Shape {
  const width = depth >= bounds.maxDepth ? 0 : drawInt(rng, bounds.maxWidth + 1);
  return {
    children: Array.from({ length: width }, () => drawShape(rng, bounds, depth + 1)),
  };
}

/** Every node's path with its address (index, sibling count) pairs, pre-order. */
export function allNodes(shape: Shape): readonly { path: Path; address: Address }[] {
  const out: { path: Path; address: Address }[] = [];
  const walk = (node: Shape, path: Path, address: Address): void => {
    out.push({ path, address });
    node.children.forEach((child, index) =>
      walk(child, [...path, index], [...address, { index, count: node.children.length }]),
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

/** A copy of `shape` with the node at `path`'s children replaced. */
export function withChildren(shape: Shape, path: Path, children: readonly Shape[]): Shape {
  if (path.length === 0) return { children };
  const [head, ...rest] = path;
  return {
    children: shape.children.map((child, index) =>
      index === head ? withChildren(child, rest, children) : child,
    ),
  };
}

/** `shape` with one new leaf appended to the node at `path`. */
export const withSiblingAdded = (shape: Shape, path: Path): Shape =>
  withChildren(shape, path, [...nodeAt(shape, path).children, { children: [] }]);

/** `shape` with the node at `path`'s children in a drawn order (sort by a drawn key). */
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

/** A draw of `count` shapes plus their seeds, so a failure names the seed that produced it. */
export function drawShapes(
  baseSeed: number,
  count: number,
  bounds: ShapeBounds,
): readonly { seed: number; shape: Shape; rng: Rng }[] {
  return Array.from({ length: count }, (_, i) => {
    const seed = baseSeed + i;
    const rng = seededRng(seed);
    return { seed, shape: drawShape(rng, bounds), rng };
  });
}
