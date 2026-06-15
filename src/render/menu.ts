// [LAW:locality-or-seam] The runtime half of the `{{ menu }}` seam — sibling to
// `{{ action }}`/`{{ picker }}`. A menu is a self-contained disclosure: an inline
// glyph that toggles open/closed, and (when open) its body — a picker grid —
// dropped onto the next line. It composes the two existing helpers, adding only
// the disclosure: the glyph is realized through the synthesized cycle action
// (`renderAction`), the body through the one picker renderer (`renderPicker`).
//
// [LAW:one-source-of-truth] A menu is CONTEXT-FREE in the template but its
// accordion identity (which row key, which member name) is a fact about WHERE its
// host segment sits — derived once in menu-keys and published into this runtime
// by the render walk before each segment's template evaluates. The helper reads
// that placement; it never invents a key from its own argument string, so the
// rendered toggle and the loader-synthesized state var + gate share one source.
//
// [LAW:dataflow-not-control-flow] Openness is the value of the row key, not a
// when-gated reveal: open ⇔ the row key holds THIS menu's member name. Open is a
// length-1 drop appended after a "\n"; closed is just the glyph. One expression,
// one returned RichText (the "\n" splits into a dropped line downstream).

import { RichText } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import {
  MENU_GLYPH_CLOSED,
  MENU_GLYPH_OPEN,
  menuActionName,
  menuStateKey,
} from "../config/menu-keys.js";
import { readVar, renderAction, type ActionRuntime } from "./action.js";
import { renderPicker } from "./picker.js";

// [LAW:types-are-the-program] One menu placement: the structural facts a context-
// free `{{ menu }}` cannot see about itself. Published by the walk per segment
// render; the helper reads the live value.
export interface MenuPlacement {
  readonly rowKey: string;
  readonly segName: string;
}

// [LAW:locality-or-seam] The runtime the `menu` func closes over. It shares the
// ACTION runtime (the menu's glyph and body resolve their actions/state from the
// same compiled table + store as every other helper) and reads the walk-published
// current placement. `current` is mutated by the single owner (the render walk,
// set immediately before each segment template eval) — the spatial cousin of the
// hue cursor, one mutator, never ambient. [LAW:no-ambient-temporal-coupling]
export interface MenuRuntime {
  readonly action: ActionRuntime;
  current: MenuPlacement | null;
}

// Realize a `{{ menu }}` against the live placement + state into ONE RichText.
function renderMenu(
  applyName: string,
  pageName: string,
  closeOnPick: boolean,
  paged: boolean,
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
  const { rowKey, segName } = placement;
  const action = runtime.action;

  // [LAW:single-enforcer] The disclosure glyph IS the synthesized cycle action —
  // displays bound one-per-member (closed ▸ / open ▾), the current member's glyph
  // renders, the click writes the successor. Same toggle as group sugar.
  const glyph = renderAction(
    menuActionName(rowKey, segName),
    [MENU_GLYPH_CLOSED, MENU_GLYPH_OPEN],
    action,
  );

  // [LAW:dataflow-not-control-flow] Open ⇔ the row key holds this menu's member.
  // Closed ⇒ just the glyph; open ⇒ glyph + "\n" + body. The "\n" is the sole
  // vertical sentinel (splitCellsIntoLines drops the body below the row).
  const open = readVar(action.store, menuStateKey(rowKey)) === segName;
  if (!open) return glyph;

  const body = renderPicker(applyName, pageName, closeOnPick, paged, action);
  const combined = RichText.fromFragments([glyph, new RichText("\n"), body]);
  combined.end = "";
  return combined;
}

// [LAW:dataflow-not-control-flow] One func; the two action NAMES select the
// body's apply/page effects, the two optional bools are the bounded author
// choices (closeOnPick, paged) — identical surface to `{{ picker }}`, since the
// body IS a picker. The disclosure takes no argument: its identity is derived
// from placement, never authored.
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
      ) =>
        renderMenu(
          applyName,
          pageName,
          closeOnPick === true,
          paged === true,
          runtime,
        ),
      argTypes: ["string", "string", "bool", "bool"],
      returnType: "T",
    },
  };
}
