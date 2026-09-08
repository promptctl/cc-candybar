// [LAW:locality-or-seam] Pure render: no state, no gate, only already-gated names.
// [LAW:one-type-per-behavior] There is no picker TYPE — it is template content.
// [LAW:dataflow-not-control-flow] Paged vs wrap is ONE value (the available width).
// [LAW:one-way-deps] Injected as data; the generic engine never imports this.

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
import { placedBy, type Position } from "../themes/decor.js";

// [LAW:locality-or-seam] The picker knows only a `position`; the caller completes it.
export type ItemStyle = (position: Position) => Style;

const PICKER_PREV = "←";
const PICKER_NEXT = "→";

// [LAW:single-enforcer] The same measure FlexStrip wraps by, so pagination fits.
function cellWidth(text: string): number {
  return new RichText(text).cellLength;
}

// [LAW:dataflow-not-control-flow] Greedy fill; infinite width is the wrap case.
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

// [LAW:dataflow-not-control-flow] One expression emits ONE RichText; cells are spans.
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

// [LAW:types-are-the-program] One value shape, two provenances, one renderer.
export interface PickerPage {
  readonly key: string;
  readonly stateVar: string;
}

// [LAW:dataflow-not-control-flow] What a close WRITES, as data, so this never branches.
export type CloseWrites = ReadonlyArray<readonly [key: string, value: string]>;

// [LAW:no-defensive-null-guards] A wrong KIND is loud, not a silent empty picker.
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

// [LAW:one-source-of-truth] All three kinds share one gate; realize() owns the write.
function requireOptionKind(
  runtime: ActionRuntime,
  name: string,
): Extract<
  CompiledActionDecl,
  { kind: "set-option" | "persist-option" | "layout-op-option" }
> {
  // [LAW:dataflow-not-control-flow] A dual resolves to its live half BEFORE this.
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

// [LAW:dataflow-not-control-flow] A boundary arrow is an ABSENT fragment.
// [LAW:single-enforcer] Exported so `{{ menu }}` bodies render through this grid.
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
  // [LAW:one-source-of-truth] The CLICK is realized from the declaration itself.
  const declared = runtime.compiled.get(applyName)!;
  const store = runtime.store;
  const sessionId = readVar(store, "session.id");
  // [LAW:no-defensive-null-guards] A one-shot trigger has no current selection.
  const current =
    "stateVar" in apply ? readVar(store, apply.stateVar) : undefined;
  const widths = apply.options.map(cellWidth);

  // Reserving arrow space unconditionally is self-fulfilling: it waits on overflow.
  // [LAW:locality-or-seam] End-caps and pad spaces are painted OUTSIDE term.cols.
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

  // [LAW:no-defensive-null-guards] The key may genuinely never have been written.
  const rawPage = parseInt(readVar(store, page.stateVar), 10);
  const pageIdx = Number.isInteger(rawPage)
    ? Math.max(0, Math.min(rawPage, pages.length - 1))
    : 0;
  const pageCells = pages[pageIdx] ?? [];

  const pageUrl = (value: number): string =>
    effectsUrl([
      { verb: VERB_SET_STATE, args: [sessionId, page.key, String(value)] },
    ]);
  // [LAW:dataflow-not-control-flow] One atomic set-state either way.
  const closeFlat = close.flatMap(([k, v]) => [k, v]);
  const closeUrl = effectsUrl([
    { verb: VERB_SET_STATE, args: [sessionId, ...closeFlat] },
  ]);
  // [LAW:one-source-of-truth] setState is variadic; setConfig/apply-layout-op take
  // one pair each, so their close rides as a second effect in the same dispatch.
  const closeEffect = closeOnPick
    ? [{ verb: VERB_SET_STATE, args: [sessionId, ...closeFlat] }]
    : [];
  const optionUrl = (option: string): string => {
    const { effects } = realize(declared, option, option, store, sessionId);
    // [LAW:one-source-of-truth] Every other shape already takes >1 effect.
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
  // [LAW:dataflow-not-control-flow] Placed by index in the WHOLE option domain.
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

// [LAW:dataflow-not-control-flow] The action NAMES select which effects fire.
// [LAW:no-mode-explosion] Both bools are OPTIONAL trailing values: an omitted one
// arrives `undefined` and defaults here rather than raising an arity error.
// [LAW:one-way-deps] Injected as a FuncMap; the engine never imports the picker.
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
        // [LAW:one-source-of-truth] Closing means paging to -1, the idiom the
        // host row gates on.
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
          // A bare `{{ picker }}` authors no options dict, so it places by default.
          (position) =>
            bandItemStyle(requireActiveSegment(activeSegment, "{{ picker }}"), {
              ...position,
              distribution: placedBy(undefined),
            }),
        );
      },
      argTypes: ["string", "string", "bool", "bool"],
      returnType: "T",
    },
  };
}
