// [LAW:types-are-the-program] Every legal config is representable, every illegal
// one is not; the loader is the proof. [LAW:one-source-of-truth] These shapes
// mirror the var-system runtime types; the loader is the only translator.

// [LAW:one-way-deps] this file → action.ts, never the reverse.
import type { ActionDecl } from "./action.js";
import type { ThemeKey } from "@promptctl/rich-js";
import type {
  Charset,
  ColorCompatibility,
  StripStyle,
} from "../themes/policy.js";
import type { DistributionName } from "../themes/decor.js";
import type { JsonValue } from "../var-system/types.js";

// [LAW:types-are-the-program] Exactly two node kinds: a `segment` leaf and a
// `container` whose `direction` is DATA — vertical STACKS line-lists, horizontal
// ZIPS cells into one strip. renderDsl's projection is exhaustive over this list.
export const DIRECTIONS = ["vertical", "horizontal"] as const;
export type Direction = (typeof DIRECTIONS)[number];

// [LAW:one-type-per-behavior] THE unit of rendering. A segment renders to ONE
// strip item; the powerline joiner joins items, never inside one.
export interface SegmentNode {
  readonly kind: "segment";
  readonly name: string;
  // [LAW:dataflow-not-control-flow] ANDed with the segment decl's own `when`.
  readonly when?: string;
  // [LAW:types-are-the-program] The disclosure BODY this segment opens. The body
  // carries no `when` — openness derives from `ref` at compile, so the gate and
  // the trigger's cycle cannot drift. Synthesis-only: unauthorable by any config.
  readonly opens?: Opens;
}

export interface Opens {
  readonly ref: DisclosureRef;
  readonly body: ContainerNode;
}

// [LAW:types-are-the-program] The pair, never a lone key, identifies one open
// disclosure: accordion siblings share a state key but not a member value.
export interface DisclosureRef {
  readonly variable: string;
  readonly member: string;
}

// [LAW:dataflow-not-control-flow] Every tree rewrite recurses into bodies through
// this one total function, so a body is never the subtree a rewrite forgot.
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
  // Gates the whole subtree: a hidden container emits no lines.
  readonly when?: string;
  readonly distribution?: DistributionName;
}

export type LayoutNode = ContainerNode | SegmentNode;

// [LAW:types-are-the-program] THE canonical root: an insertion-ordered map of
// NAMED rows stacked vertically, so a file declares only the rows that differ and
// an empty row removes one. Row names must be identifiers — never integer-like —
// which keeps property order equal to authoring order under the by-name spread.
export type ContainerOwn = Omit<
  ContainerNode,
  "kind" | "direction" | "children"
>;
export interface Root extends ContainerOwn {
  readonly rows: Readonly<Record<string, LayoutNode>>;
}

// [LAW:types-are-the-program] What a file or preset AUTHORS at `root`: a whole
// tree (replaces the rows) or a rows map (merges by name) — the single branch
// `mergeRoot` folds over, discriminated by the shape written.
export type RootFragment = LayoutNode | Root;

// [LAW:types-are-the-program] `group` is INPUT-only sugar, never a canonical node
// kind: arranging + gating are behaviors `container` already has. `path` records
// the tree position so the shared-key nesting invariant stays checkable.
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

// [LAW:single-enforcer] THE one pre-order walk over a node tree.
export function* walkNodes(node: LayoutNode): IterableIterator<LayoutNode> {
  yield node;
  for (const child of childrenOf(node)) yield* walkNodes(child);
}

// [LAW:one-source-of-truth] "What is under this node" has one answer for both kinds.
export function childrenOf(node: LayoutNode): readonly LayoutNode[] {
  return node.kind === "container"
    ? node.children
    : node.opens === undefined
      ? []
      : [node.opens.body];
}

// [LAW:types-are-the-program] A preset is capped at `root` + `globals` because a
// RenderCache entry's SourceRegistry and click gate are built ONCE and shared by
// many sessions while a preset is a per-SESSION pick — so a preset may carry only
// what the bar RESOLVES per render [LAW:no-ambient-temporal-coupling].
export interface PresetDecl {
  readonly root?: RootFragment;
  // Shallow-merged over the config's own globals, per field.
  readonly globals?: Globals;
}

export interface RawDslConfig {
  readonly globals?: Partial<Globals>;
  readonly variables?: Readonly<Record<string, VariableDecl>>;
  readonly segments?: Readonly<Record<string, SegmentDecl>>;
  readonly root?: RootFragment;
  readonly actions?: Readonly<Record<string, ActionDecl>>;
  readonly presets?: Readonly<Record<string, PresetDecl>>;
  readonly editGlobals?: Partial<Globals>;
  readonly looks?: Readonly<Record<string, ThemeKey>>;
  readonly helpers?: Readonly<Record<string, string>>;
}

export interface DslConfig {
  readonly globals: Globals;
  readonly variables: Readonly<Record<string, VariableDecl>>;
  readonly segments: Readonly<Record<string, SegmentDecl>>;
  // [LAW:one-source-of-truth] The SINGLE canonical layout representation.
  readonly root: Root;
  // [LAW:locality-or-seam] The named seam between click BEHAVIOR and clickable
  // REPRESENTATION. The writable-key gate derives from this table, so a template
  // cannot smuggle an un-gated write.
  readonly actions: Readonly<Record<string, ActionDecl>>;
  // [LAW:one-source-of-truth] Merges by name with the bundled default, so the
  // identity look `none` — the resolution floor — is in every merged config.
  readonly looks: Readonly<Record<string, ThemeKey>>;
  readonly presets: Readonly<Record<string, PresetDecl>>;
  // [LAW:types-are-the-program] Deliberately not `PresetDecl`: the wider type
  // would make an edit fragment that restages the layout representable — a second
  // authority over a tree edit chrome owns. Nothing writes it back, which is why
  // leaving edit mode needs no save/restore path.
  readonly editGlobals: Partial<Globals>;
  // [LAW:single-enforcer] Compiled into ONE shared define set every template
  // inherits, so a formatter is defined once and callable anywhere.
  readonly helpers: Readonly<Record<string, string>>;
}

// [LAW:single-enforcer] The brand symbol is module-private, so validateConfig is
// its only producer and renderer signatures prove the validation step ran.
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
  // [LAW:one-source-of-truth] A NAME; the renderer owns name→Palette resolution.
  readonly palette?: string;

  readonly look?: string;

  // [LAW:one-source-of-truth] A preset's own `globals` may not carry this field:
  // a preset selecting a preset is a second, cyclic authority.
  readonly preset?: string;

  readonly style?: StripStyle;

  readonly autoWrap?: boolean;

  // Spaces INSIDE each cell per side, within the bg fill — not FlexStrip's gap.
  readonly padding?: number;

  readonly charset?: Charset;

  readonly updateNotice?: boolean;

  // "auto" is excluded from the type: the daemon is detached, so env detection
  // would read the daemon's terminal, not the client's.
  readonly colorCompatibility?: ColorCompatibility;
}

// [LAW:one-type-per-behavior] A closed union; there is no extension path past it.
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

// [LAW:types-are-the-program] `type` is the runtime kind at the resolved payload
// path; a default whose literal type disagrees is rejected at load, not at render.
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

// [LAW:types-are-the-program] A present-key union like `cache:`: text is the
// identity (and what an absent `parse:` means), regex slices capture group 1, json
// parses the text as a DOCUMENT whose fields templates read by dotted path.
export type ParseDecl =
  | { readonly text: true }
  | { readonly regex: string }
  | { readonly json: true };

// [LAW:one-source-of-truth] Which arm publishes a document is spelled once.
export function parseArm(
  parse: ParseDecl | undefined,
): "text" | "regex" | "json" {
  if (parse === undefined || "text" in parse) return "text";
  return "regex" in parse ? "regex" : "json";
}

// A `default` lives in its parser's OUTPUT domain — a string for text/regex, a
// document for json. `null` is excluded: an empty document is no fallback.
export type SourceDefault = Exclude<JsonValue, null>;

export interface TemplateVarDecl {
  readonly kind: "template";
  readonly template: string;
  readonly cache?: CacheDecl;
  readonly default?: string;
}

// [LAW:types-are-the-program] ttl is the only cache form a time var honors; past
// the loader a non-ttl cache on one is unrepresentable, not silently coerced.
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

// [LAW:one-source-of-truth] Reads through to the daemon's SessionState; its MobX
// atom makes a click-driven write invalidate downstream computeds. The session id
// comes from `session.id` — [LAW:no-mode-explosion] with no per-decl override.
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

// [LAW:dataflow-not-control-flow] The discriminator is WHICH KEY IS PRESENT, not a
// `kind` field; the union enforces "exactly one of these".
export type CacheDecl =
  | TtlCacheDecl
  | { readonly watch_file: string }
  | { readonly depends_on: readonly string[] }
  | { readonly key: string }
  | { readonly never: true };

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

// [LAW:one-source-of-truth] "Which kinds have a cache field", spelled once.
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

// Kinds where the user MUST declare a cache policy — no sensible default exists.
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
  readonly palette?: string;
  // [LAW:one-source-of-truth] Stored under the namespaced key `<segment>.<var>`;
  // templates reference a local ONLY via that form, from any segment.
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

// [LAW:one-source-of-truth] One name shared by the declaration and the picker's
// read: the usable terminal width renderDsl injects each render.
export const TERM_COLS_VAR = "term.cols";
