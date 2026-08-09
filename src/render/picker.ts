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
import type { FuncMap } from "@promptctl/go-template-js";
import { toNumber } from "../var-system/types.js";
import { stripChromeCols } from "./strip.js";
import { TERM_COLS_VAR } from "../config/dsl-types.js";
import { effectsUrl, VERB_SET_CONFIG, VERB_SET_STATE } from "../click/wire.js";
import {
  linkFragment,
  readVar,
  type ActionRuntime,
  type CompiledActionDecl,
} from "./action.js";

const PICKER_CLOSE = "✕";
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

// [LAW:one-source-of-truth] The apply action a picker grid binds to is EITHER
// of set-option's two durability twins (src/render/action.ts's persist-*
// mirrors set-*'s shapes one for one) — a picker over `persist("charset",
// from:"charsets")` is exactly as legal as one over `set("theme",
// from:"themes")`, differing only in which wire verb the option click emits
// (VERB_SET_CONFIG vs VERB_SET_STATE), never in shape (both carry key,
// stateVar, options). Rejecting persist-option here would be an artificial
// gap: the same option-domain gate (deriveActionValidators) covers both kinds
// identically, so there is nothing about "picker" that's set-only.
function requireOptionKind(
  runtime: ActionRuntime,
  name: string,
): Extract<CompiledActionDecl, { kind: "set-option" | "persist-option" }> {
  const action = runtime.compiled.get(name);
  if (
    !action ||
    (action.kind !== "set-option" && action.kind !== "persist-option")
  ) {
    throw new Error(
      `picker references action "${name}" which must be a set-option or persist-option action ({ set, from } or { persist, from }), got ${action ? `a ${action.kind} action` : "no such action"}`,
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
): RichText {
  const apply = requireOptionKind(runtime, applyName);
  const store = runtime.store;
  const sessionId = readVar(store, "session.id");
  const current = readVar(store, apply.stateVar);
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
  const closeReserve = cellWidth(PICKER_CLOSE) + 1;
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
  // into ONE set-state batch (setState is variadic — see daemon/verbs). A
  // persist-option apply cannot: setConfig takes exactly one (key, value), so
  // its close pairs (always SessionState — open/page live there regardless of
  // the apply's durability) ride as a SECOND effect in the same dispatch,
  // still one atomic click via effectsUrl's array.
  const optionUrl = (option: string): string =>
    apply.kind === "persist-option"
      ? effectsUrl([
          { verb: VERB_SET_CONFIG, args: [sessionId, apply.key, option] },
          ...(closeOnPick
            ? [{ verb: VERB_SET_STATE, args: [sessionId, ...closeFlat] }]
            : []),
        ])
      : effectsUrl([
          {
            verb: VERB_SET_STATE,
            args: [
              sessionId,
              apply.key,
              option,
              ...(closeOnPick ? closeFlat : []),
            ],
          },
        ]);

  const frags: RichText[] = [linkFragment(PICKER_CLOSE, closeUrl, false)];
  if (pageIdx > 0) {
    frags.push(linkFragment(PICKER_PREV, pageUrl(pageIdx - 1), false));
  }
  for (const i of pageCells) {
    const option = apply.options[i]!;
    frags.push(linkFragment(option, optionUrl(option), option === current));
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
export function pickerFuncs(runtime: ActionRuntime): FuncMap {
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
        );
      },
      argTypes: ["string", "string", "bool", "bool"],
      returnType: "T",
    },
  };
}
