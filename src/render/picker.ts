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
// (and the matching noWrap) select the shape.
//
// [LAW:one-way-deps] Lives in render/ (depends on template-engine/ + ./action.js),
// injected into the engine by the caller (registerDslConfig hands pickerFuncs in
// as data). The generic engine never imports this module.

import { RichText } from "@promptctl/rich-js";
import type { Style } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import { toNumber } from "../var-system/types.js";
import { stripChromeCols } from "./strip.js";
import { TERM_COLS_VAR } from "../config/dsl-types.js";
import { effectsUrl, VERB_SET_STATE } from "../click/wire.js";
import {
  activeDestination,
  linkFragment,
  realize,
  readVar,
  type ActionRuntime,
  type CompiledActionDecl,
} from "./action.js";
import { DISCLOSURE_GLYPH_CLOSE } from "../config/disclosure.js";
import { bandItemStyle } from "./band-style.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";
import type { AddressStep } from "../themes/decor.js";

// [LAW:locality-or-seam] How an option cell is coloured, as a VALUE the caller
// hands in: the picker places item `step` (which option, of how many) and
// knows nothing of bands, hues or depth. Both callers supply the band of the
// segment the picker renders inside (`bandItemStyle`), so a menu body and a
// standalone `{{ picker }}` colour their items by one rule.
export type ItemStyle = (step: AddressStep) => Style;

const PICKER_PREV = "←";
const PICKER_NEXT = "→";

// [LAW:single-enforcer] One display-width measure — rich-js's cellLength, the
// same algebra FlexStrip wraps by — so pagination fits the line the strip
// produces. No second width function.
function cellWidth(text: string): number {
  return new RichText(text).cellLength;
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

// [LAW:dataflow-not-control-flow] Join link-bearing spans with single-space
// separators into ONE RichText (a picker is one `{{ picker }}` expression, so it
// must emit one value; the option/affordance cells ride as spans on it). `noWrap`
// is the `paged` value: a paged page is one line that must not wrap; a wrap-mode
// run is the long line FlexStrip is ALLOWED to break across lines.
function assemble(frags: readonly RichText[], paged: boolean): RichText {
  const spaced: RichText[] = [];
  for (const frag of frags) {
    if (spaced.length > 0) spaced.push(new RichText(" "));
    spaced.push(frag);
  }
  const assembled = RichText.fromFragments(spaced);
  assembled.noWrap = paged;
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
function requireOptionKind(
  runtime: ActionRuntime,
  name: string,
): Extract<
  CompiledActionDecl,
  { kind: "set-option" | "persist-option" | "layout-op-option" }
> {
  // [LAW:dataflow-not-control-flow] A dual-destination action resolves to the
  // half its selector names BEFORE the kind check, so a picker over a dual is
  // a picker over whichever option kind is live — the grid, its current-mark,
  // and its close folding are the code they already were. The check below then
  // still names a real, single-destination kind in its error.
  const declared = runtime.compiled.get(name);
  const action = declared
    ? activeDestination(declared, runtime.store)
    : declared;
  if (
    !action ||
    (action.kind !== "set-option" &&
      action.kind !== "persist-option" &&
      action.kind !== "layout-op-option")
  ) {
    throw new Error(
      `picker references action "${name}" which must be a set-option, persist-option, or layout-op-option action ({ set, from }, { persist, from }, or { persist, insertSegmentFrom, anchor, relation }), got ${action ? `a ${action.kind} action` : "no such action"}`,
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
): RichText {
  const apply = requireOptionKind(runtime, applyName);
  // [LAW:one-source-of-truth] The GRID reads the resolved half above (its
  // options, its current-mark); the CLICK is realized from the declaration
  // itself, through the same fold `{{ action }}` uses. That is what carries a
  // dual's session clear into a picked option — the picker never learns what a
  // dual is, and there is no second projection of "what does this option
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
  const widths = apply.options.map(cellWidth);

  // ✕ is always present; ←/→ appear only on a multi-page menu. Reserve arrow
  // space only after a first pass proves it overflows — reserving it
  // unconditionally is self-fulfilling (a run that fits with just ✕ could be
  // forced to split, making arrows appear unnecessarily). In wrap mode
  // (available = Infinity) paginate yields one page, so neither pass splits.
  //
  // [LAW:locality-or-seam] term.cols is the raw usable width the strip wraps to;
  // the picker's row is itself a styled strip segment, so the joiner brackets it
  // with end-caps (powerline's trailing separator, capsule's two caps) painted
  // OUTSIDE that width. A page packed to the full term.cols is pushed past it by
  // the caps — the maximally-packed middle pages overflowed and the terminal ate
  // the trailing → (page 0 fit, page N did not). Reserve the chrome HERE, at the
  // pagination seam, rather than shrinking the shared term.cols every template
  // reads. stripChromeCols owns the per-style geometry; Infinity − chrome stays
  // Infinity, so wrap mode is unaffected.
  // The pad spaces the segment layout synthesizes around the picker's line
  // (2 × the render's intra-cell padding) consume the same width budget the
  // joiner chrome does — reserve both here, at the pagination seam.
  const available = paged
    ? Math.max(
        1,
        toNumber(store.read(TERM_COLS_VAR)) -
          stripChromeCols(runtime.stripStyle) -
          2 * runtime.padding,
      )
    : Infinity;
  const closeReserve = cellWidth(DISCLOSURE_GLYPH_CLOSE) + 1;
  const arrowReserve = cellWidth(PICKER_PREV) + 1 + cellWidth(PICKER_NEXT) + 1;
  const firstPass = paginate(widths, available, closeReserve);
  const pages =
    firstPass.length > 1
      ? paginate(widths, available, closeReserve + arrowReserve)
      : firstPass;

  // [LAW:no-defensive-null-guards] The page value genuinely may be absent/empty
  // (the key was never written) — parse it at this trust boundary; an out-of-range
  // or unset value clamps into the existing page set, so the picker never indexes
  // a non-existent page. The segment's `when` gates visibility on page >= 0.
  const rawPage = parseInt(readVar(store, page.stateVar), 10);
  const pageIdx = Number.isInteger(rawPage)
    ? Math.max(0, Math.min(rawPage, pages.length - 1))
    : 0;
  const pageCells = pages[pageIdx] ?? [];

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
  // [LAW:one-source-of-truth] A set-option apply folds its closeOnPick pairs
  // into ONE set-state batch (setState is variadic — see daemon/verbs).
  // persist-option and layout-op-option cannot: setConfig/apply-layout-op
  // each take exactly one (key, value) pair, so their close pairs (always
  // SessionState — open/page live there regardless of the apply's
  // durability) ride as a SECOND effect in the same dispatch, still one
  // atomic click via effectsUrl's array. layout-op-option's "value" is the
  // ENCODED op (segment=option, anchor/relation from the compiled action),
  // not the option verbatim — the one place this kind's write differs from
  // persist-option's.
  const closeEffect = closeOnPick
    ? [{ verb: VERB_SET_STATE, args: [sessionId, ...closeFlat] }]
    : [];
  const optionUrl = (option: string): string => {
    const { effects } = realize(declared, option, option, store, sessionId);
    // [LAW:one-source-of-truth] A plain session pick folds its close pairs into
    // the SAME set-state (setState is variadic), so closing and applying are
    // one write. Every other shape — a durable write, a structural op, a dual
    // carrying its session clear — takes more than one effect already, so its
    // close rides as its own effect in the same atomic dispatch.
    const solo = effects.length === 1 ? effects[0]! : undefined;
    return solo?.verb === VERB_SET_STATE
      ? effectsUrl([
          {
            verb: VERB_SET_STATE,
            args: [...solo.args, ...(closeOnPick ? closeFlat : [])],
          },
        ])
      : effectsUrl([...effects, ...closeEffect]);
  };

  const frags: RichText[] = [
    linkFragment(DISCLOSURE_GLYPH_CLOSE, closeUrl, false),
  ];
  if (pageIdx > 0) {
    frags.push(linkFragment(PICKER_PREV, pageUrl(pageIdx - 1), false));
  }
  // [LAW:dataflow-not-control-flow] An item is placed by its index in the
  // WHOLE option domain, not on its page: paging changes which cells show,
  // never what colour an option is.
  for (const i of pageCells) {
    const option = apply.options[i]!;
    frags.push(
      linkFragment(
        option,
        optionUrl(option),
        option === current,
        itemStyle({ index: i, count: apply.options.length }),
      ),
    );
  }
  if (pageIdx < pages.length - 1) {
    frags.push(linkFragment(PICKER_NEXT, pageUrl(pageIdx + 1), false));
  }
  return assemble(frags, paged);
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
// `paged=true` slices into ←/→ pages at the live width. `enforceArgTypes`
// validates only the values actually passed (it loops over arity), so an omitted
// trailing bool arrives `undefined` and resolves to the default here — no arity
// error, and order is preserved so existing callers (which pass both) are
// untouched. Authoring stay-open + paged is `{{ picker "a" "p" false true }}`.
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
      ) => {
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
        return renderPicker(
          applyName,
          { key: page.key, stateVar: page.stateVar },
          [[page.key, "-1"]],
          closeOnPick === true,
          paged === true,
          runtime,
          (step) =>
            bandItemStyle(requireActiveSegment(activeSegment, "picker"), step),
        );
      },
      argTypes: ["string", "string", "bool", "bool"],
      returnType: "T",
    },
  };
}
