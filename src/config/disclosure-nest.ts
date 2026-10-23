// [LAW:one-source-of-truth] Which disclosures sit inside which, and the rule
// that closes them together (brandon-menus-sjhy.9p6): when a disclosure
// closes — by its trigger, its body's ✕, an accordion sibling opening, a pick
// that closes, the door, ◁ back — everything open inside it goes back to how a
// fresh session finds it, so reopening the parent never reopens what was left
// open under it. The nesting is read off the config, so a disclosure added
// later closes with its parent with no list to keep.
//
// [LAW:effects-at-boundaries] Pure: the daemon's closing view
// (src/daemon/closing-view.ts) reads the session's state and writes what
// `closeNested` returns.

import {
  DISCLOSURE_CLOSED,
  disclosureOfAction,
  type Disclosure,
} from "./disclosure.js";
import {
  placementId,
  type DslConfig,
  type LayoutNode,
  type SegmentNode,
} from "./dsl-types.js";
import { hostedMenus } from "./loader/menu-synth.js";
import { presetNames, presetRoot } from "./presets.js";

// One key a disclosure inside a parent holds, and the values it holds for a
// disclosure OUTSIDE that parent — the one accordion key can hold disclosures
// on both sides of a body (a tab's lists and the door line's theme list
// share one), and closing the body must leave the outside one open.
export interface NestedKey {
  readonly key: string;
  readonly outside: ReadonlySet<string>;
}

export interface DisclosureNest {
  // The keys of every disclosure inside `parent`, at any depth.
  readonly inside: (parent: Disclosure) => readonly NestedKey[];
  // What `key` holds in a fresh session.
  readonly defaultOf: (key: string) => string;
}

// A session with no rendered config has nothing nested to close.
export const NO_NEST: DisclosureNest = {
  inside: () => [],
  defaultOf: () => DISCLOSURE_CLOSED,
};

const idOf = (d: Disclosure): string => `${d.key}\0${d.member}`;

export function buildDisclosureNest(config: DslConfig): DisclosureNest {
  // Every preset places most segments again, so each placement's template is
  // parsed once, not once per preset (the bundled presets: half the build).
  const menus = new Map<string, readonly Disclosure[]>();
  const hostedBy = (node: SegmentNode): readonly Disclosure[] => {
    // An id is unique per preset tree, so two presets may give one to
    // different segments.
    const id = `${node.name}\0${placementId(node)}`;
    const memo = menus.get(id);
    if (memo !== undefined) return memo;
    const template = config.segments[node.name]?.template;
    const found =
      template === undefined ? [] : hostedMenus(template, placementId(node));
    menus.set(id, found);
    return found;
  };
  // The disclosures a placement is the trigger of: the body it opens, and
  // every `{{ menu }}` it hosts.
  const triggeredBy = (node: SegmentNode): readonly Disclosure[] => [
    ...(node.opens === undefined ? [] : [node.opens.ref]),
    ...hostedBy(node),
  ];
  const defaults = new Map<string, string>();
  const declaredWithin = new Map<string, readonly Disclosure[]>();
  for (const decl of Object.values(config.variables)) {
    if (decl.kind !== "state") continue;
    if (decl.default !== undefined) defaults.set(decl.key, decl.default);
    if (decl.within !== undefined) declaredWithin.set(decl.key, decl.within);
  }
  // [LAW:one-source-of-truth] A disclosure sits inside every body enclosing
  // its trigger, and inside whatever its key's state variable declares it
  // `within`.
  const inside = new Map<string, Map<string, Disclosure>>();
  const members = new Map<string, Set<string>>();
  const known = (d: Disclosure): void => {
    members.set(d.key, (members.get(d.key) ?? new Set()).add(d.member));
  };
  const note = (parent: Disclosure, child: Disclosure): void => {
    const children = inside.get(idOf(parent)) ?? new Map<string, Disclosure>();
    children.set(idOf(child), child);
    inside.set(idOf(parent), children);
  };
  const walk = (node: LayoutNode, enclosing: readonly Disclosure[]): void => {
    if (node.kind === "container") {
      for (const child of node.children) walk(child, enclosing);
      return;
    }
    for (const child of triggeredBy(node)) {
      known(child);
      for (const parent of enclosing) note(parent, child);
    }
    if (node.opens !== undefined) {
      walk(node.opens.body, [...enclosing, node.opens.ref]);
    }
  };
  for (const preset of presetNames(config.presets)) {
    walk(presetRoot(config, preset).node, []);
  }
  // A disclosure the bar toggles from where it is not hung (edit mode, from
  // the door's ✎ arrange) is known by its toggle.
  for (const decl of Object.values(config.actions)) {
    const toggled = disclosureOfAction(decl);
    if (toggled !== undefined) known(toggled);
  }
  for (const [key, parents] of declaredWithin) {
    for (const member of members.get(key) ?? []) {
      for (const parent of parents) note(parent, { key, member });
    }
  }
  // A disclosure inside one inside `parent` is inside `parent`.
  const closures = new Map<string, readonly NestedKey[]>();
  const closure = (parent: Disclosure): readonly NestedKey[] => {
    const memo = closures.get(idOf(parent));
    if (memo !== undefined) return memo;
    const found = new Map<string, Disclosure>();
    const visit = (d: Disclosure): void => {
      for (const [id, child] of inside.get(idOf(d)) ?? []) {
        if (found.has(id)) continue;
        found.set(id, child);
        visit(child);
      }
    };
    visit(parent);
    const within = new Map<string, Set<string>>();
    for (const { key, member } of found.values()) {
      within.set(key, (within.get(key) ?? new Set()).add(member));
    }
    // Every child was noted from a trigger, which recorded its member.
    const keys = [...within].map(([key, held]) => ({
      key,
      outside: new Set([...members.get(key)!].filter((m) => !held.has(m))),
    }));
    closures.set(idOf(parent), keys);
    return keys;
  };
  return {
    inside: closure,
    // A disclosure that declares no default starts closed: its toggle counts
    // an unknown value as its first member, `closed`.
    defaultOf: (key) => defaults.get(key) ?? DISCLOSURE_CLOSED,
  };
}

// One memo per loaded config, as the click gate keeps: a reload is a new
// config object and builds its own.
const NESTS = new WeakMap<DslConfig, DisclosureNest>();
export function disclosureNest(config: DslConfig): DisclosureNest {
  const memo = NESTS.get(config);
  if (memo !== undefined) return memo;
  const nest = buildDisclosureNest(config);
  NESTS.set(config, nest);
  return nest;
}

export interface StateWrite {
  readonly key: string;
  readonly value: string;
}

// [LAW:single-enforcer] What a batch of session writes closes: each written
// key that moves off the value it held closes the disclosure open on that
// value, and every key inside it goes back to how a fresh session finds it —
// unless what it holds is a disclosure outside, or the batch writes that key
// itself, which is the click's own decision. The keys to clear, not values to
// write: a fresh session holds none, so the gate a click crosses is never
// asked to admit a value no click sent.
export function closeNested(
  nest: DisclosureNest,
  read: (key: string) => string | null,
  writes: readonly StateWrite[],
): readonly string[] {
  const written = new Set(writes.map((w) => w.key));
  const held = (key: string): string => read(key) ?? nest.defaultOf(key);
  const folds = new Set<string>();
  for (const { key, value } of writes) {
    const was = held(key);
    if (was === value) continue;
    for (const nested of nest.inside({ key, member: was })) {
      const now = held(nested.key);
      const closes =
        now !== nest.defaultOf(nested.key) &&
        !nested.outside.has(now) &&
        !written.has(nested.key);
      if (closes) folds.add(nested.key);
    }
  }
  return [...folds];
}
