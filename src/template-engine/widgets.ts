// [LAW:locality-or-seam] The render half of the widgets seam. A widget is
// reusable interactive content a segment template pulls in via `{{ widget
// "name" }}`. This module compiles widget declarations (pre-parsing the
// copy/open action templates once) and renders a named widget to a single
// RichText whose spans each carry an OSC-8 click URL.
//
// [LAW:one-type-per-behavior] A widget reference is NOT a kind of segment — it
// is content, exactly like `link` or a variable. The `widget` function returns
// a RichText that flows through the same fragmentsToCells → strip pipeline as
// any other template output.
//
// [LAW:dataflow-not-control-flow] `{{ widget "x" }}` is ONE top-level template
// expression, so it must emit ONE value. go-template-js stringifies array
// returns on direct emit, so a func cannot emit multiple fragments — instead we
// assemble one RichText from many link-bearing spans (RichText.fromFragments),
// which serializes to one correctly-delimited OSC-8 region per span. Terminals
// dispatch clicks per OSC-8 region regardless of cc-candybar's cell model.

import { RichText, Style } from "@promptctl/rich-js";
import type { Engine, FuncMap, Template } from "@promptctl/go-template-js";
import type { VariableStore } from "../var-system/store.js";
import { toString as varToString, toNumber } from "../var-system/types.js";
import { buildScope } from "./scope.js";
import {
  isOptionsButtonItem,
  TERM_COLS_VAR,
  type Action,
  type ButtonItem,
  type WidgetDecl,
} from "../config/dsl-types.js";
import { listResolvablePaletteNames, STYLE_ORDER } from "../themes/policy.js";

// ─── Compiled shapes ───────────────────────────────────────────────────────────

// [LAW:types-are-the-program] A `set` action carries literal key/value (literal
// so the validator can be DERIVED — see deriveWidgetValidators); `value: null`
// means "bind the enclosing option's value" (an optionsFrom picker). copy/open
// carry a pre-parsed template evaluated against the live scope at render.
type CompiledAction =
  | {
      readonly kind: "set";
      readonly key: string;
      readonly value: string | null;
    }
  | { readonly kind: "copy"; readonly text: Template<RichText> }
  | { readonly kind: "open"; readonly target: Template<RichText> };

interface CompiledButton {
  // Fixed display text (glyph/label joined). null for an optionsFrom button —
  // each option supplies its own text.
  readonly display: string | null;
  // Optional leading glyph for an optionsFrom button (rendered before each
  // option). null for fixed buttons (display already carries the glyph).
  readonly glyph: string | null;
  // The option list for an optionsFrom button, else null.
  readonly options: readonly string[] | null;
  // The VARIABLE name to read for marking the currently-selected option —
  // resolved at compile time from the set action's SessionState KEY to whatever
  // variable reads that key (a config may name the var differently than the
  // key). null when the button is not an option picker or no variable reads the
  // key (then nothing is marked — a legitimate "current may not exist" state).
  readonly currentVar: string | null;
  readonly actions: readonly CompiledAction[];
}

// [LAW:types-are-the-program] A compiled widget is discriminated by `kind`,
// mirroring WidgetDecl. Both arms share the compiled item list; a menu adds the
// page-state coordinates it paginates against — `stateKey` (the SessionState key
// it writes via ←/→/close) and `stateVar` (the variable that reads it, resolved
// from the key so reading and the row-`when` see one value).
type CompiledWidget =
  | { readonly kind: "buttons"; readonly items: readonly CompiledButton[] }
  | {
      readonly kind: "menu";
      readonly items: readonly CompiledButton[];
      readonly stateKey: string;
      readonly stateVar: string;
    }
  | {
      // [LAW:types-are-the-program] A stepper has NO compiled items — its ◀/▶/
      // current cells are render-derived from (live value, bounds, step), like a
      // menu's ←/→/✕. `stateKey` is the SessionState integer key it writes;
      // `stateVar` is the variable that reads it (resolved from the key so the
      // displayed current and the written value are one source).
      readonly kind: "stepper";
      readonly stateKey: string;
      readonly stateVar: string;
      readonly min: number;
      readonly max: number;
      readonly step: number;
    };

export type CompiledWidgets = ReadonlyMap<string, CompiledWidget>;

// [LAW:locality-or-seam] The runtime holder the `widget` template function
// closes over. Populated after the engine is constructed (the func references
// the engine, the compiled widgets reference the engine — the holder breaks the
// cycle). `store` is the live VariableStore the renderer reads, so the widget
// reads session.id and the current picker value from the same source the rest
// of the render does.
export interface WidgetRuntime {
  store: VariableStore | null;
  compiled: CompiledWidgets;
}

// ─── Compilation ───────────────────────────────────────────────────────────────

// Pre-parse the copy/open action templates for every widget once, at config
// registration. set actions stay literal. [LAW:one-source-of-truth] parse-once,
// evaluate-many — renderWidget only evaluates.
//
// `stateKeyToVar` maps a SessionState key → the variable that reads it, so an
// option picker can mark its current selection by reading the SAME value the
// templates read, regardless of whether the config named the variable after the
// key. Built by the caller from the config's state-kind variable declarations.
export function compileWidgets(
  engine: Engine<RichText>,
  widgets: Readonly<Record<string, WidgetDecl>>,
  stateKeyToVar: ReadonlyMap<string, string>,
): CompiledWidgets {
  const out = new Map<string, CompiledWidget>();
  for (const [name, widget] of Object.entries(widgets)) {
    out.set(name, compileWidget(engine, widget, name, stateKeyToVar));
  }
  return out;
}

// [LAW:dataflow-not-control-flow] One total switch maps each widget kind to its
// compiled shape — every arm reads only its own fields, so there is no
// "does this kind have items / a state key" guard. A new kind is one arm here.
// [LAW:one-source-of-truth] menu and stepper resolve their `state` KEY to the
// variable that reads it (same resolution an option picker uses for its active
// mark), so the widget's displayed value, renderDsl's read, and any row-`when`
// predicate all see ONE value.
function compileWidget(
  engine: Engine<RichText>,
  widget: WidgetDecl,
  name: string,
  stateKeyToVar: ReadonlyMap<string, string>,
): CompiledWidget {
  switch (widget.kind) {
    case "stepper":
      return {
        kind: "stepper",
        stateKey: widget.state,
        stateVar: stateKeyToVar.get(widget.state) ?? widget.state,
        min: widget.min,
        max: widget.max,
        step: widget.step,
      };
    case "menu":
      return {
        kind: "menu",
        items: compileButtons(engine, widget.items, name, stateKeyToVar),
        stateKey: widget.state,
        stateVar: stateKeyToVar.get(widget.state) ?? widget.state,
      };
    case "buttons":
      return {
        kind: "buttons",
        items: compileButtons(engine, widget.items, name, stateKeyToVar),
      };
  }
}

function compileButtons(
  engine: Engine<RichText>,
  items: readonly ButtonItem[],
  name: string,
  stateKeyToVar: ReadonlyMap<string, string>,
): CompiledButton[] {
  return items.map((item) => compileButton(engine, item, name, stateKeyToVar));
}

// [LAW:one-source-of-truth] One item-compile path shared by both widget arms —
// a menu's items are the SAME shape as a buttons widget's. options expand from
// the canonical source lists; the set KEY resolves to the variable that reads it
// for active-marking (falls back to the key itself when the var is named after
// the key; readVar yields "" if no such variable exists).
function compileButton(
  engine: Engine<RichText>,
  item: ButtonItem,
  widgetName: string,
  stateKeyToVar: ReadonlyMap<string, string>,
): CompiledButton {
  const options = isOptionsButtonItem(item)
    ? item.optionsFrom === "themes"
      ? listResolvablePaletteNames()
      : [...STYLE_ORDER]
    : null;
  const actions = item.onClick.map((a) => compileAction(engine, a, widgetName));
  const setKey =
    options !== null
      ? (actions.find((a) => a.kind === "set")?.key ?? null)
      : null;
  const currentVar =
    setKey !== null ? (stateKeyToVar.get(setKey) ?? setKey) : null;
  const display =
    options !== null
      ? null
      : joinDisplay(item.glyph, "label" in item ? item.label : undefined);
  const glyph = options !== null ? (item.glyph ?? null) : null;
  return { display, glyph, options, currentVar, actions };
}

function compileAction(
  engine: Engine<RichText>,
  action: Action,
  widgetName: string,
): CompiledAction {
  if ("set" in action) {
    return { kind: "set", key: action.set, value: action.to ?? null };
  }
  if ("copy" in action) {
    return {
      kind: "copy",
      text: parseActionTemplate(engine, action.copy, widgetName),
    };
  }
  return {
    kind: "open",
    target: parseActionTemplate(engine, action.open, widgetName),
  };
}

function parseActionTemplate(
  engine: Engine<RichText>,
  src: string,
  widgetName: string,
): Template<RichText> {
  try {
    return engine.parse(src);
  } catch (e) {
    throw new Error(
      `Template parse error in widgets.${widgetName} action: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

function joinDisplay(
  glyph: string | undefined,
  label: string | undefined,
): string {
  return [glyph, label].filter((s): s is string => !!s).join(" ");
}

// ─── Rendering ───────────────────────────────────────────────────────────────

// [LAW:single-enforcer] One click-URL composer. encodeURIComponent each segment
// and join with "/". parseHandlerUrl (src/install/index.ts) decodes the WHOLE
// value with a single decodeURIComponent before the daemon splits on "/", so a
// `%2F` inside a segment WOULD decode to a real "/" and be misread as a
// separator. That never happens here because set-state keys/values are
// slash-free by construction (the loader and validators reject "/"), so
// encodeURIComponent emits no `%2F` — the only "/" the daemon sees are the
// structural joiners. The per-segment encoding still matters for other reserved
// characters (spaces, %, etc.), which round-trip cleanly through the single decode.
function clickUrl(verb: string, ...segments: string[]): string {
  const tail = segments.map((s) => encodeURIComponent(s)).join("/");
  return `cc-candybar://${verb}/${tail}`;
}

// [LAW:dataflow-not-control-flow] A button's onClick is homogeneous (the loader
// enforces: all `set`, or one `copy`, or one `open`). set actions batch into one
// set-state URL (the .2 batched wire); copy/open compose their own verb URL.
// `optionValue` is the option string for an optionsFrom button (bound into set
// actions whose literal value is null), else null.
function composeUrl(
  actions: readonly CompiledAction[],
  scope: object,
  sessionId: string,
  optionValue: string | null,
): string {
  const sets = actions.filter(
    (a): a is Extract<CompiledAction, { kind: "set" }> => a.kind === "set",
  );
  if (sets.length > 0) {
    const pairs = sets.flatMap((a) => [a.key, a.value ?? optionValue ?? ""]);
    return clickUrl("set-state", sessionId, ...pairs);
  }
  // [LAW:no-defensive-null-guards] The loader guarantees a non-set button has
  // exactly one copy/open action; index 0 is that action by construction.
  const action = actions[0]!;
  if (action.kind === "copy") {
    return clickUrl("copy", evalTemplate(action.text, scope));
  }
  if (action.kind === "open") {
    return clickUrl("open-vscode", evalTemplate(action.target, scope));
  }
  // [LAW:types-are-the-program] Unreachable: sets.length===0 above means no set
  // action, and the loader rejects an empty/mixed onClick — so index 0 is
  // copy/open. The throw makes the exhaustiveness explicit rather than silent.
  throw new Error("widget: non-set button had no copy/open action");
}

function evalTemplate(tpl: Template<RichText>, scope: object): string {
  return tpl
    .evaluate(scope)
    .map((f) => f.plain)
    .join("");
}

function linkFragment(text: string, url: string, active: boolean): RichText {
  // [LAW:one-source-of-truth] Build the link span exactly as rich-js's `link`
  // does: a Style carrying the OSC-8 url. The active option carries bold so the
  // currently-selected pick reads as current — a value on the span, not a
  // branch in the walk.
  return new RichText(text, { style: new Style({ link: url, bold: active }) });
}

function readVar(store: VariableStore, name: string): string {
  // [LAW:no-defensive-null-guards] "current value may not exist" is a legitimate
  // state (the key was never written) — guard the store lookup, not a downstream
  // operation. has() is the discriminator; absence yields "".
  return store.has(name) ? varToString(store.read(name)) : "";
}

// [LAW:types-are-the-program] One clickable cell: its display text, its OSC-8
// URL, and whether it is the current selection. Both arms render a list of
// these; the only difference is buttons show all of them inline while a menu
// shows one width-paginated page plus derived ←/→/✕ affordances.
interface Cell {
  readonly text: string;
  readonly url: string;
  readonly active: boolean;
}

// [LAW:one-source-of-truth] Expand one compiled item into its cells. An option
// picker yields one cell per option (each binding its value into the set + the
// active mark); a fixed button yields one cell. `extraSets` (a menu's close-set)
// is appended ONLY to set-based items — a copy/open item composes to a single
// non-set verb URL that can't also carry a set, so appending there is a no-op by
// construction rather than a mis-batch.
function expandItemCells(
  item: CompiledButton,
  scope: object,
  sessionId: string,
  store: VariableStore,
  extraSets: readonly CompiledAction[],
): Cell[] {
  const allSet =
    item.actions.length > 0 && item.actions.every((a) => a.kind === "set");
  const actions = allSet ? [...item.actions, ...extraSets] : item.actions;
  if (item.options !== null) {
    const current =
      item.currentVar !== null ? readVar(store, item.currentVar) : "";
    return item.options.map((option) => ({
      text: item.glyph ? `${item.glyph} ${option}` : option,
      url: composeUrl(actions, scope, sessionId, option),
      active: option === current,
    }));
  }
  return [
    {
      text: item.display ?? "",
      url: composeUrl(actions, scope, sessionId, null),
      active: false,
    },
  ];
}

// [LAW:dataflow-not-control-flow] Join link-bearing spans with single-space
// separators into ONE RichText. A widget is one top-level `{{ widget }}`
// expression, so it must emit one value; many OSC-8 regions ride as spans on it.
function assembleFragments(fragments: readonly RichText[]): RichText {
  const spaced: RichText[] = [];
  for (const frag of fragments) {
    if (spaced.length > 0) spaced.push(new RichText(" "));
    spaced.push(frag);
  }
  const assembled = RichText.fromFragments(spaced);
  assembled.noWrap = true;
  assembled.end = "";
  return assembled;
}

const MENU_CLOSE = "✕";
const MENU_PREV = "←";
const MENU_NEXT = "→";

const STEP_DEC = "◀";
const STEP_INC = "▶";

// [LAW:single-enforcer] One display-width measure — rich-js's cellLength, the
// same algebra FlexStrip wraps by — so pagination fits the line the strip
// produces. No second width function.
function cellWidth(text: string): number {
  return new RichText(text).cellLength;
}

// [LAW:dataflow-not-control-flow] A pure function of (item widths, available
// width, reserved width): greedy fill into pages, each page reserving room for
// the ←/→/✕ affordances. The `page` value selects the slice; an oversized lone
// item gets its own page (it can't be split). Infinite width = one page (the
// degenerate "everything fits" case). Exported for direct unit testing.
export function paginate(
  widths: readonly number[],
  available: number,
  reserve: number,
): number[][] {
  if (!Number.isFinite(available)) {
    return widths.length > 0 ? [widths.map((_, i) => i)] : [];
  }
  const usable = Math.max(1, available - reserve);
  const pages: number[][] = [];
  let cur: number[] = [];
  let curW = 0;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i]!;
    if (cur.length === 0) {
      cur = [i];
      curW = w;
    } else if (curW + 1 + w <= usable) {
      cur.push(i);
      curW += 1 + w;
    } else {
      pages.push(cur);
      cur = [i];
      curW = w;
    }
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

// [LAW:dataflow-not-control-flow] The page value (and the live width) select
// which option cells render and which boundary arrows exist — a boundary arrow
// is an ABSENT fragment, never a skipped branch. Every click is a `set` on the
// page key: ←/→ navigate (render-computed p±1), ✕ closes (-1). Option clicks
// already carry apply-and-close via expandItemCells's appended close-set.
function renderMenu(
  menu: Extract<CompiledWidget, { kind: "menu" }>,
  scope: object,
  sessionId: string,
  store: VariableStore,
): RichText {
  const closeSet: CompiledAction = {
    kind: "set",
    key: menu.stateKey,
    value: "-1",
  };
  const cells = menu.items.flatMap((item) =>
    expandItemCells(item, scope, sessionId, store, [closeSet]),
  );

  const width = toNumber(store.read(TERM_COLS_VAR));
  const widths = cells.map((c) => cellWidth(c.text));
  // ✕ is always present; ←/→ appear only on a multi-page menu. Reserving arrow
  // space unconditionally is self-fulfilling — a run that fits on one line with
  // just ✕ could be forced to split, making the arrows appear unnecessarily. So
  // paginate first with only the close overhead; if that already fits on one
  // page, no arrows are needed. Only when it genuinely overflows do we
  // re-paginate reserving ←/→ space, so every page of a multi-page menu has
  // consistent room for navigation. [LAW:dataflow-not-control-flow] the page
  // count (data) selects which reservation applies, not a config flag.
  const closeReserve = cellWidth(MENU_CLOSE) + 1;
  const arrowReserve = cellWidth(MENU_PREV) + 1 + cellWidth(MENU_NEXT) + 1;
  const firstPass = paginate(widths, width, closeReserve);
  const pages =
    firstPass.length > 1
      ? paginate(widths, width, closeReserve + arrowReserve)
      : firstPass;

  // [LAW:no-defensive-null-guards] The page value genuinely may be absent/empty
  // (the key was never written) — that optionality is real, so parse it at this
  // trust boundary (parseInt, not toNumber which throws on ""). The row-`when`
  // gates rendering to page>=0; an out-of-range or unset value clamps into the
  // existing page set, so the menu never indexes a non-existent page.
  const rawPage = parseInt(readVar(store, menu.stateVar), 10);
  const page = Number.isInteger(rawPage)
    ? Math.max(0, Math.min(rawPage, pages.length - 1))
    : 0;
  const pageCells = pages[page] ?? [];

  const setUrl = (value: number | string): string =>
    clickUrl("set-state", sessionId, menu.stateKey, String(value));

  const frags: RichText[] = [linkFragment(MENU_CLOSE, setUrl(-1), false)];
  if (page > 0) frags.push(linkFragment(MENU_PREV, setUrl(page - 1), false));
  for (const i of pageCells) {
    const cell = cells[i]!;
    frags.push(linkFragment(cell.text, cell.url, cell.active));
  }
  if (page < pages.length - 1) {
    frags.push(linkFragment(MENU_NEXT, setUrl(page + 1), false));
  }
  return assembleFragments(frags);
}

// [LAW:dataflow-not-control-flow] Three derived cells from one value: ◀ writes
// (current − step), the display shows current, ▶ writes (current + step). The
// stepper owns NAVIGATION — stepping past a bound WRAPS to the other end (one
// behavior for every stepper, no clamp-vs-wrap mode). Bounds themselves are the
// range validator's single concern; the wrapped writes always land inside
// bounds, so the gate passes them through. The current display is a plain (non-
// link) span — only the affordances are clickable.
function renderStepper(
  stepper: Extract<CompiledWidget, { kind: "stepper" }>,
  sessionId: string,
  store: VariableStore,
): RichText {
  // [LAW:single-enforcer] The range validator clamps every WRITTEN value into
  // bounds — but a state variable's `default` is config, not a write, so it
  // bypasses the gate. Mirror the validator's canonical-integer shape (`^-?\d+$`)
  // at this read boundary: only an integer-shaped string is a value (then
  // clamped into [min,max]); anything else — empty (unset/no backing var), a
  // float "3.5", a typo "14abc" — is NOT loosely parsed (parseInt would yield
  // 3/14), it starts at the floor. So the displayed current is always an in-range
  // integer the wire validator would also accept.
  const rawStr = readVar(store, stepper.stateVar);
  const current = /^-?\d+$/.test(rawStr)
    ? Math.max(stepper.min, Math.min(stepper.max, parseInt(rawStr, 10)))
    : stepper.min;
  const dec = current - stepper.step;
  const inc = current + stepper.step;
  const wrapped = (v: number): number =>
    v > stepper.max ? stepper.min : v < stepper.min ? stepper.max : v;
  const setUrl = (value: number): string =>
    clickUrl("set-state", sessionId, stepper.stateKey, String(value));
  return assembleFragments([
    linkFragment(STEP_DEC, setUrl(wrapped(dec)), false),
    new RichText(String(current)),
    linkFragment(STEP_INC, setUrl(wrapped(inc)), false),
  ]);
}

// Render a named widget to one RichText (many link-bearing spans). The `widget`
// template function delegates here.
export function renderWidget(name: string, runtime: WidgetRuntime): RichText {
  const widget = runtime.compiled.get(name);
  // [LAW:no-defensive-null-guards] The loader validates every `{{ widget "x" }}`
  // reference resolves to a declared widget, and compileWidgets compiled every
  // declared widget for THIS config's engine. A miss is a caller/wiring bug.
  if (!widget) {
    throw new Error(`widget "${name}" is not declared in this config`);
  }
  const store = runtime.store;
  if (!store) {
    throw new Error(
      `widget "${name}" rendered without a VariableStore — registerDslConfig was not given one`,
    );
  }
  const scope = buildScope(store);
  const sessionId = readVar(store, "session.id");

  // [LAW:dataflow-not-control-flow] One total switch selects the per-kind
  // assembly; every arm produces ONE RichText of link-bearing spans. A buttons
  // widget is the degenerate menu — all cells on one line, no pagination.
  switch (widget.kind) {
    case "menu":
      return renderMenu(widget, scope, sessionId, store);
    case "stepper":
      return renderStepper(widget, sessionId, store);
    case "buttons": {
      const cells = widget.items.flatMap((item) =>
        expandItemCells(item, scope, sessionId, store, []),
      );
      return assembleFragments(
        cells.map((c) => linkFragment(c.text, c.url, c.active)),
      );
    }
  }
}

// ─── FuncMap entry ─────────────────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] One zero-config func; the widget NAME is the
// data that selects which declared component renders. Returns T (RichText), the
// single fragment go-template-js emits for `{{ widget "name" }}`.
export function widgetFuncs(runtime: WidgetRuntime): FuncMap {
  return {
    widget: {
      fn: (name: string) => renderWidget(name, runtime),
      argTypes: ["string"],
      returnType: "T",
    },
  };
}
