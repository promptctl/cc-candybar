// [LAW:types-are-the-program] DslConfig is the strongest theorem we can write
// about a validated config: every legal config is representable, every illegal
// one is not. The loader is the proof — its body either narrows `unknown` to
// `DslConfig` or throws ConfigError. Downstream consumers receive a DslConfig
// and are free to assume invariants (closed source-kind set, exactly-one cache
// key, no dangling cross-refs, no template cycles) without re-checking.
//
// [LAW:one-source-of-truth] These shapes are the JSON-shape mirror of the
// var-system's runtime types (`CachePolicy`, `ShellOptions`, etc. in
// src/var-system/sources.ts). The loader is the single point that translates
// between the two; no other module should re-derive these shapes.

// [LAW:one-way-deps] The action schema lives in its own leaf module; DslConfig
// references it here. The dependency is one-way (this file → action.ts), never
// the reverse, so that shape can be lifted out without a cycle.
import type { ActionDecl } from "./action.js";
// [LAW:one-source-of-truth] A style IS a rich-js ThemeKey (four numeric axes:
// hueShift / chromaScale / lightnessScale / lightnessShift) — the config type
// references the vocabulary owner's type verbatim, so a rich-js axis rename is
// a compile error here, never silent drift. Type-only: no runtime rich-js
// dependency enters the config layer.
import type { ThemeKey } from "@promptctl/rich-js";
import type { Axis, DistributionName } from "../themes/decor.js";
import type { JsonValue } from "../var-system/types.js";
import type { SegmentGroup } from "./segment-groups.js";
import type {
  GlobalFieldRows,
  GlobalsOf,
  ThemeDefaultField,
} from "./globals-fields.js";
import {
  FOLLOW_BAR,
  isPlacementThemeName,
  parseSessionInt,
  PLACEMENT_EFFECTS,
} from "../themes/policy.js";

// [LAW:types-are-the-program] Three stages, three names.
//
//   RawDslConfig    — the user-file shape. Every top-level key is optional
//                     because "user didn't write this" is a representable,
//                     distinct state from "user wrote an explicit empty."
//                     Internal to the loader module; downstream consumers
//                     never see it.
//
//   DslConfig       — the effective shape: the user's deltas merged on top
//                     of DEFAULT_DSL_CONFIG. Every top-level key is required.
//                     Output of `loadConfig`. Cross-refs and cycles have NOT
//                     yet been checked at this stage.
//
//   ValidatedConfig — DslConfig + a phantom brand proving validateRenderable()
//                     has run. The renderer accepts only this type, so the
//                     compiler structurally enforces "no unvalidated config
//                     can reach rendering." The brand is module-scoped via
//                     `unique symbol`, so the only construction site is
//                     `validateRenderable` itself.
// [LAW:types-are-the-program] The recursive layout substrate collapses to
// exactly two kinds: a `segment` leaf (a ref into the named `segments` block —
// THE unit of rendering, a single template that IS its content) or a
// `container` whose `direction` is DATA that decides how its children map onto
// the 2D plane. Both the bar and (a later child's) menu are projections of this
// one tree — they differ only in `direction`, not in code path
// [LAW:dataflow-not-control-flow].
//
// [LAW:types-are-the-program] `Direction` carries the projection a container
// applies to its child blocks as DATA. `vertical` STACKS them (concat the
// children's line-lists); `horizontal` ZIPS them (per row, the children's cells
// concatenate into one strip, so the powerline joiner caps ACROSS the seam —
// abut is never valid). `outline` (a later child's menu) is NOT in the union
// yet — it joins as a new arm only when its renderer exists, so the union stays
// the strongest theorem that is still TRUE, with no representable-but-
// unrenderable direction.
// [LAW:one-source-of-truth] The runtime list and the type derive from one
// declaration; the loader validates a container's `direction` against this set,
// and drawDsl's projection switch is exhaustive over it (adding an arm here
// forces a matching render arm).
export const DIRECTIONS = ["vertical", "horizontal"] as const;
export type Direction = (typeof DIRECTIONS)[number];

// [LAW:one-source-of-truth] What a container's children are to the bar's
// colour: a vertical container stacks ROWS (which choose the hue), a
// horizontal one lines up the CELLS of a row (which choose the shade). Read by
// the address builder (`placeChildren`) and by the loader's refusal of a
// `distribution` inside a row. [LAW:types-are-the-program] Total over
// Direction, so a new direction is a compile error here.
export const AXIS_OF: Readonly<Record<Direction, Axis>> = {
  vertical: "row",
  horizontal: "cell",
};

// [LAW:one-type-per-behavior] THE unit of rendering: a ref into the named
// `segments` block. A segment IS a single template (text, state-driven display,
// clickable regions — whatever the template produces); there is no `inline` /
// `stepper` / `picker` node kind, because "make a node flexible enough for
// whatever" = one template expresses anything. A segment renders to ONE strip
// item; the powerline joiner joins items, never inside one. A horizontal run of
// segments is spelled `{ h: ["seg1", "seg2"] }` in the A-grammar.
export interface SegmentNode {
  readonly kind: "segment";
  // A name into the `segments` block — the DEFINITION this placement is an
  // instance of. Its template/palette/`when` live on its SegmentDecl.
  readonly name: string;
  // The placement's identity (brandon-segment-settings-i4n): what a menu's
  // open state, edit mode's `✖`/`✚`, and the config-file editor address. A
  // name, never a position — positions shift when a sibling is added or
  // removed. Absent ≡ the segment's name, so `"git"` and
  // `{ seg: "git", id: "git" }` are one placement; read it through
  // `placementId`, never `node.id` directly. Unique across the tree a preset
  // renders (cross-ref.ts).
  readonly id?: string;
  // This placement's values for the settings its segment declares
  // (SegmentDecl.settings) — only the ones that differ from the declared
  // default. The segment's templates read the resolved set as `.settings`,
  // so two placements of one segment never share a value.
  readonly settings?: Readonly<Record<string, SettingValue>>;
  // [LAW:dataflow-not-control-flow] Absent `when` ≡ always-rendered. A node-level
  // predicate, ANDed with the segment-decl's own `when` at render.
  readonly when?: string;
  // [LAW:types-are-the-program] The disclosure BODY this segment opens, hung on
  // the trigger that opens it (candybar-render-ai7.9). A body is a plane under
  // its trigger, not a sibling of it: the band it is coloured on takes the
  // trigger's own vocabulary hue, and a body that sat beside its trigger could
  // reach that hue only through walk order. `ref` names the open state; the
  // body carries no `when` of its own — the walk derives "open" from `ref`
  // (`disclosureGate`) at compile, so the gate and the trigger's cycle cannot
  // drift. A hidden trigger (its `when` or its decl's) renders no body.
  // Synthesis-only: `disclosureNode` (src/config/disclosure.ts) is the one
  // producer and the loader's segment schema does not list the field, so no
  // config can author it.
  readonly opens?: Opens;
  // Templates drawn inside this segment's own cell, before (`lead`) and after
  // (`trail`) its content and outside any sizing, so they read as part of the
  // segment: edit mode's configure and remove buttons, which have to sit
  // against the segment they act on. Synthesis-only, like `opens`.
  readonly lead?: string;
  readonly trail?: string;
  // Where this placement's unsaved setting values live (brandon-segment-
  // settings-i4n.g64): setting name → the session key configure mode's
  // controls write and the `state` variable that reads it. The placement's
  // templates read `.settings` through these, so a pick shows the moment it
  // is made and `💾 save` writes it into the placement.
  // Synthesis-only, like `opens`: edit chrome mints one per declared setting.
  readonly drafts?: Readonly<Record<string, DraftSlot>>;
  // The layer that placed this cell through its `insert` list rather than
  // authoring it in a root: the file and the entry. Synthesis-only, like
  // `opens`: the loader's one insert pass stamps it and no config can write
  // it. Edit mode reads it to offer no edit on a cell that is an insert entry,
  // which no click rewrites.
  readonly insertedBy?: InsertedBy;
}

export interface InsertedBy {
  readonly file: string;
  readonly entry: string;
}

// [LAW:types-are-the-program] One cell a layer adds beside a placement its
// bar already has: the edit-mode insert's addressing (an anchor placement id
// and a side), so a layer never restates a row to add to it. Stamped at
// parse with the file and entry that wrote it, which the loader's insert
// pass carries onto the cell it places.
export interface InsertCell {
  readonly seg: string;
  readonly id?: string;
  readonly anchor: string;
  readonly relation: "before" | "after";
  readonly by: InsertedBy;
}

// One setting's unsaved value: the session key it is held at, and the `state`
// variable a template reads it through — minted together, so a reader of the
// key never looks the variable up to find it.
export interface DraftSlot {
  // The placement whose value it is. A name label carries its placement's
  // `theme` slot too, so the node holding a slot is not always its owner.
  readonly id: string;
  readonly key: string;
  readonly variable: string;
}

// [LAW:one-source-of-truth] THE identity of a placement: its authored `id`,
// else its segment's name. Every reader of "which placement is this" asks
// here, so a bare ref and its explicit spelling can never be two identities.
export function placementId(node: SegmentNode): string {
  return node.id ?? node.name;
}

// The id of every placement in a tree, in walk order.
export function placementIds(tree: LayoutNode): string[] {
  return [...walkNodes(tree)].flatMap((n) =>
    n.kind === "segment" ? [placementId(n)] : [],
  );
}

// The id a new placement of `segment` takes beside the ids `taken`: the
// segment's name while it is free, else the first free `<name>-<n>`, n from 2.
export function freePlacementId(
  segment: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(segment)) return segment;
  let n = 2;
  while (taken.has(`${segment}-${n}`)) n++;
  return `${segment}-${n}`;
}

// Where an open body's rows go: `drop` hangs them below the trigger's row;
// `above` lifts them over the whole bar, and the trigger rises with them to
// lead their first row as the body's close, so the bar's rows render as if
// the trigger were absent (brandon-menu-ia-q30.4oj — the settings door).
export type Placement = "drop" | "above";

export interface Opens {
  readonly ref: DisclosureRef;
  readonly body: ContainerNode;
  readonly placement: Placement;
}

// [LAW:types-are-the-program] One open disclosure, named by the three strings
// that decide it: the VARIABLE a body reads, the state KEY a close writes, and
// the MEMBER value that means "this one is open". Variable and key are distinct
// because a group's variable is per-group (`groups.<name>`) while its state
// key may be shared with accordion siblings — so the triple, never a lone key,
// is what identifies an open state: the read handle and the write target of
// one fact, carried together so the ✕ that leads every line of an open body
// (brandon-disclosure-43z) writes exactly the key the trigger's cycle gates,
// with no name-join at render to drift from it. It lives here, beside the node
// that carries it, so the tree type and the disclosure primitive
// (src/config/disclosure.ts) read one definition.
export interface DisclosureRef {
  readonly variable: string;
  readonly key: string;
  readonly member: string;
}

// [LAW:dataflow-not-control-flow] A segment with the body it opens rewritten by
// `f` — total: a segment that opens nothing is returned as it is. Every tree
// rewrite that recurses into containers (edit chrome's splice) recurses into
// bodies through this one function, so a body can never be the subtree a
// rewrite forgot.
export function mapOpens(
  node: SegmentNode,
  f: (body: ContainerNode) => ContainerNode,
): SegmentNode {
  return node.opens === undefined
    ? node
    : { ...node, opens: { ...node.opens, body: f(node.opens.body) } };
}

export interface ContainerNode {
  readonly kind: "container";
  readonly direction: Direction;
  readonly children: readonly LayoutNode[];
  // A container's `when` gates the whole subtree: a hidden container emits no
  // lines.
  readonly when?: string;
  // How this container PLACES its children when their decorative colour is
  // selected from the theme's vocabulary (src/themes/decor.ts): the name of one
  // of the five shipped distributions. Absent ≡ `van-der-corput`, resolved once
  // at compile (`placedBy`). Per instance, not global: a `{{ menu }}`'s band is
  // the other kind of placer and carries the SAME field in its options dict.
  // Read on a row, which places every leaf it nests, and on a stack of rows;
  // refused anywhere inside a row. Choosing `monotonic` / `ends-interleaved`
  // reads the row's count, the farthest place any of its lines reaches, so
  // adding a cell anywhere in the row re-spaces all of it — a trade the author
  // spends knowingly.
  readonly distribution?: DistributionName;
  // A horizontal container whose children share ONE place on the row: edit
  // mode's chrome around the content cell it edits. Every other container
  // inside a row is layout, and each leaf it holds takes its own place, since
  // its cells sit side by side (`placeChildren` in src/dsl/node-registry.ts).
  // A unit is one place so that entering edit mode recolours no cell.
  // Synthesis-only, like a segment's `opens`: edit chrome is the one producer,
  // and neither the node schema nor the root's lists the field.
  readonly unit?: true;
}

export type LayoutNode = ContainerNode | SegmentNode;

// [LAW:types-are-the-program] THE canonical root: an insertion-ordered map of
// NAMED rows, stacked vertically (`rootNode` in root.ts is the one projection
// to the tree the render walk consumes). Every shipped root is a vertical stack
// of rows — a bare `h` root is one row — so the map is the strongest theorem
// that is still true of the domain, and it is exactly the shape the by-name
// cascade every other section merges with (`{ ...dflt.rows, ...raw.rows }`):
// a file declares only the rows that differ, the rest inherit in place, a new
// name appends, and an empty row (`{ h: [] }`, a container contributing no
// line) removes one. Row names are identifiers — never integer-like, which is
// what keeps JS property order equal to authoring order under that spread —
// and a whole-tree fragment lowers to positional rows named `#1`, `#2`, …
// (unauthorable by the identifier rule, so they can never shadow a user's).
// The root IS the vertical container its rows stack into, so it carries every
// field a container owns besides the children it places — `when` gates the
// whole bar, `distribution` places the rows — by derivation, not by listing: a
// field added to ContainerNode reaches the root, its lowering (`rootOf`), its
// projection (`rootNode`), and the rows-fragment schema (RecordSchema<Root>
// fails to typecheck until it lists the field) without a second edit. `unit`
// is no field of a root: the root stacks rows, and only synthesis marks one.
export type ContainerOwn = Omit<
  ContainerNode,
  "kind" | "direction" | "children" | "unit"
>;
export interface Root extends ContainerOwn {
  readonly rows: Readonly<Record<string, LayoutNode>>;
}

// [LAW:types-are-the-program] What a file or a preset AUTHORS at `root`: a
// whole tree ("here is my bar" — replaces the base's rows outright) or a rows
// map ("here are my rows" — merges by name over the base). The two are the
// author's own two intents, discriminated by the shape they wrote (`"rows" in
// fragment`), and that is the single branch `mergeRoot` folds over. A tree
// fragment's JSON is a LayoutNode and a rows fragment's JSON is a Root, so the
// canonical shape and the authoring shape coincide — the raw default literal
// is read as both without translation.
export type RootFragment = LayoutNode | Root;

// [LAW:types-are-the-program] The `group` SUGAR as collected at parse — an
// INPUT-only shape, never a canonical LayoutNode kind: arranging + gating are
// behaviors `container` already has, so "group" may only be a spelling. The
// loader lowers each group to container/segment nodes and SYNTHESIZES its state
// var + cycle action + toggle segment under the reserved `groups.` namespace
// (one declaration; every derived artifact single-sourced from it
// [LAW:one-source-of-truth]). `path` records the node's tree position so the
// nesting invariant (an ancestor and a descendant must not share a state key)
// is checkable after the walk.
export interface GroupSugarDecl {
  readonly name: string;
  readonly label: string;
  readonly open?: boolean;
  readonly direction?: Direction;
  readonly key?: string;
  readonly bg?: string;
  readonly fg?: string;
  readonly when?: string;
  readonly path: string;
}

// [LAW:single-enforcer] THE one pre-order walk over a node tree. Every consumer
// that needs "which segments / which `when` predicates does this layout name"
// (the reachability closure, the debug dump, the cross-ref validator) iterates
// this — none re-recurses the tree itself.
export function* walkNodes(node: LayoutNode): IterableIterator<LayoutNode> {
  yield node;
  // A disclosure body is part of the tree its trigger stands in — a segment
  // inside one is reachable, referenced, and cross-checked like any other.
  for (const child of childrenOf(node)) yield* walkNodes(child);
}

// [LAW:one-source-of-truth] The diagnostic path of a node's subtrees, spelled
// once for the compile (node-registry.ts) and the load-time checks
// (cross-ref.ts). The two walk different trees — the compile the synthesized
// one, cross-ref the file's own fragment — so only cross-ref's path is one the
// author wrote; that is why every check of what a file wrote lives there.
export const childPath = (path: string, i: number): string =>
  `${path}.children[${i}]`;
export const bodyPath = (path: string): string => `${path}.opens.body`;

// walkNodes, with each node's diagnostic path beside it.
export function* walkNodePaths(
  node: LayoutNode,
  path: string,
): IterableIterator<readonly [LayoutNode, string]> {
  yield [node, path];
  if (node.kind === "container") {
    for (const [i, child] of node.children.entries()) {
      yield* walkNodePaths(child, childPath(path, i));
    }
  } else if (node.opens !== undefined) {
    yield* walkNodePaths(node.opens.body, bodyPath(path));
  }
}

// [LAW:one-source-of-truth] THE subtrees a node owns: a container's children,
// a segment's disclosure body. The walk and every count over it read this, so
// "what is under this node" has one answer for both kinds.
export function childrenOf(node: LayoutNode): readonly LayoutNode[] {
  return node.kind === "container"
    ? node.children
    : node.opens === undefined
      ? []
      : [node.opens.body];
}

// [LAW:types-are-the-program] A PRESET is a named config FRAGMENT — one
// alternative arrangement of a bar the user can switch to — and its field set
// is capped at exactly `root` + `globals`. That cap is not taste; it is the
// daemon's own lifetime boundary made into a type.
//
// One RenderCache entry is keyed by (projectDir, cwd) and serves MANY sessions.
// Its SourceRegistry (timers, fs watchers) is built ONCE,
// in buildState, and its click gate (stateGate) is derived once per config. A preset, by contrast, is a per-SESSION pick. So a
// preset carrying `variables` would need a per-session registry, and one
// carrying `actions` would need a per-session wire gate — or a gate that is the
// union of every preset's actions anyway, at which point the preset scoped
// nothing and only the merge got harder [LAW:no-ambient-temporal-coupling].
// `root` and `globals` have no such problem: the root is WALKED per render (so
// every preset's tree is compiled up front and one is selected by name, exactly
// how every style's ThemeKey is resolved up front and one is selected by name),
// and globals already resolve per render into EffectiveGlobals.
//
// Read as a rule an author can hold: a preset may carry what the bar RESOLVES
// each render, never what the daemon REGISTERS once per process. An unbounded
// preset would just be a second config file with extra steps.
export interface PresetDecl {
  // The preset's layout as a FRAGMENT over the config's own root (root.ts's
  // mergeRoot): a tree restages the whole bar, a rows map restages only the
  // rows it names, and absent — the empty rows map, the merge's identity —
  // restages nothing, so the config's own root renders. A preset declares only
  // its delta [LAW:carrying-cost] — a preset that had to restate every row to
  // change one would be a copy, and copies go stale silently while continuing
  // to look intentional.
  readonly root?: RootFragment;
  // Absent ⇒ no display-default changes. Shallow-merged OVER the config's own
  // globals when this preset is active, so a preset naming `padding` says
  // nothing about `endcaps`.
  readonly globals?: Globals;
}

// [LAW:types-are-the-program] One theme's default look: a globals fragment
// over exactly the rows marked `themeDefault` (THEME_DEFAULT_FIELDS,
// src/config/globals-fields.ts), names only. It sits one rung BELOW the
// config's own globals in the precedence chain (src/config/theme-defaults.ts),
// so a theme's default never outranks what a user's file says; it only fills
// what the file leaves unsaid.
export type ThemeDefault = Partial<Pick<Globals, ThemeDefaultField>>;

export interface RawDslConfig {
  readonly globals?: Partial<Globals>;
  readonly variables?: Readonly<Record<string, VariableDecl>>;
  // Complete declarations, or deltas over bundled ones — see RawSegmentDecl.
  readonly segments?: Readonly<Record<string, RawSegmentDecl>>;
  // A fragment over the bundled default's root — see RootFragment: a tree
  // replaces the default's rows, a rows map merges over them by name.
  readonly root?: RootFragment;
  // Cells added beside placements of the bar this layer merges over. The
  // loader places every layer's cells once, into each root that renders
  // (presets.ts's placeInserts); the merged config holds only the result.
  readonly insert?: readonly InsertCell[];
  readonly actions?: Readonly<Record<string, ActionDecl>>;
  // Named config fragments ("presets"): each an alternative `root`/`globals`
  // arrangement selected per session, the exact twin of `styles` one level up
  // (a style adapts the THEME; a preset adapts the LAYOUT + display globals).
  // Both fields are optional, so a file's preset is always a delta over a
  // bundled one of the same name — laid over it field by field, like a
  // segment's (loader/merge.ts).
  readonly presets?: Readonly<Record<string, PresetDecl>>;
  // The display globals edit mode stages while it is on — see DslConfig's own
  // `editGlobals` for the shape, the merge, and where it sits in the chain.
  readonly editGlobals?: Partial<Globals>;
  // Named theme-adaptation bundles ("styles"): each is a full ThemeKey (the
  // loader normalizes absent axes to identity at parse). Applied ON TOP of the
  // active theme at render — a transform composing with every theme, selected
  // per session exactly like theme/style (session key `style`).
  readonly styles?: Readonly<Record<string, ThemeKey>>;
  // Each installed theme's default look, keyed by theme name — see DslConfig's
  // own `themeDefaults`. A file's entry is a delta over the bundled one of the
  // same name, laid over it field by field (loader/merge.ts).
  readonly themeDefaults?: Readonly<Record<string, ThemeDefault>>;
  // [LAW:single-enforcer] Config-level shared helper templates: name → Go-template
  // body. Each compiles to one `{{ define "name" }}body{{ end }}` unit, and the
  // whole set into one shared define set every template this config parses
  // inherits — so a formatter (`{{ template "formatCost" .x }}`) is
  // defined ONCE and callable from any segment/predicate, never re-inlined per
  // segment. Absent ≡ no helpers; merges by-name (user overrides a helper).
  readonly helpers?: Readonly<Record<string, string>>;
  // Plugin definition paths (loader/plugins.ts), relative to the file that
  // lists them. Consumed by the load, which merges each plugin between the
  // bundled default and this file; absent from the merged DslConfig.
  readonly plugins?: readonly string[];
}

export interface DslConfig {
  readonly globals: Globals;
  readonly variables: Readonly<Record<string, VariableDecl>>;
  readonly segments: Readonly<Record<string, SegmentDecl>>;
  // [LAW:one-source-of-truth] The SINGLE canonical layout representation: the
  // merged rows map (see Root). Authored via the A-grammar (seg/h/v node arms,
  // group sugar) as a whole tree or a `{ rows }` map; no legacy sugar reaches
  // this field — the loader rejects `layout:` and `kind:"cells"` with
  // migration errors. Consumers that walk a tree take `rootNode(root)`.
  readonly root: Root;
  // [LAW:locality-or-seam] The named seam between click BEHAVIOR and the
  // clickable REPRESENTATION. Each entry is a statically-declared effect a
  // segment template binds a region to via `{{ action "name" … }}`. The
  // writable-key gate derives from this table (deriveActionValidators), so a
  // template cannot smuggle an un-gated write. Empty when no config declares
  // actions — an absent `actions` key merges to `{}`.
  readonly actions: Readonly<Record<string, ActionDecl>>;
  // [LAW:one-source-of-truth] The effective style set: name → full ThemeKey.
  // Merges by name with the bundled default (user wins per name), like
  // segments/actions/variables — so the default's `none` (the identity style and
  // the resolution floor of effectiveStyleName) is present in EVERY merged
  // config by construction. An action `{ set: …, from: "styles" }` ranges these
  // names; the derived click gate and the rendered options read this one map.
  readonly styles: Readonly<Record<string, ThemeKey>>;
  // [LAW:one-source-of-truth] The effective preset set: name → config fragment.
  // Merges by name with the bundled default (user wins per name) like every
  // other section — so the default's `default` preset (the empty fragment, and
  // the resolution floor of effectivePresetName) is present in EVERY merged
  // config by construction, exactly as `styles` guarantees `none`. An action
  // `{ set: …, from: "presets" }` ranges these names; the derived click gate and
  // the rendered options read this one map.
  readonly presets: Readonly<Record<string, PresetDecl>>;
  // [LAW:one-source-of-truth] Each installed theme's default look
  // (candybar-theme-colours-6fq5.ix8): theme name → the shade, variation and
  // style that theme wears when nothing above its rung says otherwise. Merges
  // by theme name, then field by field, over the bundled default's — the
  // presets overlay. Read only through `themeDefaultsOf`
  // (src/config/theme-defaults.ts), which is where the rung sits in the chain.
  readonly themeDefaults: Readonly<Record<string, ThemeDefault>>;
  // [LAW:one-source-of-truth] The display globals edit mode stages while it is
  // on — the `globals` half of the fragment whose `root` half edit chrome
  // already stages (src/config/edit-chrome.ts). Merges FIELD BY FIELD with the
  // bundled default's (like `globals` itself and `root`'s rows), so a
  // user retuning the separator keeps the bundled `endcaps: "plain"`.
  //
  // [LAW:types-are-the-program] `Partial<Globals>`, deliberately NOT
  // `PresetDecl`: a preset is root + globals, and edit mode needs only the
  // globals half. Taking the wider type to use half of it would make "an edit
  // fragment that restages the layout" representable — a second authority over
  // a tree edit-chrome already owns. The loader additionally rejects `preset`
  // inside it, for the same reason a preset may not select a preset.
  //
  // Its rung in the precedence chain is the RIGHTMOST one (see
  // src/config/presets.ts): it outranks even a session pick, because entering
  // edit mode is decided later than picking endcaps. Nothing writes it back to
  // SessionState or the config file, which is why leaving edit mode
  // restores the previous style with no save/restore path
  // [LAW:dataflow-not-control-flow].
  readonly editGlobals: Partial<Globals>;
  // [LAW:single-enforcer] The effective helper set: a name → template-body map
  // compiled to one shared define set at registerDslConfig. Empty when no config
  // declares helpers — an absent `helpers` key merges to `{}` (same cascade as
  // actions). The single definition site for each formatter/transform a template
  // calls via `{{ template "name" .arg }}`.
  readonly helpers: Readonly<Record<string, string>>;
}

// [LAW:single-enforcer] The brand symbol is `unique` and module-private —
// nothing outside this file can construct a value carrying it. The only
// production-path producer is validateRenderable() in dsl-loader.ts (one
// callsite of `config as ValidatedConfig`). Renderer signatures require
// ValidatedConfig; the type system therefore proves the validation step
// ran before any render path consumed the config.
declare const __validated: unique symbol;
export type ValidatedConfig = DslConfig & {
  readonly [__validated]: true;
};

// [LAW:one-source-of-truth] The `globals:` block a config authors, derived
// from the globals rows (src/config/globals-fields.ts): every field optional,
// typed by its row's spec, and documented there beside its floor and control.
export type Globals = GlobalsOf<GlobalFieldRows>;

// [LAW:one-type-per-behavior] One discriminated union covers every source
// kind. Adding a new kind = code change here + matching runtime support in
// var-system. There is no "extension" path that bypasses this list.
export type VariableDecl =
  | AuthoredVariableDecl
  | DroppedVarDecl
  | SourceVarDecl;

// What a config may write under `variables:`.
export type AuthoredVariableDecl =
  | LiteralVarDecl
  | InputVarDecl
  | EnvVarDecl
  | FileVarDecl
  | ShellVarDecl
  | TemplateVarDecl
  | TimeVarDecl
  | StateVarDecl;

// [LAW:no-silent-failure] A plugin's data variable when the plugin did not
// load: a DOCUMENT whose one outcome is the drop, so every template reading
// `.<scope>.<plugin>.data…` renders ⚠ naming why rather than failing the
// config that reads it. Synthesized by the plugin loader, never authored —
// the variable loader accepts no `kind: "dropped"`.
export interface DroppedVarDecl {
  readonly kind: "dropped";
  readonly reason: string;
  // The path of the definition that dropped: the drop's identity.
  readonly definition: string;
}

// [LAW:one-type-per-behavior] A plugin's source (design-docs/PLUGIN-API.md):
// a DOCUMENT read, per session, from the plugin's managed storage — the file
// `<storage>/<session id>.json` its program writes. Its reading reaches the
// view through the payload, at the variable's own name, so it is declared by
// the view a session's declaration holds it for. Synthesized by the plugin
// loader from a definition's `sources:`, never authored — the variable loader
// accepts no `kind: "source"`.
export interface SourceVarDecl {
  readonly kind: "source";
  // The folder the plugin's program writes its session files into: the
  // plugin folder's real path, then `session`.
  readonly storage: string;
}

export interface LiteralVarDecl {
  readonly kind: "literal";
  readonly value: string | number | boolean;
  readonly default?: string;
}

// [LAW:types-are-the-program] `type` carries the runtime kind of the value at
// the resolved payload path. Number/bool are needed for the usage/cost/today
// family — token counts, cost amounts, percentages — whose formatters
// (`formatCost`, `formatTokens`, `round`, `budgetStatus`) take numeric inputs.
// Absent `type` defaults to "string" at the loader, preserving the historical
// behavior of every existing declaration. The default value's literal type
// must match the declared type — a number default on a string-typed input
// (or vice versa) is rejected at load time, not at first render.
export interface InputVarDecl {
  readonly kind: "input";
  readonly path: string;
  readonly type?: "string" | "number" | "boolean";
  readonly default?: string | number | boolean;
}

export interface EnvVarDecl {
  readonly kind: "env";
  readonly name: string;
  readonly default?: string;
}

export interface FileVarDecl {
  readonly kind: "file";
  readonly path: string;
  // What text the file yields to the parser — the whole file (default) or
  // its first line. A READER fact, orthogonal to `parse`: a regex or json
  // parse applies to whichever text readMode selected.
  readonly readMode?: "whole" | "first-line";
  readonly parse?: ParseDecl;
  readonly cache: CacheDecl;
  readonly default?: SourceDefault;
}

export interface ShellVarDecl {
  readonly kind: "shell";
  readonly command: string;
  readonly parse?: ParseDecl;
  readonly cache: CacheDecl;
  readonly default?: SourceDefault;
}

// [LAW:types-are-the-program] The parse step of a shell/file source, authored
// as a present-key union exactly like `cache:`: `{ text: true }` is the
// identity (and what an absent `parse:` means), `{ regex: "…" }` slices
// capture group 1 out of the text, `{ json: true }` parses the whole text as
// a DOCUMENT whose fields templates read by dotted path (`.budget.spent`) —
// the way an `input` var's payload subtree is read. The loader (parseSpec in
// loader/variables.ts) interprets it, declareOne (src/dsl/render.ts) lowers
// it onto the runtime's SourceParse. The retired top-level `regex:` is a
// migration-pointing load error, not an alias — one spelling per fact.
export type ParseDecl =
  | { readonly text: true }
  | { readonly regex: string }
  | { readonly json: true };

// [LAW:one-source-of-truth] THE discriminator over the present-key union:
// which arm a `parse:` names (absent = text). Cross-ref's "is this a
// document" and render's lowering onto SourceParse both switch on it, so
// which arm publishes a document is spelled once, by key presence.
export function parseArm(
  parse: ParseDecl | undefined,
): "text" | "regex" | "json" {
  if (parse === undefined || "text" in parse) return "text";
  return "regex" in parse ? "regex" : "json";
}

// A source's `default` lives in its parser's OUTPUT domain — a string for the
// text/regex arms, a JSON document for the json arm. The type is the union of
// both domains; the loader's sourceDefaultSpec is the single enforcer of the
// arm↔default pairing, and declareOne's lowering trusts that stamp. `null` is
// excluded: a document with no fields is not a fallback anyone can read.
export type SourceDefault = Exclude<JsonValue, null>;

// [LAW:types-are-the-program] No `cache`: a template variable is a computed
// that tracks every variable it reads, so it changes exactly when they do.
// `type` is what its text is read as, as an input's is, so a derived number
// (an age, an ETA) compares and ramps like the input it replaces.
export interface TemplateVarDecl {
  readonly kind: "template";
  readonly template: string;
  readonly type?: "string" | "number" | "boolean";
  readonly default?: string | number | boolean;
}

// [LAW:types-are-the-program] No `cache`: a time variable is the instant its
// render is drawn at, formatted, so there is nothing to refresh.
export interface TimeVarDecl {
  readonly kind: "time";
  readonly layout: string;
  readonly default?: string;
}

// [LAW:one-source-of-truth] A `state` variable reads through to the daemon's
// SessionState (the canonical store for per-session toggles, random picks,
// click-mutated values). Reactivity is wired by SessionState's internal MobX
// atom — a click verb that writes into SessionState invalidates this
// variable's downstream computeds automatically. Persistence rides for free
// on SessionState's disk backing.
//
// The session id is resolved from the conventional `session.id` variable —
// that name is the canonical anchor for "which session am I in," declared
// once by DSL configs as an input variable carrying hook_data.session_id.
// [LAW:no-mode-explosion] No per-decl override knob: a single canonical
// session-id source keeps every state var's resolution uniform and removes
// an axis along which configs could drift from each other.
export interface StateVarDecl {
  readonly kind: "state";
  readonly key: string;
  readonly default?: string;
  // The disclosures this key's own disclosure sits inside without hanging in
  // their body — edit chrome is gated on edit mode by `when`, not hung under
  // it — so closing one returns this key to its default, as closing a body
  // returns what hangs in it (src/config/disclosure-nest.ts). Synthesis-only,
  // like `SegmentNode.opens`: the loader's variable schema does not list it.
  readonly within?: readonly DisclosureRef[];
}

// [LAW:dataflow-not-control-flow] The discriminator is "which key is present"
// in the user's JSON — not a `kind` field. Encoded as a 5-arm union so the
// type system enforces "exactly one of these." The loader validates the
// runtime invariant (one and only one); the type then carries it forward.
export type CacheDecl =
  | TtlCacheDecl
  | { readonly watch_file: string }
  | { readonly depends_on: readonly string[] }
  | { readonly key: string }
  | { readonly never: true };

// [LAW:one-source-of-truth] The ttl arm named once, so the kinds that honor
// only a refresh interval (time) reference the same member the full vocabulary
// is composed from — narrowing is a subset, never a parallel shape.
export interface TtlCacheDecl {
  readonly ttl: string;
}

export const CACHE_KEYS = [
  "ttl",
  "watch_file",
  "depends_on",
  "key",
  "never",
] as const;
export type CacheKey = (typeof CACHE_KEYS)[number];

export const SOURCE_KINDS = [
  "literal",
  "input",
  "env",
  "file",
  "shell",
  "template",
  "time",
  "state",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// [LAW:one-source-of-truth] The "which kinds have a cache field" predicate
// lives here once. The loader's cross-ref and cycle validators narrow via
// this guard instead of repeating the kind list at every site. A kind that
// takes a cache policy is listed in this union and this guard; a kind that
// takes none needs nothing here.
export type VariableDeclWithCache = FileVarDecl | ShellVarDecl;

export function hasCacheField(v: VariableDecl): v is VariableDeclWithCache {
  // [LAW:types-are-the-program] Named positively: a kind added to the union
  // (a tombstone's `dropped`) has no cache until it is listed here.
  return v.kind === "file" || v.kind === "shell";
}

// [LAW:one-source-of-truth] The templates a variable's declaration carries,
// by field: a template variable's body and a source's cache key — listed once,
// here, for the walk that reads them and the one that rewrites them.
export function mapVariableTemplates(
  v: VariableDecl,
  f: (template: string, field: "template" | "cache.key") => string,
): VariableDecl {
  const body: VariableDecl =
    v.kind === "template" ? { ...v, template: f(v.template, "template") } : v;
  return hasCacheField(body) && "key" in body.cache
    ? ({
        ...body,
        cache: { ...body.cache, key: f(body.cache.key, "cache.key") },
      } as VariableDecl)
    : body;
}

export function variableTemplates(
  v: VariableDecl,
): ReadonlyArray<readonly [field: "template" | "cache.key", template: string]> {
  const found: Array<readonly [field: "template" | "cache.key", string]> = [];
  mapVariableTemplates(v, (template, field) => {
    found.push([field, template]);
    return template;
  });
  return found;
}

export interface SegmentDecl {
  readonly template: string;
  // What this segment SHOWS, for an author choosing between them — authoring
  // metadata, never rendered. A segment owes none; the bundled standard library
  // carries one for every name it declares (pinned in
  // test/default-dsl-config.test.ts) because that config merges into every user
  // file, which makes it the catalogue `cc-candybar segments` and the published
  // schema answer out of.
  //
  // [LAW:one-source-of-truth] It lives ON the declaration it describes, so it
  // travels with the segment instead of sitting in a parallel inventory that
  // drifts from it silently. One consequence to know rather than discover: a
  // file's declaration under a bundled name is a per-FIELD delta, so overriding
  // a bundled `template` inherits the bundled description — which then
  // describes something that is no longer there. That is the uniform merge rule
  // doing exactly what it does for every other field, not a special case worth
  // one; a delta that changes what a segment MEANS should say so here too.
  readonly description?: string;
  // What this segment is ABOUT, for the add menu's library to group it by
  // (`SEGMENT_GROUPS`). Absent, the library files it under `other`. The
  // bundled standard library declares one for every name it carries (pinned in
  // test/default-dsl-config.test.ts); like `description`, a file's delta under a
  // bundled name sets it per field.
  readonly group?: SegmentGroup;
  // "auto" → content-sized; a positive integer → that many columns; "fill" →
  // whatever is left of the row once every other cell has taken its natural
  // width, split evenly when a row declares more than one
  // (brandon-layout-0c2). A fill segment can never widen a row past the width
  // it was given: when the other cells already fill it every share is zero and
  // the strip's own wrap owns the overflow exactly as before. A cell of any width
  // wider than a line wraps across lines, unless `autoWrap` is off.
  readonly width?: "auto" | number | "fill";
  readonly justify?: JustifyMode;
  readonly truncate?: TruncateMode;
  readonly bg?: string;
  readonly fg?: string;
  readonly when?: string;
  // The theme every placement of this segment wears unless the placement sets
  // its own (a NAME): the default of the `theme` setting `settingsOf` implies.
  // Absent, placements follow the bar's theme.
  readonly palette?: string;
  // Per-segment vars sub-block — lives in the same global MobX store at
  // runtime under the namespaced key `<segment>.<var>`. Templates reference a
  // segment local ONLY via that namespaced form (`.<segment>.local`), from any
  // segment including the owning one; the loader rejects bare refs at load
  // with a diagnostic naming the namespaced form. [LAW:one-source-of-truth]
  readonly vars?: Readonly<Record<string, VariableDecl>>;
  // The settings each PLACEMENT of this segment may set
  // (brandon-segment-settings-i4n): name → what the value may be and what it
  // is when a placement says nothing. The segment's templates read the
  // placement's resolved values as `.settings.<name>`.
  readonly settings?: Readonly<Record<string, SettingDecl>>;
  // Whether the doctor counts this segment's missing data as a failure
  // (brandon-doctor-v62x.onf): a forge CLI that is not installed or logged in,
  // a payload with no rate limits. Absent is "fail";
  // read only through `missingDataOf`.
  readonly missingData?: MissingData;
}

export const MISSING_DATA = ["fail", "ignore"] as const;
export type MissingData = (typeof MISSING_DATA)[number];

export function missingDataOf(seg: SegmentDecl): MissingData {
  return seg.missingData ?? "fail";
}

// [LAW:one-source-of-truth] Every `state` variable a config declares, by the
// name the store and the scope read it under: the config's own first, then
// each segment's locals as `<segment>.<var>`. The render's key → variable map
// and the daemon's seed of a stepped key (its `default` before any click) both
// walk this one set, so a segment-local state var is as real to a click as a
// global one.
export function* stateVarDecls(
  config: Pick<DslConfig, "variables" | "segments">,
): IterableIterator<readonly [name: string, decl: StateVarDecl]> {
  for (const [name, decl] of Object.entries(config.variables)) {
    if (decl.kind === "state") yield [name, decl];
  }
  for (const [segName, seg] of Object.entries(config.segments)) {
    if (!seg.vars) continue;
    for (const [varName, decl] of Object.entries(seg.vars)) {
      if (decl.kind === "state") yield [`${segName}.${varName}`, decl];
    }
  }
}

// The settings every placement has without its segment declaring them.
export const THEME_SETTING = "theme";
export const EFFECT_SETTING = "effect";
export const IMPLIED_SETTINGS = [THEME_SETTING, EFFECT_SETTING] as const;
export type ImpliedSetting = (typeof IMPLIED_SETTINGS)[number];

// [LAW:single-enforcer] THE settings a segment's placements have: what its
// definition declares, plus the IMPLIED_SETTINGS every placement has — `theme`
// (brandon-settings-menu-6c5) and `effect` (brandon-effects-2gka.bm1) — so the
// loader's placement check, configure mode's controls, the render's
// resolution, and save all read one set. The definition's `palette:` is the
// theme's default for every copy; every copy follows the bar's effect unless
// it sets its own. A placement's own value overrides either for that copy
// alone. A segment cannot declare an implied setting itself
// (loader/settings.ts), so nothing here shadows another.
export function settingsOf(
  seg: SegmentDecl,
): Readonly<Record<string, SettingDecl>> {
  return {
    ...seg.settings,
    [THEME_SETTING]: {
      label: THEME_SETTING,
      domain: "theme",
      default: seg.palette ?? FOLLOW_BAR,
    },
    // [LAW:one-type-per-behavior] A closed list of names, so the word-list arm
    // every authored setting uses: the loader's membership test, configure
    // mode's picker and save need nothing of their own for it.
    [EFFECT_SETTING]: {
      label: EFFECT_SETTING,
      domain: PLACEMENT_EFFECTS,
      default: FOLLOW_BAR,
    },
  };
}

// [LAW:types-are-the-program] What a setting may hold. A template reads it,
// so it is a template's own scalar vocabulary: a flag, a word, a number.
export type SettingValue = boolean | string | number;

// [LAW:types-are-the-program] One setting's declaration, discriminated by its
// DOMAIN — a flag, a closed list of words, or a bounded integer — and each arm
// carries a default of that arm's own type, so a default outside its kind is
// unrepresentable. The authored JSON is this shape verbatim: `domain` is
// `"bool"`, an array of words, or `{ min, max }`.
export type SettingDecl =
  | {
      readonly label: string;
      readonly domain: "bool";
      readonly default: boolean;
    }
  | {
      readonly label: string;
      readonly domain: readonly string[];
      readonly default: string;
    }
  | {
      readonly label: string;
      readonly domain: SettingRange;
      readonly default: number;
    }
  | {
      // The placement's theme (brandon-settings-menu-6c5): `bar` or an
      // installed theme name (`placementThemeNames`). Implied on every
      // segment by `settingsOf`, never authored.
      readonly label: string;
      readonly domain: "theme";
      readonly default: string;
    };

export interface SettingRange {
  readonly min: number;
  readonly max: number;
  // How far one click of configure mode's stepper moves the value (authored
  // optionally; 1 when absent). A value between steps is still a member —
  // the step is the control's stride, not the domain.
  readonly step: number;
  // Another range setting of the same segment this one may never fall below
  // (brandon-settings-coverage-g4p.lx2): the ordering a `ramp`'s ascending
  // stops need, declared where the stops are, so it is refused where it is
  // written (`settingOrderProblems`) instead of discovered by the render.
  readonly atLeast?: string;
}

// [LAW:single-enforcer] THE check of a placement's settings against each
// other — the loader asks it of a declaration's defaults and of every
// placement's values, and the set-state verbs of every unsaved pick before it
// lands, so "these settings may stand together" has one answer. `values`
// holds every declared setting's resolved value; each problem names the
// setting that fell below its floor.
export interface SettingOrderProblem {
  readonly setting: string;
  readonly message: string;
}

// A setting's range domain, or undefined for every other arm — the one
// spelling of "is this setting a number between bounds".
export function rangeOf(
  decl: SettingDecl | undefined,
): SettingRange | undefined {
  const domain = decl?.domain;
  return typeof domain === "object" && "min" in domain ? domain : undefined;
}

// `decls` is a LOADED declaration: every `atLeast` names another range
// setting of it and none closes a cycle (the loader refuses both), so each
// floor's value is a number in `values`.
export function settingOrderProblems(
  decls: Readonly<Record<string, SettingDecl>>,
  values: Readonly<Record<string, SettingValue>>,
): readonly SettingOrderProblem[] {
  return Object.entries(decls).flatMap(([name, decl]) => {
    const floor = rangeOf(decl)?.atLeast;
    if (floor === undefined) return [];
    const value = values[name] as number;
    const least = values[floor] as number;
    return value >= least
      ? []
      : [
          {
            setting: name,
            message: `"${name}" (${value}) is below "${floor}" (${least}) — ${decl.label} must be at least ${decls[floor]!.label}`,
          },
        ];
  });
}

// [LAW:single-enforcer] THE membership test of a setting's domain — the
// loader asks it of every default and every placement's value, so "a value
// this setting may hold" has one answer.
export function inSettingDomain(
  decl: SettingDecl,
  value: SettingValue,
): boolean {
  const { domain } = decl;
  if (domain === "bool") return typeof value === "boolean";
  if (domain === "theme") {
    return typeof value === "string" && isPlacementThemeName(value);
  }
  if ("min" in domain) {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= domain.min &&
      value <= domain.max
    );
  }
  return typeof value === "string" && domain.includes(value);
}

// [LAW:one-source-of-truth] A setting value as a SessionState string, and
// back. A session holds strings, so a pick crosses the click wire in this
// spelling and the render parses it against the declaration — `undefined` for
// a string the domain does not hold (a pick made before the declaration
// changed), which the caller reads as "no pick", as a stale theme name is.
export function settingSpelling(value: SettingValue): string {
  return String(value);
}

export function parseSettingSpelling(
  decl: SettingDecl,
  raw: string,
): SettingValue | undefined {
  const { domain } = decl;
  if (typeof domain === "object" && "min" in domain) {
    return parseSessionInt(raw, domain) ?? undefined;
  }
  const value: SettingValue =
    domain === "bool"
      ? raw === "true"
        ? true
        : raw === "false"
          ? false
          : raw
      : raw;
  return inSettingDomain(decl, value) ? value : undefined;
}

// [LAW:single-enforcer] What one setting of a placement holds: the session's
// pick through the setting's draft slot (SegmentNode.drafts) when the
// declaration admits it, else the placement's own value, else the
// declaration's default. `pick` reads a slot — the render through its draft
// variable, the doctor through the session's state — so the bar and the
// doctor cannot disagree about what a placement wears.
export function placementSetting(
  node: SegmentNode,
  name: string,
  decl: SettingDecl,
  pick: (draft: DraftSlot) => string | null,
): SettingValue {
  const saved = node.settings?.[name] ?? decl.default;
  const draft = node.drafts?.[name];
  const raw = draft === undefined ? null : pick(draft);
  return (raw === null ? undefined : parseSettingSpelling(decl, raw)) ?? saved;
}

// How a domain reads in a message: `true or false`, `one of "a", "b"`, or
// `an integer from 0 to 9`.
export function describeSettingDomain(decl: SettingDecl): string {
  const { domain } = decl;
  if (domain === "bool") return "true or false";
  if (domain === "theme") {
    return `"${FOLLOW_BAR}" (the bar's own theme) or an installed theme name`;
  }
  if ("min" in domain) return `an integer from ${domain.min} to ${domain.max}`;
  return `one of ${domain.map((m) => JSON.stringify(m)).join(", ")}`;
}

// [LAW:types-are-the-program] What a FILE may say about a segment: a complete
// declaration, or a DELTA over the bundled declaration of the same name —
// `template` is the one field a delta may omit (every other SegmentDecl field
// is optional already). Which of the two a file authored is decided where the
// base is known: the loader accepts an absent template exactly for a name in
// its `inheritedSegments` set (loader/segments.ts), and mergeWithDefault lays
// the delta over that base field by field (loader/merge.ts), so a file that
// pins one `palette` never restates — or shadows — the bundled template.
export type RawSegmentDecl = Omit<SegmentDecl, "template"> & {
  readonly template?: string;
};

export type JustifyMode = "left" | "center" | "right";
export type TruncateMode = "right" | "left" | "middle";

export const JUSTIFY_MODES: readonly JustifyMode[] = [
  "left",
  "center",
  "right",
];
export const TRUNCATE_MODES: readonly TruncateMode[] = [
  "right",
  "left",
  "middle",
];
