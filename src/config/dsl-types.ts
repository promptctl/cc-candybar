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
// [LAW:one-source-of-truth] A look IS a rich-js ThemeKey (four numeric axes:
// hueShift / chromaScale / lightnessScale / lightnessShift) — the config type
// references the vocabulary owner's type verbatim, so a rich-js axis rename is
// a compile error here, never silent drift. Type-only: no runtime rich-js
// dependency enters the config layer.
import type { ThemeKey } from "@promptctl/rich-js";
import type {
  Charset,
  ColorCompatibility,
  StripStyle,
} from "../themes/policy.js";
import type { DistributionName } from "../themes/decor.js";
import type { JsonValue } from "../var-system/types.js";

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
// and renderDsl's projection switch is exhaustive over it (adding an arm here
// forces a matching render arm).
export const DIRECTIONS = ["vertical", "horizontal"] as const;
export type Direction = (typeof DIRECTIONS)[number];

// [LAW:one-type-per-behavior] THE unit of rendering: a ref into the named
// `segments` block. A segment IS a single template (text, state-driven display,
// clickable regions — whatever the template produces); there is no `inline` /
// `stepper` / `picker` node kind, because "make a node flexible enough for
// whatever" = one template expresses anything. A segment renders to ONE strip
// item; the powerline joiner joins items, never inside one. A horizontal run of
// segments is spelled `{ h: ["seg1", "seg2"] }` in the A-grammar.
export interface SegmentNode {
  readonly kind: "segment";
  // A name into the `segments` block. The segment's own template/palette/`when`
  // live on its SegmentDecl, not here; this node is purely the tree position.
  readonly name: string;
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
}

export interface Opens {
  readonly ref: DisclosureRef;
  readonly body: ContainerNode;
}

// [LAW:types-are-the-program] One open disclosure, named by the two strings that
// decide it: the VARIABLE a body reads and the MEMBER value that means "this one
// is open". They are distinct because a group's variable is per-group
// (`groups.<name>`) while its state KEY may be shared with accordion siblings —
// so the pair, never a lone key, is what identifies an open state. It lives
// here, beside the node that carries it, so the tree type and the disclosure
// primitive (src/config/disclosure.ts) read one definition.
export interface DisclosureRef {
  readonly variable: string;
  readonly member: string;
}

// [LAW:dataflow-not-control-flow] A segment with the body it opens rewritten by
// `f` — total: a segment that opens nothing is returned as it is. Every tree
// rewrite that recurses into containers (edit chrome's splice, the settings
// anchor's expansion) recurses into bodies through this one function, so a
// body can never be the subtree a rewrite forgot.
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
  // Choosing `monotonic` / `ends-interleaved` reads the sibling count, so adding
  // a child re-spaces its siblings — a trade the author spends knowingly.
  readonly distribution?: DistributionName;
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
// fails to typecheck until it lists the field) without a second edit.
export type ContainerOwn = Omit<
  ContainerNode,
  "kind" | "direction" | "children"
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
// Its SourceRegistry (timers, fs watchers, git subscriptions) and its derived
// click gate (registerStateValidator over deriveActionValidators) are built
// ONCE, in buildState. A preset, by contrast, is a per-SESSION pick. So a
// preset carrying `variables` would need a per-session registry, and one
// carrying `actions` would need a per-session wire gate — or a gate that is the
// union of every preset's actions anyway, at which point the preset scoped
// nothing and only the merge got harder [LAW:no-ambient-temporal-coupling].
// `root` and `globals` have no such problem: the root is WALKED per render (so
// every preset's tree is compiled up front and one is selected by name, exactly
// how every look's ThemeKey is resolved up front and one is selected by name),
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
  // nothing about `charset`.
  readonly globals?: Globals;
}

export interface RawDslConfig {
  readonly globals?: Partial<Globals>;
  readonly variables?: Readonly<Record<string, VariableDecl>>;
  readonly segments?: Readonly<Record<string, SegmentDecl>>;
  // A fragment over the bundled default's root — see RootFragment: a tree
  // replaces the default's rows, a rows map merges over them by name.
  readonly root?: RootFragment;
  readonly actions?: Readonly<Record<string, ActionDecl>>;
  // Named config fragments ("presets"): each an alternative `root`/`globals`
  // arrangement selected per session, the exact twin of `looks` one level up
  // (a look adapts the THEME; a preset adapts the LAYOUT + display globals).
  readonly presets?: Readonly<Record<string, PresetDecl>>;
  // The display globals edit mode stages while it is on — see DslConfig's own
  // `editGlobals` for the shape, the merge, and where it sits in the chain.
  readonly editGlobals?: Partial<Globals>;
  // Named theme-adaptation bundles ("looks"): each is a full ThemeKey (the
  // loader normalizes absent axes to identity at parse). Applied ON TOP of the
  // active theme at render — a transform composing with every theme, selected
  // per session exactly like theme/style (session key `look`).
  readonly looks?: Readonly<Record<string, ThemeKey>>;
  // [LAW:single-enforcer] Config-level shared helper templates: name → Go-template
  // body. Each compiles to one `{{ define "name" }}body{{ end }}` unit, and the
  // whole set into one shared define set every template this config parses
  // inherits — so a formatter (`{{ template "formatCost" .x }}`) is
  // defined ONCE and callable from any segment/predicate, never re-inlined per
  // segment. Absent ≡ no helpers; merges by-name (user overrides a helper).
  readonly helpers?: Readonly<Record<string, string>>;
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
  // [LAW:one-source-of-truth] The effective look set: name → full ThemeKey.
  // Merges by name with the bundled default (user wins per name), like
  // segments/actions/variables — so the default's `none` (the identity look and
  // the resolution floor of effectiveLookName) is present in EVERY merged
  // config by construction. An action `{ set: …, from: "looks" }` ranges these
  // names; the derived click gate and the rendered options read this one map.
  readonly looks: Readonly<Record<string, ThemeKey>>;
  // [LAW:one-source-of-truth] The effective preset set: name → config fragment.
  // Merges by name with the bundled default (user wins per name) like every
  // other section — so the default's `default` preset (the empty fragment, and
  // the resolution floor of effectivePresetName) is present in EVERY merged
  // config by construction, exactly as `looks` guarantees `none`. An action
  // `{ set: …, from: "presets" }` ranges these names; the derived click gate and
  // the rendered options read this one map.
  readonly presets: Readonly<Record<string, PresetDecl>>;
  // [LAW:one-source-of-truth] The display globals edit mode stages while it is
  // on — the `globals` half of the fragment whose `root` half edit chrome
  // already stages (src/config/edit-chrome.ts). Merges FIELD BY FIELD with the
  // bundled default's (like `globals` itself and `root`'s rows), so a
  // user retuning the separator keeps the bundled `style: "plain"`.
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
  // edit mode is decided later than picking a style. Nothing writes it back to
  // SessionState or the config file, which is why leaving edit mode
  // restores the previous look with no save/restore path
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

  // [LAW:one-type-per-behavior] The config default for the LOOK (a named
  // theme-adaptation from the `looks` block) — the exact twin of `palette` one
  // dimension over: the daemon resolves the live look per render as
  // `sessionState.look ?? globals.look ?? "none"` (effectiveLookName), so a
  // look click recolors the bar live and a config can set a default adaptation
  // without an edit-per-session. Membership in the merged `looks` map is
  // validated post-merge (cross-ref) — a user's globals.look may name a
  // default-provided look.
  readonly look?: string;

  // [LAW:one-type-per-behavior] The config default for the PRESET (a named
  // config fragment from the `presets` block) — the same twin-of-`palette`
  // shape as `look` one dimension over: the daemon resolves the live preset per
  // render as `sessionState.preset ?? globals.preset ?? "default"`
  // (effectivePresetName), so a preset click restages the bar live and a config
  // can pick a default arrangement without an edit-per-session. Membership in
  // the merged `presets` map is validated post-merge (cross-ref) — a user's
  // globals.preset may name a default-provided preset.
  //
  // [LAW:one-source-of-truth] A preset's own `globals` may NOT carry this field
  // (the loader rejects it): a preset selecting a preset is a second authority
  // over which preset is active, and a cyclic one.
  readonly preset?: string;

  // [LAW:one-type-per-behavior] The config default for the powerline cap/
  // separator SHAPE — the exact twin of `palette` one dimension over: the
  // daemon resolves the live strip style per render as
  // `sessionState.style ?? globals.style ?? "powerline"` (effectiveStripStyle),
  // so a style click reshapes the bar live and a config can set the default
  // shape without an edit-per-session.
  readonly style?: StripStyle;

  // The legacy display.autoWrap knob: whether FlexStrip soft-wraps a root
  // row that exceeds the usable width. Default true (current behavior);
  // false renders each row as one unbounded line, overflow off-screen.
  // [config-only] Unlike palette/style there is no SessionState/click half —
  // the daemon resolves `globals.autoWrap ?? true` into renderOpts.wrap.
  readonly autoWrap?: boolean;

  // The legacy display.padding knob: spaces synthesized INSIDE each segment
  // cell per side (intra-cell, within the bg fill — not rich-js FlexStrip's
  // inter-item gap). Default 1 (current behavior). Templates author content;
  // this chrome is applied structurally at the cell-formation seam.
  // [config-only] The daemon resolves `globals.padding ?? 1` into
  // renderOpts.padding; no SessionState/click half.
  readonly padding?: number;

  // The legacy display.charset knob: which glyph vocabulary the strip joiners
  // render with. Default "unicode" (current behavior — rich-js's powerline
  // caps, U+E0Bx). "ascii" swaps the caps for single-column ASCII glyphs so
  // terminals/fonts without powerline glyphs render cleanly instead of tofu.
  // Orthogonal to `style`: style picks the joiner shape, charset the glyphs.
  // [config-only] The daemon resolves `globals.charset ?? "unicode"` into
  // renderOpts.charset; no SessionState/click half.
  readonly charset?: Charset;

  // Whether the daemon renders its update notice — the row saying a newer
  // source tree (a checkout) or a newer published release (an install) exists
  // than the code rendering the bar (src/daemon/update-notice.ts). Default
  // true. The notice's own `[disable]` click writes `false` here, so this is
  // the one durable "never show it" switch; a per-session, per-version
  // dismissal lives in SessionState instead.
  // [config-only] `globals.updateNotice ?? true`; no SessionState half.
  readonly updateNotice?: boolean;

  // The legacy display.colorCompatibility knob: the color depth rich-js
  // downsamples output to. Default "truecolor" (current behavior — NOT the
  // legacy "auto" default, which would change rendering for existing users).
  // The type excludes "auto" entirely: the daemon is detached, so env
  // detection would read the wrong terminal — see COLOR_COMPATIBILITIES.
  // [config-only] The daemon resolves `globals.colorCompatibility ??
  // "truecolor"` into renderOpts.colorCompatibility; no SessionState/click half.
  readonly colorCompatibility?: ColorCompatibility;
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
// which arm publishes a document is spelled once.
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

export interface TemplateVarDecl {
  readonly kind: "template";
  readonly template: string;
  readonly cache?: CacheDecl;
  readonly default?: string;
}

// [LAW:types-are-the-program] Time vars refresh on a clock — ttl is the only
// cache form the runtime honors (declareTime always registers a TTL timer).
// The loader rejects the other CacheDecl arms at load, so past that boundary
// a non-ttl cache on a time var is unrepresentable, not silently coerced.
export interface TimeVarDecl {
  readonly kind: "time";
  readonly layout: string;
  readonly cache?: TtlCacheDecl;
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
  // Per-segment vars sub-block — lives in the same global MobX store at
  // runtime under the namespaced key `<segment>.<var>`. Templates reference a
  // segment local ONLY via that namespaced form (`.<segment>.local`), from any
  // segment including the owning one; the loader rejects bare refs at load
  // with a diagnostic naming the namespaced form. [LAW:one-source-of-truth]
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
// `./action.ts`); they are the conventional variable NAMES the renderer and the
// picker agree on. Kept here, with the other render/config conventions.

// [LAW:one-source-of-truth] The conventional variable a picker paginates against
// — the usable terminal width renderDsl injects each render. One name shared by
// the declaration (default config) and the picker's read, so they cannot drift.
export const TERM_COLS_VAR = "term.cols";
