// [LAW:locality-or-seam] The `{{ menu }}` seam's runtime half: an inline TRIGGER,
// and a body — the one picker renderer — dropped below the row. [LAW:decomposition]
// Glyph and body ride SEPARATE channels, so a menu may sit anywhere in a template.

import type { RichText } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import {
  menuMember,
  menuPageKey,
  menuStateKey,
  parseMenuOptions,
  type MenuOptions,
} from "../config/menu-keys.js";
import { DISCLOSURE_CLOSED, pickCycleDisplay } from "../config/disclosure.js";
import { effectsUrl, VERB_SET_STATE } from "../click/wire.js";
import { linkFragment, readVar, type ActionRuntime } from "./action.js";
import { renderPicker } from "./picker.js";
import { bandItemStyle } from "./band-style.js";
import type { ActiveSegmentRef } from "./active-segment.js";

// [LAW:one-source-of-truth] Both fields are INPUTS, mutated only by the render
// walk [LAW:no-ambient-temporal-coupling]: the menu keeps no pointer of its own.
export interface MenuRuntime {
  readonly action: ActionRuntime;
  readonly activeSegment: ActiveSegmentRef;
}

// [LAW:effects-at-boundaries] The body rides as out-of-band metadata on the
// returned glyph — a list whose length carries open/closed — never a shared sink.
const MENU_DROP = Symbol("cc-candybar.menuDrop");
type GlyphWithDrop = RichText & { [MENU_DROP]?: readonly RichText[] };

// [LAW:single-enforcer] THE reader of the drop metadata, injected into the boundary.
export function collectMenuDrops(
  fragments: readonly RichText[],
): readonly RichText[] {
  return fragments.flatMap((f) => (f as GlyphWithDrop)[MENU_DROP] ?? []);
}

function renderMenu(
  applyName: string,
  displays: readonly string[],
  options: MenuOptions,
  runtime: MenuRuntime,
): RichText {
  const placement = runtime.activeSegment.current;
  // [LAW:no-defensive-null-guards] A null here is a wiring bug, surfaced loudly.
  if (placement === null) {
    throw new Error(
      "{{ menu }} rendered with no active segment placement — the render walk must publish one before evaluating a segment template",
    );
  }
  const action = runtime.action;
  // [LAW:one-source-of-truth] The SAME menu-keys derivation the loader synthesis
  // used, so this render reads the key whose state var + gate the loader emitted.
  const stateKey = menuStateKey(placement.segName, applyName, options.key);
  const pageKey = menuPageKey(stateKey);
  const member = menuMember(applyName);

  // [LAW:dataflow-not-control-flow] Open ⇔ the key holds THIS menu's member, so an
  // accordion sibling reads closed. One read drives glyph and body alike.
  const open = readVar(action.store, stateKey) === member;

  // [LAW:single-enforcer] ONE atomic set-state toggles the open-state AND resets
  // the page cursor, so a reopened menu is never stranded on a stale page.
  const sessionId = readVar(action.store, "session.id");
  const successor = open ? DISCLOSURE_CLOSED : member;
  // [LAW:one-source-of-truth] The trigger's text is AUTHORED, through the one
  // display rule a cycle `{{ action }}` uses; nothing is appended here.
  const glyph = linkFragment(
    pickCycleDisplay(`{{ menu "${applyName}" }}`, displays, 2, open ? 1 : 0),
    effectsUrl([
      {
        verb: VERB_SET_STATE,
        args: [sessionId, stateKey, successor, pageKey, "0"],
      },
    ]),
    false,
  ) as GlyphWithDrop;

  // [LAW:one-source-of-truth] Closing — the ✕ affordance or a closeOnPick pick —
  // writes the same coupled pair the toggle glyph above writes.
  glyph[MENU_DROP] = open
    ? [
        renderPicker(
          applyName,
          { key: pageKey, stateVar: pageKey },
          [
            [stateKey, DISCLOSURE_CLOSED],
            [pageKey, "0"],
          ],
          options.closeOnPick,
          options.paged,
          action,
          // [LAW:one-source-of-truth] The picker knows positions, the instance
          // how it places them.
          (position) =>
            bandItemStyle(placement, {
              ...position,
              distribution: options.distribution,
            }),
        ),
      ]
    : [];
  return glyph;
}

// [LAW:parse-dont-validate] THE crossing for the argument tail: no engine slot type
// admits both strings and a dict, so opaque values arrive and a record leaves.
interface MenuArgs {
  readonly displays: readonly string[];
  readonly options: MenuOptions;
}
// [LAW:one-source-of-truth] This splits the tail on VALUES, the loader on EXPRS;
// they agree because the loader rejects any call site where both readings are legal.
const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseMenuArgs(applyName: string, tail: readonly unknown[]): MenuArgs {
  const last = tail[tail.length - 1];
  const optsArg = isDict(last) ? last : undefined;
  const displayArgs = optsArg === undefined ? tail : tail.slice(0, -1);
  const bad = displayArgs.findIndex((d) => typeof d !== "string");
  if (bad !== -1) {
    throw new Error(
      `{{ menu "${applyName}" }} display #${bad + 1} is not text (${JSON.stringify(displayArgs[bad])}) — a menu binds its trigger text, then an optional trailing (dict …) of options`,
    );
  }
  return {
    displays: displayArgs as readonly string[],
    // [LAW:one-source-of-truth] The same option reader the loader folds over.
    options: parseMenuOptions(optsArg ?? {}),
  };
}

// [LAW:dataflow-not-control-flow] The apply-action NAME is the menu's whole
// identity; the knobs travel as ONE optional trailing `(dict …)`. Values, not modes.
// [LAW:one-way-deps] Injected as data; the generic engine never imports this module.
export function menuFuncs(runtime: MenuRuntime): FuncMap {
  return {
    menu: {
      fn: (applyName: string, ...tail: unknown[]) => {
        const { displays, options } = parseMenuArgs(applyName, tail);
        return renderMenu(applyName, displays, options, runtime);
      },
      argTypes: ["string", "value"],
      returnType: "T",
    },
  };
}
