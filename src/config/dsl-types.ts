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
// about row/segment structure: an ordered list of rows, each row an ordered
// list of segment names. Single-line config is the degenerate `N=1` case
// (`[[a, b, c]]`); no separate "single-line" arm, no `null|undefined` flag.
// A separator-sentinel form (e.g. `["a", "\n", "b"]`) would permit illegal
// interleavings (`["\n", "\n"]`) at the type level; the 2D array makes those
// unrepresentable. *Single-line is multi-line with size 1.*
export interface RawDslConfig {
  readonly globals?: Partial<Globals>;
  readonly variables?: Readonly<Record<string, VariableDecl>>;
  readonly segments?: Readonly<Record<string, SegmentDecl>>;
  readonly layout?: ReadonlyArray<readonly string[]>;
  readonly widgets?: Readonly<Record<string, WidgetDecl>>;
}

export interface DslConfig {
  readonly globals: Globals;
  readonly variables: Readonly<Record<string, VariableDecl>>;
  readonly segments: Readonly<Record<string, SegmentDecl>>;
  readonly layout: ReadonlyArray<readonly string[]>;
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
  readonly hueStep?: number;
  // [LAW:one-source-of-truth] A palette NAME, not a resolved Palette: DslConfig
  // is the JSON-shape mirror, so the name is the authoritative datum and the
  // renderer owns name→Palette resolution. Base of the cascade; a per-segment
  // `palette` overrides it (see effectiveSegmentPalette in the loader).
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

// ─── Interactive widgets ───────────────────────────────────────────────────────
//
// [LAW:locality-or-seam] A widget is a reusable interactive component declared
// in `DslConfig.widgets` and referenced from a segment template via
// `{{ widget "name" }}`. It is NOT a kind of segment — there is one Segment
// type; a widget reference is content a template uses, exactly like `link` or a
// variable. Whether a segment shows text, a button, both, or neither falls out
// of what its template contains, never a segment-type distinction.

// [LAW:types-are-the-program] An Action is the click effect a button binds to.
// Discriminated by which key is present (the CacheDecl pattern): exactly one of
// `set` / `copy` / `open`. The loader proves the one-of invariant; the renderer
// and the validator-derivation walk match on the present key with no fallthrough.
//
//   set  — write a SessionState key. `to` is the literal value for a fixed
//          button; OMITTED when the value is supplied by the option (an
//          `optionsFrom` button binds each option's value into its own click).
//          The loader enforces this pairing (literal ⇒ `to` required;
//          option-bound ⇒ `to` forbidden) — the type carries `to?` because the
//          legality depends on the enclosing item's context.
//   copy — copy templated text to the clipboard (the `copy` verb).
//   open — open a templated path/target in the editor (the `open-vscode` verb).
//
// [LAW:one-source-of-truth] Only `set` actions write SessionState, so only
// `set` actions derive a validator (from their target key + value(s)).
// `copy`/`open` write nothing — they derive nothing. The vocabulary grows by
// arms (a future `run`/`open-url`), not by validator plumbing.
export type Action =
  | { readonly set: string; readonly to?: string }
  | { readonly copy: string }
  | { readonly open: string };

export const ACTION_KEYS = ["set", "copy", "open"] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

// [LAW:one-source-of-truth] The domain lists a picker draws options from. Same
// canonical sources the `themes()`/`styles()` bindings and the set-state
// validators consult — the rendered options and the derived gate cannot diverge
// because there is no second enumeration.
export type OptionSource = "themes" | "styles";
export const OPTION_SOURCES: readonly OptionSource[] = ["themes", "styles"];

// [LAW:types-are-the-program] A button item is discriminated by presence of
// `optionsFrom`. A literal item carries its own glyph/label; an option-bound
// item expands to one button per option, binding each option's value into its
// `set` action. `onClick` is always a list — single is the N=1 case, no
// `Action | Action[]` union for consumers to normalize. Multiple `set` actions
// in one list batch into a single set-state click (the .2 batched wire).
export interface LiteralButtonItem {
  readonly glyph?: string;
  readonly label?: string;
  readonly onClick: readonly Action[];
}
export interface OptionsButtonItem {
  readonly optionsFrom: OptionSource;
  readonly glyph?: string;
  readonly onClick: readonly Action[];
}
export type ButtonItem = LiteralButtonItem | OptionsButtonItem;

export function isOptionsButtonItem(
  item: ButtonItem,
): item is OptionsButtonItem {
  return "optionsFrom" in item;
}

// [LAW:one-type-per-behavior] Widgets are discriminated by `kind` (the
// VariableDecl pattern). The foundation ships `buttons`; `menu` (nested,
// open-path state) and `stepper` (numeric dec/cur/inc) join as new arms — one
// arm each, the segment surface untouched.
export interface ButtonsWidget {
  readonly kind: "buttons";
  readonly items: readonly ButtonItem[];
}
export type WidgetDecl = ButtonsWidget;

export const WIDGET_KINDS = ["buttons"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];
