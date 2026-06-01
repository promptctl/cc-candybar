// [LAW:types-are-the-program] The author-facing SHAPE of every interactive
// widget — the config-file schema for `DslConfig.widgets`. These are pure data
// types (no engine, no rich-js): the strongest theorem about what a user can
// write. The loader narrows `unknown` to these; the runtime (render/widget.ts)
// and the validator derivation (daemon/verbs/state-validators.ts) consume them.
//
// [LAW:locality-or-seam] A widget is a reusable interactive component declared
// in `DslConfig.widgets` and referenced from a segment template via
// `{{ widget "name" }}`. It is NOT a kind of segment — there is one Segment
// type; a widget reference is content a template uses, exactly like `link` or a
// variable. Whether a segment shows text, a button, both, or neither falls out
// of what its template contains, never a segment-type distinction.
//
// [LAW:one-way-deps] This module is a pure leaf — it imports nothing from the
// rest of `config/`. `dsl-types.ts` imports `WidgetDecl` from here (not the
// reverse), so the widget schema can be lifted out of the layout/variable
// substrate without a cycle.

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
// `Action | Action[]` union for consumers to normalize. The list may mix kinds:
// every `set` batches into one atomic set-state effect, each `copy`/`open` is its
// own effect, and all ride one `dispatch` click URL.
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

// [LAW:types-are-the-program] A tree (outline-menu) item is discriminated by
// presence of `items`: a SUBMENU carries children (and a chevron flips on its
// open-state — clicking it toggles, an effect that is render-DERIVED, never
// author-bound, so a submenu has NO onClick); a LEAF is a plain `ButtonItem`
// (onClick + optionsFrom pickers) reused verbatim. [LAW:one-type-per-behavior]
// a leaf and a bar button have identical behavior, so they are ONE type — the
// menu adds only the branch node, not a second button concept. The recursion is
// the only new shape; everything clickable is the existing ButtonItem.
export interface SubmenuItem {
  readonly glyph?: string;
  readonly label?: string;
  readonly items: readonly MenuTreeItem[];
}
export type MenuTreeItem = ButtonItem | SubmenuItem;

export function isSubmenuItem(item: MenuTreeItem): item is SubmenuItem {
  return "items" in item;
}

// [LAW:one-type-per-behavior] Widgets are discriminated by `kind` (the
// VariableDecl pattern). The foundation ships `buttons`; `menu` (width-
// paginated, open-page state) and `stepper` (numeric dec/cur/inc) are arms;
// `tree` (the nested outline menu) is the latest arm — the segment surface
// stays untouched.
export interface ButtonsWidget {
  readonly kind: "buttons";
  readonly items: readonly ButtonItem[];
}

// [LAW:types-are-the-program] A `menu` is a `buttons` whose item run is too
// wide for one line: the SAME `items` shape, plus the page state it indexes.
// `state` names the SessionState integer key the menu reads to choose its
// page (-1/absent = closed) and writes for navigation (←/→) and apply-and-
// close. The page key carries the whole open/closed/which-page discriminator
// in ONE value — no separate isOpen flag to drift [LAW:one-source-of-truth].
//
// The author declares a MENU OF OPTIONS; pages, the ←/→/✕ affordances, and
// their click URLs are DERIVED at render from `state` + the live terminal
// width — never hand-authored. Each option click APPLIES its own set(s) AND
// writes `state` to -1 (apply-and-close) via the existing batched set-state
// wire; no menu-specific action vocabulary.
export interface MenuWidget {
  readonly kind: "menu";
  readonly state: string;
  readonly items: readonly ButtonItem[];
}

// [LAW:types-are-the-program] A `stepper` is a numeric control: three derived
// cells (◀ current ▶) bound to ONE integer SessionState key with [min,max]
// bounds and an increment. Unlike buttons/menu it has NO author `items` — its
// affordances are render-derived from (current, step), exactly as a menu's
// ←/→/✕ are. ◀/▶ navigate by ∓step and WRAP past a bound to the other end, so
// the cells emit values already inside [min,max]; the range validator (derived
// from min/max) owns the bounds for any other write. `step` lives here (render
// needs it) and deliberately NOT in the derived validator spec — legality is
// "an integer in [min,max]", which step does not affect and which merges cleanly
// across configs where step would not.
export interface StepperWidget {
  readonly kind: "stepper";
  readonly state: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

// [LAW:types-are-the-program] A `tree` is the OUTLINE projection of the menu: a
// recursive item tree (leaf | submenu) rendered as nested lines — the root
// toggle and each open submenu's children each occupy their own full-width line
// (the "\n" → splitCellsIntoLines primitive does the vertical partition). Like
// menu/stepper it OWNS one SessionState key — here the open-PATH (which submenu
// chain is expanded). That one value carries the whole closed/open/which-branch
// discriminator [LAW:one-source-of-truth]; its legal values are statically
// enumerable from the item tree (enumerateOpenPaths), so the allow-list
// validator is DERIVED, never hand-declared. Accordion is the only mode: one
// path open per branch, so the state is a single path string, not a set.
export interface TreeWidget {
  readonly kind: "tree";
  readonly state: string;
  readonly items: readonly MenuTreeItem[];
}

export type WidgetDecl =
  | ButtonsWidget
  | MenuWidget
  | StepperWidget
  | TreeWidget;

export const WIDGET_KINDS = ["buttons", "menu", "stepper", "tree"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

// ─── Outline-menu open-path encoding ────────────────────────────────────────
//
// [LAW:one-source-of-truth] THE canonical encoding of a tree's open-state, read
// by BOTH the validator derivation (the allow-list members) and the renderer
// (which submenu chain to expand). Defined once here so the gate's accepted set
// and the renderer's understood set cannot drift.
//
// A value is one of: MENU_CLOSED (collapsed — only the root toggle shows),
// MENU_OPEN_ROOT (open at the top level, no submenu expanded), or a separator-
// joined index path naming the expanded submenu chain ("0", "0.2", …). The
// separator is "." NOT "/" — the set-state wire splits its tail on "/", so a
// "/"-bearing value could never be addressed (makeAllowListValidator rejects
// them); "." is wire-safe. Index paths are purely numeric, so the alpha
// sentinels can never collide with a real path.
export const MENU_PATH_SEP = ".";
export const MENU_CLOSED = "closed";
export const MENU_OPEN_ROOT = "open";

// [LAW:dataflow-not-control-flow] An open-path is an index list; the wire VALUE
// is its string form. Empty list ≡ MENU_OPEN_ROOT (open, nothing drilled). One
// pair of total functions both consumers share.
export function openPathToString(indices: readonly number[]): string {
  return indices.length === 0 ? MENU_OPEN_ROOT : indices.join(MENU_PATH_SEP);
}

// [LAW:single-enforcer] THE place a tree's legal open-path VALUES are enumerated
// from its item tree — closed, open-root, and one path per submenu (leaves never
// open, so they contribute none). The allow-list validator's members are exactly
// this list, so every value the renderer can write is a value the gate accepts.
export function enumerateOpenPaths(items: readonly MenuTreeItem[]): string[] {
  const paths: string[] = [MENU_CLOSED, MENU_OPEN_ROOT];
  const walk = (level: readonly MenuTreeItem[], prefix: readonly number[]) => {
    level.forEach((item, i) => {
      if (!isSubmenuItem(item)) return;
      const path = [...prefix, i];
      paths.push(openPathToString(path));
      walk(item.items, path);
    });
  };
  walk(items, []);
  return paths;
}

// [LAW:dataflow-not-control-flow] Does any leaf anywhere in the tree bind a
// `set` action? Drives the loader's session.id requirement (a set-state click
// needs the session id on the wire). One recursive fold, no per-kind branching
// at the callsite.
export function treeBindsSet(items: readonly MenuTreeItem[]): boolean {
  return items.some((item) =>
    isSubmenuItem(item)
      ? treeBindsSet(item.items)
      : item.onClick.some((action) => "set" in action),
  );
}

// [LAW:single-enforcer] The ONE place mapping a widget kind to its SessionState
// relationship, as DATA. Every consumer (the loader's backing-var and session.id
// checks; the validator derivation reads the richer spec form in
// state-validators) reads these fields — none re-switches on kind. A new widget
// kind is one new arm in this exhaustive switch, and the compiler forces it.
//   readsKey   — the key the widget READS BACK (a menu's page, a tree's open-
//                path, a stepper's value); null for buttons. A row `when` and the
//                backing-var check key off this.
//   hasSetItem — whether an author item binds a `set` action (buttons/menu/tree).
export interface WidgetStateUse {
  readonly readsKey: string | null;
  readonly hasSetItem: boolean;
}
export function widgetStateUse(w: WidgetDecl): WidgetStateUse {
  switch (w.kind) {
    case "stepper":
      return { readsKey: w.state, hasSetItem: false };
    case "menu":
      return { readsKey: w.state, hasSetItem: itemsBindSet(w.items) };
    case "tree":
      return { readsKey: w.state, hasSetItem: treeBindsSet(w.items) };
    case "buttons":
      return { readsKey: null, hasSetItem: itemsBindSet(w.items) };
  }
}
function itemsBindSet(items: readonly ButtonItem[]): boolean {
  return items.some((item) => item.onClick.some((action) => "set" in action));
}
