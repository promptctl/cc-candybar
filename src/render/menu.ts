// [LAW:locality-or-seam] The runtime half of the `{{ menu }}` seam — sibling to
// `{{ action }}`/`{{ picker }}`. A menu is a self-contained disclosure: an inline
// glyph that toggles open/closed, and (when open) its body — a picker grid —
// that DROPS onto the line(s) below the enclosing row. It composes the two
// existing helpers, adding only the disclosure: the glyph is realized through the
// synthesized cycle action (`renderAction`), the body through the one picker
// renderer (`renderPicker`).
//
// [LAW:decomposition] The glyph and the body travel on SEPARATE channels. The
// helper RETURNS only the inline glyph, and CONTRIBUTES the open body to the
// walk-owned per-segment drop sink. The segment boundary stacks the sink's blocks
// below the row. This is the fix for the old `\n`-in-the-stream representation:
// because the body never enters the inline text stream, a menu may sit ANYWHERE
// in a segment template (content after it stays inline on row 0), and a segment
// may contain ANY NUMBER of menus (each contributes its own drop block).
//
// [LAW:one-source-of-truth] A menu is CONTEXT-FREE about its NAME in the template
// (it cannot see the segment it sits in), so the host segment name is published
// into this runtime by the render walk before each segment's template evaluates.
// The helper combines that segment name with its own apply-action arg (and an
// optional shared key) to derive identity via menu-keys — the SAME derivation the
// loader synthesis uses — so the rendered toggle and the loader-synthesized state
// var + gate share one source.
//
// [LAW:dataflow-not-control-flow] Openness is the value of the menu's state key,
// not a when-gated reveal: open ⇔ the state key holds THIS menu's member name.
// Open contributes one drop block; closed contributes none. One expression, one
// returned RichText (the glyph); the body rides the side channel.

import type { RichText } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import {
  MENU_GLYPH_CLOSED,
  MENU_GLYPH_OPEN,
  menuActionName,
  menuMember,
  menuStateKey,
} from "../config/menu-keys.js";
import { readVar, renderAction, type ActionRuntime } from "./action.js";
import { renderPicker } from "./picker.js";

// [LAW:types-are-the-program] One menu placement: the structural fact a context-
// free `{{ menu }}` cannot see about itself — the name of the segment it renders
// inside. Published by the walk per segment render; the helper reads the live
// value to derive identity.
export interface MenuPlacement {
  readonly segName: string;
}

// [LAW:locality-or-seam] The runtime the `menu` func closes over. It shares the
// ACTION runtime (the menu's glyph and body resolve their actions/state from the
// same compiled table + store as every other helper), reads the walk-published
// current placement, and pushes open bodies to `drops`. Both `current` and
// `drops` are mutated by the single owner (the render walk: it sets `current` and
// clears `drops` immediately before each segment template eval, then reads
// `drops` after) — the spatial cousin of the hue cursor, one mutator, never
// ambient. [LAW:no-ambient-temporal-coupling]
export interface MenuRuntime {
  readonly action: ActionRuntime;
  current: MenuPlacement | null;
  // The open menu bodies contributed by the segment currently evaluating, in
  // template order. The walk clears this before each segment and stacks whatever
  // it holds below the segment's inline row.
  drops: RichText[];
}

// Realize a `{{ menu }}` against the live placement + state: return its inline
// glyph and, when open, push its body to the drop sink.
function renderMenu(
  applyName: string,
  pageName: string,
  closeOnPick: boolean,
  paged: boolean,
  sharedKey: string | undefined,
  runtime: MenuRuntime,
): RichText {
  const placement = runtime.current;
  // [LAW:no-defensive-null-guards] The walk publishes a placement before every
  // segment template evaluates; a `{{ menu }}` only renders inside a segment. A
  // null here is a wiring bug (the func fired with no current segment), surfaced
  // loudly rather than rendering a placeless menu.
  if (placement === null) {
    throw new Error(
      "{{ menu }} rendered with no active segment placement — the render walk must publish one before evaluating a segment template",
    );
  }
  const action = runtime.action;
  const stateKey = menuStateKey(placement.segName, applyName, sharedKey);
  const member = menuMember(applyName);

  // [LAW:single-enforcer] The disclosure glyph IS the synthesized cycle action —
  // displays bound one-per-member (closed ▸ / open ▾), the current member's glyph
  // renders, the click writes the successor. Same toggle as group sugar.
  const glyph = renderAction(
    menuActionName(stateKey, member),
    [MENU_GLYPH_CLOSED, MENU_GLYPH_OPEN],
    action,
  );

  // [LAW:dataflow-not-control-flow] Open ⇔ the state key holds this menu's member.
  // The drop contribution is a VALUE whose length carries open/closed — closed ⇒
  // an empty list, open ⇒ one body — and the push is UNCONDITIONAL: the effect
  // always runs, only the list it appends varies. (renderPicker is pure, so it is
  // only built when open — that skips wasted computation, it does not gate the
  // effect.) The segment boundary places whatever was appended below the row.
  const open = readVar(action.store, stateKey) === member;
  const bodyLines = open
    ? [renderPicker(applyName, pageName, closeOnPick, paged, action)]
    : [];
  runtime.drops.push(...bodyLines);
  return glyph;
}

// [LAW:dataflow-not-control-flow] One func; the two action NAMES select the
// body's apply/page effects, the two optional bools are the bounded author
// choices (closeOnPick, paged) — identical to `{{ picker }}`, since the body IS a
// picker — and the optional trailing key is the accordion grouping: omitted ⇒ the
// menu is independent (its own key), present ⇒ it shares that key with siblings
// (mutually exclusive). One value, not a mode.
//
// [LAW:one-way-deps] Injected into the engine by registerDslConfig as data; the
// generic engine never imports this module.
export function menuFuncs(runtime: MenuRuntime): FuncMap {
  return {
    menu: {
      fn: (
        applyName: string,
        pageName: string,
        closeOnPick?: boolean,
        paged?: boolean,
        key?: string,
      ) =>
        renderMenu(
          applyName,
          pageName,
          closeOnPick === true,
          paged === true,
          key,
          runtime,
        ),
      argTypes: ["string", "string", "bool", "bool", "string"],
      returnType: "T",
    },
  };
}
