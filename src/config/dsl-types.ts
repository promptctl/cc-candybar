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

// [LAW:one-way-deps] The widget schema lives in its own leaf module; DslConfig
// references it here. The dependency is one-way (this file → widget.ts), never
// the reverse, so the widget shapes can be lifted out without a cycle.
import type { WidgetDecl } from "./widget.js";

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
//   ValidatedConfig — DslConfig + a phantom brand proving validateConfig()
//                     has run. The renderer accepts only this type, so the
//                     compiler structurally enforces "no unvalidated config
//                     can reach rendering." The brand is module-scoped via
//                     `unique symbol`, so the only construction site is
//                     `validateConfig` itself.
// [LAW:types-are-the-program] `layout` is the strongest theorem we can write
// about row/segment structure: an ordered list of rows, each row a predicate
// (optional) plus an ordered list of segment names. Single-line config is the
// degenerate `N=1` case; no separate "single-line" arm, no `null|undefined`
// flag. A separator-sentinel form (e.g. `["a", "\n", "b"]`) would permit
// illegal interleavings at the type level; the row objects make those
// unrepresentable. *Single-line is multi-line with size 1.*
//
// [LAW:dataflow-not-control-flow] A row's `when` lifts the segment-level
// visibility predicate to the row: the rendered ROW SET is a pure function of
// state. A closed/absent row does not exist (no blank line) — the renderer
// skips it exactly as it skips a hidden segment. The user-file sugar for a
// predicate-less row is a bare `string[]`, normalized to `{ segments }` at the
// loader boundary so this is the only row shape downstream.
export interface LayoutRow {
  // [LAW:dataflow-not-control-flow] Absent `when` ≡ always-rendered. A Go-
  // template predicate string evaluated per render; false hides the whole row.
  readonly when?: string;
  readonly segments: readonly string[];
}

// [LAW:types-are-the-program] The recursive layout substrate: a `Node` is
// either a `cells` leaf (a horizontal run of segments rendered to one-or-more
// strips — an authored "\n" or width-overflow wrapping splits it into multiple
// visual lines) or a `container` whose `direction` is DATA that decides how its
// children map
// onto the 2D plane. Both the bar and (a later child's) menu are projections of
// this one tree — they differ only in `direction`, not in code path
// [LAW:dataflow-not-control-flow]. `LayoutRow[]` is the flat-vertical SUGAR for
// this tree (one container of cells leaves), compiled to a `LayoutNode` at the
// loader boundary so no downstream consumer sees two layout representations
// [LAW:one-source-of-truth].
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
// and renderDsl's projection switch is exhaustive over it (adding an arm here
// forces a matching render arm).
export const DIRECTIONS = ["vertical", "horizontal"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface CellsNode {
  readonly kind: "cells";
  // Names into the `segments` block — the same reference-by-name a LayoutRow
  // uses. A leaf packs its segments into a horizontal strip and renders to
  // ONE OR MORE visual lines: an authored "\n" in a segment's output partitions
  // it into independently-laid-out lines, and FlexStrip width-overflow wrapping
  // may split further. A newline-free, non-overflowing leaf is the degenerate
  // single-line case.
  readonly segments: readonly string[];
  // [LAW:dataflow-not-control-flow] Absent `when` ≡ always-rendered.
  readonly when?: string;
}

// [LAW:types-are-the-program] An `onClick` is the MIRROR of `when`: where `when`
// is a predicate that READS SessionState to gate visibility, `onClick` is a
// structured (key, value) WRITE — the click effect bound to a clickable leaf
// cell. STRUCTURED (a literal key + literal value) rather than a pre-built URL
// precisely so the validator that gates the write is DERIVABLE from the layout
// itself [LAW:one-source-of-truth: the rendered click IS the gate]. The renderer
// turns it into a `set-state` OSC-8 URL via the one click wire; the daemon's
// gate is derived from the same (key, value) pairs (deriveNodeValidators).
//
// One arm today (the state write — the substrate primitive this slice pins).
// `copy`/`open` side-effects (which write NO SessionState and need NO validator)
// join as additive arms when the buttons widget dissolves; the vocabulary grows
// by arms, never by URL plumbing at the callsite.
export interface ClickWrite {
  readonly set: string;
  readonly to: string;
}

// [LAW:types-are-the-program] One generated cell of an inline leaf: display text
// plus an OPTIONAL click. Absent `onClick` ≡ a plain (non-clickable) cell — a
// stepper's current-value display, a separator glyph — so "clickable" is data on
// the cell, not a second cell type. Composites (later slices) build these cells
// from their live state; an author writes them directly for a fixed trigger.
export interface InlineCell {
  readonly text: string;
  readonly onClick?: ClickWrite;
}

// [LAW:types-are-the-program] The other base-case leaf alongside CellsNode: a
// leaf whose content is GENERATED cells (text + optional click), not segment-
// name refs. [LAW:one-type-per-behavior] a segment-ref leaf and an inline leaf
// are distinct because their RENDER behavior differs — a ref leaf looks up each
// segment and evaluates its template/palette/layout; an inline leaf carries the
// cells already, evaluating only its own click URLs and color. This is the
// substrate hook composite node types (stepper/picker/disclosure) land their
// rendered cells on. Like a segment it owns its color (`bg`/`fg`/`palette` are
// palette-spec NAMES, resolved against the live base theme and transposed by the
// leaf's hue position) — there is no backing segment to carry it.
export interface InlineNode {
  readonly kind: "inline";
  readonly cells: readonly InlineCell[];
  // [LAW:single-enforcer] Color-spec template strings, the SAME surface a
  // segment's bg/fg are — resolved by the one resolveSegmentColors path, so an
  // inline leaf's color cannot drift from a segment's. As template surfaces they
  // are ref-checked and frontier-seeded identically (loader + render-payload).
  // Absent ≡ inherit the cascade base (no color of the leaf's own).
  readonly bg?: string;
  readonly fg?: string;
  // [LAW:one-source-of-truth] Per-leaf palette override (a NAME); undefined =
  // inherit the per-render base theme, the same contract a segment's `palette`.
  readonly palette?: string;
  // [LAW:dataflow-not-control-flow] Absent `when` ≡ always-rendered — the same
  // subtree-gating contract every node shares.
  readonly when?: string;
}

export interface ContainerNode {
  readonly kind: "container";
  readonly direction: Direction;
  readonly children: readonly LayoutNode[];
  // A container's `when` gates the whole subtree: a hidden container emits no
  // lines, but its descendants are still walked so per-segment hue indices stay
  // positionally stable (the same contract a hidden LayoutRow had).
  readonly when?: string;
}

export type LayoutNode = CellsNode | InlineNode | ContainerNode;

// [LAW:single-enforcer] THE one pre-order walk over a node tree. Every consumer
// that needs "which segments / which `when` predicates does this layout name"
// (the reachability closure, the debug dump, the cross-ref validator) iterates
// this — none re-recurses the tree itself.
export function* walkNodes(node: LayoutNode): IterableIterator<LayoutNode> {
  yield node;
  if (node.kind === "container") {
    for (const child of node.children) yield* walkNodes(child);
  }
}

export interface RawDslConfig {
  readonly globals?: Partial<Globals>;
  readonly variables?: Readonly<Record<string, VariableDecl>>;
  readonly segments?: Readonly<Record<string, SegmentDecl>>;
  // [LAW:types-are-the-program] Two authoring surfaces for the same canonical
  // `root` tree, never both at once (the loader rejects a config that writes
  // both): `layout` is the flat-vertical SUGAR (a list of rows, each a bare
  // `string[]` or `{ when?, segments }`), `root` is the raw recursive grammar.
  // Both collapse to one `LayoutNode` at the loader so downstream sees one shape.
  readonly layout?: readonly LayoutRow[];
  readonly root?: LayoutNode;
  readonly widgets?: Readonly<Record<string, WidgetDecl>>;
}

export interface DslConfig {
  readonly globals: Globals;
  readonly variables: Readonly<Record<string, VariableDecl>>;
  readonly segments: Readonly<Record<string, SegmentDecl>>;
  // [LAW:one-source-of-truth] The SINGLE canonical layout representation. The
  // user-file `layout` sugar is compiled into this `root` tree at load time;
  // nothing downstream re-derives or carries the flat row form.
  readonly root: LayoutNode;
  // [LAW:locality-or-seam] The named seam between interaction behavior (what a
  // click does) and presentation (segments/layout). Declared once, referenced
  // from segment templates via `{{ widget "name" }}`. Empty when no config
  // declares interactive components — an absent `widgets` key merges to `{}`.
  readonly widgets: Readonly<Record<string, WidgetDecl>>;
}

// [LAW:single-enforcer] The brand symbol is `unique` and module-private —
// nothing outside this file can construct a value carrying it. The only
// production-path producer is validateConfig() in dsl-loader.ts (one
// callsite of `config as ValidatedConfig`). Renderer signatures require
// ValidatedConfig; the type system therefore proves the validation step
// ran before any render path consumed the config.
declare const __validated: unique symbol;
export type ValidatedConfig = DslConfig & {
  readonly [__validated]: true;
};

export interface Globals {
  readonly default_bg?: string;
  readonly default_fg?: string;
  readonly default_empty_value?: string;
  readonly default_separator?: string;
  readonly default_truncate_marker?: string;
  // [LAW:one-source-of-truth] A palette NAME, not a resolved Palette: DslConfig
  // is the JSON-shape mirror, so the name is the authoritative datum and the
  // renderer owns name→Palette resolution. The config default for the base
  // theme; the daemon resolves the live base per render as
  // `sessionState.theme ?? globals.palette ?? default`, and a per-segment
  // `palette` is an explicit override that ignores the session theme.
  readonly palette?: string;
}

// [LAW:one-type-per-behavior] One discriminated union covers every source
// kind. Adding a new kind = code change here + matching runtime support in
// var-system. There is no "extension" path that bypasses this list.
export type VariableDecl =
  | LiteralVarDecl
  | InputVarDecl
  | EnvVarDecl
  | FileVarDecl
  | ShellVarDecl
  | TemplateVarDecl
  | TimeVarDecl
  | GitVarDecl
  | StateVarDecl;

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
  readonly readMode?: "whole" | "first-line";
  readonly regex?: string;
  readonly cache: CacheDecl;
  readonly default?: string;
}

export interface ShellVarDecl {
  readonly kind: "shell";
  readonly command: string;
  readonly regex?: string;
  readonly cache: CacheDecl;
  readonly default?: string;
}

export interface TemplateVarDecl {
  readonly kind: "template";
  readonly template: string;
  readonly cache?: CacheDecl;
  readonly default?: string;
}

export interface TimeVarDecl {
  readonly kind: "time";
  readonly layout: string;
  readonly cache?: CacheDecl;
  readonly default?: string;
}

export interface GitVarDecl {
  readonly kind: "git";
  readonly field: GitField;
  readonly cache: CacheDecl;
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
}

export type GitField =
  | "branch"
  | "sha"
  | "dirty"
  | "ahead"
  | "behind"
  | "stash";

// [LAW:dataflow-not-control-flow] The discriminator is "which key is present"
// in the user's JSON — not a `kind` field. Encoded as a 5-arm union so the
// type system enforces "exactly one of these." The loader validates the
// runtime invariant (one and only one); the type then carries it forward.
export type CacheDecl =
  | { readonly ttl: string }
  | { readonly watch_file: string }
  | { readonly depends_on: readonly string[] }
  | { readonly key: string }
  | { readonly never: true };

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
  "git",
  "state",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// [LAW:one-source-of-truth] The "which kinds have a cache field" predicate
// lives here once. The loader's cross-ref and cycle validators narrow via
// this guard instead of repeating the kind list (`!== "literal" && !==
// "input" && ...`) at every site — adding a new no-cache kind only requires
// updating the union and this guard.
export type VariableDeclWithCache =
  | FileVarDecl
  | ShellVarDecl
  | TemplateVarDecl
  | TimeVarDecl
  | GitVarDecl;

export function hasCacheField(v: VariableDecl): v is VariableDeclWithCache {
  return (
    v.kind !== "literal" &&
    v.kind !== "input" &&
    v.kind !== "env" &&
    v.kind !== "state"
  );
}

export const GIT_FIELDS: readonly GitField[] = [
  "branch",
  "sha",
  "dirty",
  "ahead",
  "behind",
  "stash",
];

// Source kinds where the user MUST declare a cache policy (no sensible default).
// Aligns with the proposal's cache-invalidation table.
export const SOURCES_REQUIRING_CACHE: readonly SourceKind[] = [
  "file",
  "shell",
  "git",
];

export interface SegmentDecl {
  readonly template: string;
  readonly width?: "auto" | number;
  readonly justify?: JustifyMode;
  readonly truncate?: TruncateMode;
  readonly bg?: string;
  readonly fg?: string;
  readonly when?: string;
  // [LAW:one-source-of-truth] Per-segment palette override (a NAME). Overrides
  // globals.palette for this segment only; undefined = inherit the cascade base.
  readonly palette?: string;
  // Per-segment vars sub-block — lives in the same global MobX store at runtime
  // but scoped to the owning segment's template context. Own-segment locals are
  // reachable by bare name (`.local`) or namespaced form (`.<segment>.local`);
  // from another segment's template, only the namespaced form is valid.
  readonly vars?: Readonly<Record<string, VariableDecl>>;
}

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

// ─── Conventional render-time variable names ─────────────────────────────────
//
// [LAW:one-source-of-truth] These are not widget types (those live in
// `./widget.ts`); they are the conventional variable NAMES the renderer and the
// widget runtime agree on. Kept here, with the other render/config conventions.

// [LAW:one-source-of-truth] The conventional variable a menu paginates against —
// the usable terminal width renderDsl injects each render. One name shared by
// the declaration (default config), the renderer's read (widgets), and the
// loader's "a menu requires this variable" check, so they cannot drift.
export const TERM_COLS_VAR = "term.cols";

// [LAW:one-source-of-truth] The conventional variable per-segment hue rotation
// reads. hueStep is NOT a globals field (that would be a second source for a
// render-time value); it is a value in the store like every other render input.
// A config declares this variable — as a `state` var so a stepper can drive it
// live (session value over the declared default, the same session-over-default
// the theme uses), or as any kind for a fixed value. renderDsl reads it through
// this one name; the stepper widget writes the SessionState key it reads. Absent
// ≡ no rotation (step 0) — the degenerate case, not a special branch.
export const HUE_STEP_VAR = "hue.step";
