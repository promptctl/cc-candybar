// [LAW:locality-or-seam] A `{{ picker "applyAction" "pageAction" closeOnPick
// paged }}` call renders a width-fit grid of option cells over the action table:
// each option cell APPLIES the named option action (and, when closeOnPick, also
// resets the named page action's key in the SAME atomic write); ✕/←/→ navigate
// the page cursor. The picker is a pure RENDER helper — it owns no state and no
// new gate. It references two ALREADY-declared, ALREADY-gated actions by name
// (the apply set-option → its option domain + the theme key's allow-list gate;
// the page set-int → the page key's int gate), so the rendered clicks and the
// wire gate share one source: the action table.
//
// [LAW:one-type-per-behavior] There is no `menu`/`picker` TYPE — a picker is
// content a segment template pulls in, exactly like `action`. This is the
// successor to the deleted menu/buttons widget runtime: the same `paginate` fold
// and ←/→/✕ projection, re-expressed over named actions instead of a widget union.
//
// [LAW:dataflow-not-control-flow] Paged vs wrap is ONE value, not a mode: the
// `paged` flag selects the available width passed to `paginate` (term.cols vs
// Infinity). Infinite width ⇒ one page ⇒ the long line wraps via FlexStrip; finite
// ⇒ a sliced page with ←/→. The same fold, same emit pipeline; the width value
// (and the matching overflow) select the shape.
//
// [LAW:one-way-deps] Lives in render/ (depends on template-engine/ + ./action.js),
// injected into the engine by the caller (registerDslConfig hands pickerFuncs in
// as data). The generic engine never imports this module.

import { RichText, Style } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import { effectsUrl, VERB_SET_STATE } from "../click/wire.js";
import {
  presentedAction,
  linkFragment,
  realize,
  readVar,
  type ActionRuntime,
  type CompiledActionDecl,
} from "./action.js";
import { DISCLOSURE_GLYPH_CLOSE } from "../config/disclosure.js";
import { optionItemStyle } from "./band-style.js";
import { sanitizeText } from "./diagnostic-text.js";
import { fitCells, libraryLayout, type LibraryPageLayout } from "./library.js";
import { refuseSurplus } from "../template-engine/optional-tail.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";
import { placedBy, type Position } from "../themes/decor.js";

// [LAW:locality-or-seam] How an option cell is coloured, as a VALUE the caller
// hands in: the picker lays out item `position` (which option, of how many) and
// names the `option` that cell applies, and knows nothing of bands, hues, depth,
// palettes, or how the instance PLACES its options — the caller completes the
// position into an address step with its own distribution, and decides whether
// the OPTION or its position is what colours the cell. Both callers go through
// the one `optionItemStyle`, so a menu body and a standalone `{{ picker }}`
// colour their items by one rule.
//
// The option was always sitting beside the call site below and was never passed,
// which is why no item style could be a function of the choice being offered
// (brandon-picker-31z).
export type ItemStyle = (position: Position, option: string) => Style;

const PICKER_PREV = "←";
const PICKER_NEXT = "→";

// [LAW:single-enforcer] One display-width measure — rich-js's cellLength, the
// same algebra FlexStrip wraps by — so pagination fits the line the strip
// produces. No second width function.
export function cellWidth(text: string): number {
  return new RichText(text).cellLength;
}

// [LAW:single-enforcer] The width one option row may fill: the render's width
// less what the row's own segment spends around it. The width is the raw
// usable width the strip wraps to (`.term.cols` in a template); the row is
// itself a styled strip segment, so the joiner brackets it with caps
// (powerline's lead and tail, capsule's two caps) that FlexStrip counts inside
// that width, and the segment layout pads every line it emits by the render's
// intra-cell padding on both sides. A row packed to the full width is pushed
// past it by both — the maximally-packed middle pages once overflowed and the
// terminal ate the trailing →. Reserved HERE, at the row-fitting seam, rather
// than by shrinking the width every template reads; stripChromeCols measures
// the per-shape geometry. The picker and the carousel both fit a row by this
// one budget.
export function rowBudget(runtime: ActionRuntime): number {
  return Math.max(1, runtime.width - runtime.chromeCols - 2 * runtime.padding);
}

// [LAW:single-enforcer] The width a row may fill when it sits in an open
// disclosure body: the row budget less the ✕ that body leads every row with
// (render/disclosure-close.ts), which the walk lays as a cell of its own — its
// glyph, the padding every cell wears, and the seam the joiner lays before the
// next cell. Reserved whether or not the row really sits in a body, so a bare
// row fits the same width a body's would; the template cannot see where it is.
export function ledRowBudget(runtime: ActionRuntime): number {
  return Math.max(
    1,
    rowBudget(runtime) -
      (cellWidth(DISCLOSURE_GLYPH_CLOSE) +
        2 * runtime.padding +
        runtime.seamCols),
  );
}

// [LAW:dataflow-not-control-flow] A pure function of (item widths, available
// width, reserved width): greedy fill into pages, each reserving room for the
// ←/→/✕ affordances. The `page` value selects the slice; an oversized lone item
// gets its own page (it can't be split). Infinite width = one page (the wrap
// case — everything on one line, FlexStrip breaks it). Exported for unit testing.
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

// ✕ is always present; ←/→ appear only on a multi-page grid. Reserve arrow
// space only after a first pass proves it overflows — reserving it
// unconditionally is self-fulfilling (a run that fits with just ✕ could be
// forced to split, making arrows appear unnecessarily). At an infinite width
// (the wrap case) paginate yields one page, so neither pass splits.
function gridPages(
  widths: readonly number[],
  available: number,
): readonly LibraryPageLayout[] {
  const closeReserve = cellWidth(DISCLOSURE_GLYPH_CLOSE) + 1;
  const arrowReserve = cellWidth(PICKER_PREV) + 1 + cellWidth(PICKER_NEXT) + 1;
  const firstPass = paginate(widths, available, closeReserve);
  return (
    firstPass.length > 1
      ? paginate(widths, available, closeReserve + arrowReserve)
      : firstPass
  ).map((cells) => [{ label: "", indices: cells }]);
}

// [LAW:dataflow-not-control-flow] Join link-bearing spans with single-space
// separators into ONE RichText (a picker is one `{{ picker }}` expression, so it
// must emit one value; the option/affordance cells ride as spans on it). Its
// overflow is the `paged` value: a paged page is one unbounded line (`"ignore"`:
// no break, no cut — the page already fits); a wrap-mode run is the long line
// FlexStrip is ALLOWED to break across lines.
export function assemble(frags: readonly RichText[], paged: boolean): RichText {
  const spaced: RichText[] = [];
  for (const frag of frags) {
    if (spaced.length > 0) spaced.push(new RichText(" "));
    spaced.push(frag);
  }
  const assembled = RichText.fromFragments(spaced);
  assembled.overflow = paged ? "ignore" : undefined;
  assembled.end = "";
  return assembled;
}

// [LAW:types-are-the-program] The page cursor a picker paginates by: the
// SessionState `key` its ←/→/✕ clicks write and the `stateVar` that reads the
// live page back. The standalone `{{ picker }}` resolves it from its named
// set-int page action; a `{{ menu }}` derives it from the menu's identity
// (menuPageKey) — one value shape, two provenances, one renderer.
export interface PickerPage {
  readonly key: string;
  readonly stateVar: string;
}

// [LAW:dataflow-not-control-flow] What a "close" WRITES, as data — the (key,
// value) pairs folded into one atomic set-state by both the ✕ affordance and a
// closeOnPick option click. The standalone picker closes by paging to -1 (the
// when-gate idiom); a menu closes by writing its disclosure key back to the
// closed sentinel and resetting its page cursor. The picker itself never
// branches on which world it is in — the writes flow in.
export type CloseWrites = ReadonlyArray<readonly [key: string, value: string]>;

// [LAW:no-defensive-null-guards] The loader proves both picker arg names resolve
// to declared actions; this asserts the KIND each must be (apply ⇒ set-option,
// page ⇒ set-int) — a wrong kind is an author error surfaced loudly at render
// (composeWithDiagnostics shows it), not a silent empty picker.
function requireKind<K extends CompiledActionDecl["kind"]>(
  runtime: ActionRuntime,
  name: string,
  kind: K,
  shape: string,
): Extract<CompiledActionDecl, { kind: K }> {
  const action = runtime.compiled.get(name);
  if (!action || action.kind !== kind) {
    throw new Error(
      `picker references action "${name}" which must be ${shape}, got ${action ? `a ${action.kind} action` : "no such action"}`,
    );
  }
  return action as Extract<CompiledActionDecl, { kind: K }>;
}

// [LAW:one-source-of-truth] The apply action a picker grid binds to is one of
// THREE option-domain-driven kinds (src/render/action.ts): set-option/
// persist-option (a picked value is WRITTEN VERBATIM — set-option's two
// durability twins, differing only in wire verb VERB_SET_CONFIG vs
// VERB_SET_STATE) or layout-op-option (a picked value is ENCODED into a
// structural LayoutOp before writing — brandon-layout-edit-2gc.3's
// `insertSegmentFrom`). All three share the same option-domain gate
// (deriveActionValidators/deriveConfigActionValidators) and the same "pick a
// cell, apply it" shape; only WHAT the click writes differs, which is
// realize()'s job, not the picker's. Rejecting any of the three here would be
// an artificial gap — there is nothing about "picker" that excludes one kind.
//
// [LAW:single-enforcer] Exported so the one thing a caller needs BEFORE the grid
// renders — the option domain's own painter, for `optionItemStyle` — is read
// through the same resolution renderPicker itself makes, a `do`'s head
// included. A second lookup could disagree with the grid about which action
// the options belong to.
export function requireOptionKind(
  runtime: ActionRuntime,
  name: string,
  helper: "picker" | "menu" | "carousel",
): Extract<
  CompiledActionDecl,
  { kind: "set-option" | "persist-option" | "layout-op-option" }
> {
  // [LAW:dataflow-not-control-flow] A `do` resolves to its head BEFORE the
  // kind check, so a picker over a `do` headed by an option action is a picker
  // over that option kind — the grid, its current-mark, and its close folding
  // are the code they already were.
  const declared = runtime.compiled.get(name);
  const action = declared ? presentedAction(declared) : declared;
  if (
    !action ||
    (action.kind !== "set-option" &&
      action.kind !== "persist-option" &&
      action.kind !== "layout-op-option")
  ) {
    throw new Error(
      `${helper} references action "${name}" which must be a set-option, persist-option, or layout-op-option action ({ set, from }, { persist, from }, or { persist, insertSegmentFrom, anchor, relation }), got ${action ? `a ${action.kind} action` : "no such action"}`,
    );
  }
  return action;
}

// [LAW:dataflow-not-control-flow] The page value (and the live width) select
// which option cells render and which boundary arrows exist — a boundary arrow is
// an ABSENT fragment, never a skipped branch. ←/→ navigate the page key
// (render-computed p±1); ✕ performs the caller-supplied close writes; each
// option click APPLIES its option AND (when closeOnPick) folds the same close
// writes into one atomic set-state — the caller owns what closing means, so the
// author never re-states a key.
// [LAW:single-enforcer] Exported so the `{{ menu }}` helper renders its body
// through the SAME picker renderer — a menu body IS a picker grid; there is no
// second grid implementation to drift. The menu adds only the disclosure
// wrapper, never a parallel picker.
export function renderPicker(
  applyName: string,
  page: PickerPage,
  close: CloseWrites,
  closeOnPick: boolean,
  paged: boolean,
  runtime: ActionRuntime,
  itemStyle: ItemStyle,
): readonly RichText[] {
  const apply = requireOptionKind(runtime, applyName, "picker");
  // [LAW:one-source-of-truth] The GRID reads the presented action above (its
  // options, its current-mark); the CLICK is realized from the declaration
  // itself, through the same fold `{{ action }}` uses. That is what carries a
  // `do`'s followers into a picked option — the picker never learns what a
  // `do` is, and there is no second projection of "what does this option
  // write" to drift from realize's.
  const declared = runtime.compiled.get(applyName)!;
  const store = runtime.store;
  const sessionId = readVar(store, "session.id");
  // [LAW:no-defensive-null-guards] layout-op-option carries no `stateVar` —
  // a structural insert is a one-shot trigger, not a persisted single value,
  // so there is no "current selection" to mark. `undefined` here (never a
  // magic sentinel string) makes every option's `option === current` compare
  // false below, structurally rather than by accident.
  const current =
    "stateVar" in apply ? readVar(store, apply.stateVar) : undefined;

  // In wrap mode (available = Infinity) everything stands on one page.
  const available = paged ? rowBudget(runtime) : Infinity;

  // [LAW:dataflow-not-control-flow] A page is the sections it shows; a plain
  // domain's one section is the run of cells `paginate` fits to the width, and
  // a catalogue domain's (`library`, src/config/option-domain.ts) are its
  // groups. The cursor, the ←/→/✕ affordances and the click are the same code
  // either way — only what a page is made of differs, and that is data. The
  // catalogue's entries are taken once, here, and read by layout and rows.
  const catalogue = apply.library && {
    groups: apply.library.groups,
    entries: apply.options.map(apply.library.entry),
  };
  const pages: readonly LibraryPageLayout[] =
    catalogue !== undefined
      ? libraryLayout(catalogue.entries, catalogue.groups, paged)
      : gridPages(apply.options.map(cellWidth), available);

  // [LAW:no-defensive-null-guards] The page value genuinely may be absent/empty
  // (the key was never written) — parse it at this trust boundary; an out-of-range
  // or unset value clamps into the existing page set, so the picker never indexes
  // a non-existent page. The segment's `when` gates visibility on page >= 0.
  const rawPage = parseInt(readVar(store, page.stateVar), 10);
  const pageIdx = Number.isInteger(rawPage)
    ? Math.max(0, Math.min(rawPage, pages.length - 1))
    : 0;
  const pageSections = pages[pageIdx] ?? [];

  const pageUrl = (value: number): string =>
    effectsUrl([
      { verb: VERB_SET_STATE, args: [sessionId, page.key, String(value)] },
    ]);
  // [LAW:dataflow-not-control-flow] The close writes arrive as data (see
  // CloseWrites); ✕ performs exactly them, and a closeOnPick option click folds
  // the same pairs into its apply write — one atomic set-state either way, so
  // "what closing means" cannot diverge between the two affordances.
  const closeFlat = close.flatMap(([k, v]) => [k, v]);
  const closeUrl = effectsUrl([
    { verb: VERB_SET_STATE, args: [sessionId, ...closeFlat] },
  ]);
  // [LAW:single-enforcer] A closeOnPick option click is the pick's own effects
  // followed by the close writes — concatenated, nothing more. The daemon's
  // dispatch joins adjacent session writes into one atomic batch, so a session
  // pick and its close land together, and a durable pick (set-config, a layout
  // op) keeps its own verb and its place before the close.
  // This is the same concatenation a `do` action's members get: one rule for
  // "several writes, one click", not one per producer.
  const closeEffects = closeOnPick
    ? [{ verb: VERB_SET_STATE, args: [sessionId, ...closeFlat] }]
    : [];
  const optionUrl = (option: string): string =>
    effectsUrl([
      ...realize(declared, option, option, store, sessionId).effects,
      ...closeEffects,
    ]);

  // [LAW:dataflow-not-control-flow] An item is placed by its index in the
  // WHOLE option domain, not on its page: paging changes which cells show,
  // never what colour an option is.
  const optionCell = (i: number, text: string): RichText => {
    const option = apply.options[i]!;
    return linkFragment(
      text,
      optionUrl(option),
      option === current,
      itemStyle({ index: i, count: apply.options.length }, option),
    );
  };
  const nav: RichText[] = [
    linkFragment(DISCLOSURE_GLYPH_CLOSE, closeUrl, false),
  ];
  if (pageIdx > 0) {
    nav.push(linkFragment(PICKER_PREV, pageUrl(pageIdx - 1), false));
  }
  const next =
    pageIdx < pages.length - 1
      ? [linkFragment(PICKER_NEXT, pageUrl(pageIdx + 1), false)]
      : [];

  if (catalogue === undefined) {
    const indices = pageSections.flatMap((section) => section.indices);
    return [
      assemble(
        [
          ...nav,
          ...indices.map((i) => optionCell(i, apply.options[i]!)),
          ...next,
        ],
        paged,
      ),
    ];
  }

  // A library page: the nav row names where the reader is — the page's group
  // whenever it holds one, and its place when there are several pages — then
  // one row per member, name and description, each row the member's whole
  // click target.
  const bold = new Style({ bold: true });
  const position = pages.length > 1 ? ` ${pageIdx + 1}/${pages.length}` : "";
  const where =
    pageSections.length === 1
      ? [new RichText(`${pageSections[0]!.label}${position}`, { style: bold })]
      : [];
  const lines: RichText[] = [assemble([...nav, ...where, ...next], paged)];
  for (const section of pageSections) {
    if (pageSections.length > 1) {
      lines.push(
        assemble([new RichText(section.label, { style: bold })], paged),
      );
    }
    const nameWidth = Math.max(
      ...section.indices.map((i) => cellWidth(apply.options[i]!)),
    );
    for (const i of section.indices) {
      const option = apply.options[i]!;
      // An authored description is free text and a row is one cell: control
      // characters and line breaks fold to single spaces, as a diagnostic's do.
      const authored = catalogue.entries[i]!.description;
      const description =
        authored === undefined ? undefined : sanitizeText(authored);
      const gap = " ".repeat(nameWidth - cellWidth(option) + 2);
      const row =
        description === undefined ? option : `${option}${gap}${description}`;
      lines.push(assemble([optionCell(i, fitCells(row, available))], paged));
    }
  }
  return lines;
}

// [LAW:dataflow-not-control-flow] One func; the two action NAMES select which
// declared effects fire, the two bools are the bounded author choices
// (closeOnPick, paged). Returns T (RichText), the single fragment go-template-js
// emits for `{{ picker … }}`.
//
// [LAW:no-mode-explosion] Both bools are OPTIONAL trailing values with a
// documented default of `false`: `closeOnPick=false` is stay-open (a pick
// recolors live and LEAVES THE MENU OPEN so themes can be tried in a row — the
// baseline UX; the ✕ affordance closes), `closeOnPick=true` is the opt-in where a
// pick ALSO writes the page key closed; `paged=false` is one wrapping page,
// `paged=true` slices into ←/→ pages at the live width. Go spells an optional
// tail as a variadic parameter, so the gate requires the two action names and
// types every bool after them, an omitted bool arrives `undefined` and resolves
// to the default here, and the body refuses a third. Authoring stay-open +
// paged is `{{ picker "a" "p" false true }}`.
//
// [LAW:one-way-deps] The caller injects this FuncMap into createCcCandybarEngine
// (capabilities-over-context) so the generic engine never imports the picker.
export function pickerFuncs(
  runtime: ActionRuntime,
  activeSegment: ActiveSegmentRef,
): FuncMap {
  return {
    picker: {
      fn: (
        applyName: string,
        pageName: string,
        closeOnPick?: boolean,
        paged?: boolean,
        ...extra: boolean[]
      ) => {
        refuseSurplus(`picker "${applyName}"`, ["closeOnPick", "paged"], extra);
        // [LAW:one-source-of-truth] The standalone picker's page cursor comes
        // from its NAMED set-int action (the documented desugaring surface);
        // closing means paging to -1, the when-gate idiom its host row reads
        // (`{{ ge (int .page) 0 }}`).
        const page = requireKind(
          runtime,
          pageName,
          "set-int",
          "an int action ({ set, int: true })",
        );
        // [LAW:no-silent-failure] `{{ picker }}` is one expression and emits
        // one value, so it cannot carry a library's several rows; a menu body
        // is where a catalogue domain lays out. Refused by what the domain
        // declares, before anything renders.
        const apply = requireOptionKind(runtime, applyName, "picker");
        if (apply.library !== undefined) {
          throw new Error(
            `{{ picker "${applyName}" … }} ranges a catalogue domain, which lays out as one row per member; a catalogue renders in a {{ menu }} body`,
          );
        }
        const [line] = renderPicker(
          applyName,
          { key: page.key, stateVar: page.stateVar },
          [[page.key, "-1"]],
          closeOnPick === true,
          paged === true,
          runtime,
          // A bare `{{ picker }}` authors no options dict, so it places by
          // the default — the same resolution a `{{ menu }}` with no
          // "distribution" option makes.
          optionItemStyle(
            requireActiveSegment(activeSegment, "{{ picker }}"),
            placedBy(undefined),
            runtime,
            apply.paletteOf,
            activeSegment.drawnAt(),
          ),
        );
        return line!;
      },
      argTypes: ["string", "string", "bool"],
      arity: { kind: "variadic" },
      returnType: "T",
    },
  };
}
