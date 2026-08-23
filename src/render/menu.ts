// [LAW:locality-or-seam] The runtime half of the `{{ menu }}` seam — sibling to
// `{{ action }}`/`{{ picker }}`. A menu is a self-contained disclosure: an inline
// glyph that toggles open/closed, and (when open) its body — a picker grid —
// that DROPS onto the line(s) below the enclosing row. The body is the one picker
// renderer (`renderPicker`); the glyph is a coupled set-state the menu composes
// directly (like the picker's closeOnPick) — it toggles the open-state AND resets
// the page cursor in one atomic batch, gated by the synthesized cycle action.
//
// [LAW:effects-at-boundaries] The helper is a PURE function of its inputs (the
// walk-published placement + the live store): it computes the inline glyph and,
// when open, the body, and RETURNS them together — the glyph as the fragment, the
// body carried as out-of-band metadata on that returned RichText (a symbol the
// segment boundary reads). It mutates no shared sink; the EFFECT of placing the
// body below the row is performed at the boundary (collectMenuDrops + the segment
// walk). Pure core returns a description; the edge performs it.
//
// [LAW:decomposition] The glyph and the body travel on SEPARATE channels: the
// glyph is the visible fragment, the body rides as metadata invisible to the
// inline render. This is the fix for the old `\n`-in-the-stream representation —
// the body never enters the visible inline text, so a menu may sit ANYWHERE in a
// template (content after it stays inline on row 0), and a segment may contain
// ANY NUMBER of menus (each returned glyph carries its own body).
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
// The body metadata is a list whose length carries open/closed (1 open, 0 closed).

import type { RichText } from "@promptctl/rich-js";
import type { FuncMap } from "@promptctl/go-template-js";
import {
  menuMember,
  menuPageKey,
  menuStateKey,
  parseMenuOptions,
  type MenuOptions,
} from "../config/menu-keys.js";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_GLYPH_CLOSED,
  DISCLOSURE_GLYPH_OPEN,
} from "../config/disclosure.js";
import { effectsUrl, VERB_SET_STATE } from "../click/wire.js";
import { linkFragment, readVar, type ActionRuntime } from "./action.js";
import { renderPicker } from "./picker.js";
import type { ActiveSegmentRef } from "./active-segment.js";

// [LAW:one-type-per-behavior] A `{{ menu }}` needs one structural fact it cannot
// see about itself — the name of the segment it renders inside. That used to be
// its own `MenuPlacement` type; it is now a field on the ONE active-segment
// record the walk publishes (see render/active-segment.ts), because "which
// segment is rendering" is a single fact and a per-feature copy of it is a
// second clock. The menu reads `segName` and ignores the rest.

// [LAW:locality-or-seam] The runtime the `menu` func closes over. It shares the
// ACTION runtime (the menu's glyph and body resolve their actions/state from the
// same compiled table + store as every other helper) and READS the walk-published
// active segment — both inputs, never written by the helper. The record is
// mutated only by the single owner (the render walk, around each segment eval) —
// the spatial cousin of the hue cursor, one mutator, never ambient.
// [LAW:no-ambient-temporal-coupling]
export interface MenuRuntime {
  readonly action: ActionRuntime;
  // [LAW:one-source-of-truth] The menu does not publish its own "which segment
  // is current" pointer — it reads the ONE record the render walk publishes for
  // every segment-scoped feature (the palette `{{ color }}` resolves against and
  // the background `{{ bgOf }}` returns ride the same record). A second pointer
  // would be a second clock for the same fact.
  readonly activeSegment: ActiveSegmentRef;
}

// [LAW:effects-at-boundaries] The body a `{{ menu }}` drops below its row rides as
// out-of-band metadata on the returned glyph (a symbol the boundary reads), so the
// helper returns a description rather than mutating a shared sink. A list whose
// length carries open/closed — `[body]` open, `[]` closed.
const MENU_DROP = Symbol("cc-candybar.menuDrop");
type GlyphWithDrop = RichText & { [MENU_DROP]?: readonly RichText[] };

// [LAW:single-enforcer] THE reader of the drop metadata, used by the segment
// boundary (injected by the driver — node-registry never imports this module).
// Scans a segment's evaluated fragments in template order and returns every menu
// body carried on them; a fragment with no metadata contributes nothing.
export function collectMenuDrops(
  fragments: readonly RichText[],
): readonly RichText[] {
  return fragments.flatMap((f) => (f as GlyphWithDrop)[MENU_DROP] ?? []);
}

// Realize a `{{ menu }}` against the live placement + state: return its inline
// glyph, carrying the (open) body as out-of-band metadata for the boundary.
function renderMenu(
  applyName: string,
  options: MenuOptions,
  runtime: MenuRuntime,
): RichText {
  const placement = runtime.activeSegment.current;
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
  // [LAW:one-source-of-truth] Identity — and the page-cursor key derived from it
  // — comes from the SAME menu-keys derivation the loader synthesis used, so the
  // key this render reads/writes is the key whose state var + int gate the
  // loader emitted. No page-action argument to mis-wire.
  const stateKey = menuStateKey(placement.segName, applyName, options.key);
  const pageKey = menuPageKey(stateKey);
  const member = menuMember(applyName);

  // [LAW:dataflow-not-control-flow] Open ⇔ the state key holds this menu's member.
  // A foreign value (an accordion sibling's member under a shared key) reads as
  // closed here — exactly the binary [closed, member] cycle the synthesized action
  // gates. This ONE read drives both the glyph and the body, so what the glyph
  // promises and what drops below cannot disagree.
  const open = readVar(action.store, stateKey) === member;

  // [LAW:one-source-of-truth] / [LAW:locality-or-seam] The disclosure click is ONE
  // atomic set-state that keeps the two split keys coherent: it toggles the open-
  // state (the binary cycle — successor is closed when open, the member when
  // closed) AND resets the page cursor to page 0, in one batch. So a reopened menu
  // is never stranded on a stale page left by ←/→ before the last close. This
  // mirrors the picker's closeOnPick page-reset fold: the picker builds its set-
  // state URLs directly (not via renderAction) so it can couple two writes; the
  // menu — the one part that knows BOTH the open-state key and the page key
  // [LAW:decomposition] — does the same. The synthesized cycle action stays the
  // GATE source (deriveActionValidators); both keys are independently gated, so the
  // coupled batch passes the same wire gate every click does [LAW:single-enforcer].
  const sessionId = readVar(action.store, "session.id");
  const successor = open ? DISCLOSURE_CLOSED : member;
  const glyph = linkFragment(
    open ? DISCLOSURE_GLYPH_OPEN : DISCLOSURE_GLYPH_CLOSED,
    effectsUrl([
      {
        verb: VERB_SET_STATE,
        args: [sessionId, stateKey, successor, pageKey, "0"],
      },
    ]),
    false,
  ) as GlyphWithDrop;

  // [LAW:effects-at-boundaries] The body is a VALUE whose length carries open/
  // closed — `[body]` open, `[]` closed — attached to the glyph the helper returns.
  // No shared mutation: the boundary reads this metadata to place the body.
  // (renderPicker is pure, so it is only built when open — skipping wasted
  // computation, gating no effect.)
  // [LAW:one-source-of-truth] The body's page cursor is the identity-derived
  // key (its synthesized state var is named by it, the disclosure-var
  // convention), and CLOSING — the ✕ affordance or a closeOnPick pick — writes
  // the disclosure back to the closed sentinel and resets the page, the same
  // coupled pair the toggle glyph above writes. What the ▾ promised, ✕ delivers.
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
        ),
      ]
    : [];
  return glyph;
}

// [LAW:dataflow-not-control-flow] One func; the apply-action NAME is the menu's
// whole identity (the page cursor is derived from it, not passed), and the rare
// knobs travel as ONE optional trailing `(dict …)` — closeOnPick (default
// false: stay-open), paged (default true: a drop menu wants bounded height),
// key (accordion grouping: omitted ⇒ independent, present ⇒ mutually exclusive
// with siblings sharing it). Values, not modes. The loader gates the same dict
// statically (staticDictEntries), so an old positional tail never reaches this
// fn — it is a migration-pointing load error.
//
// [LAW:one-way-deps] Injected into the engine by registerDslConfig as data; the
// generic engine never imports this module.
export function menuFuncs(runtime: MenuRuntime): FuncMap {
  return {
    menu: {
      fn: (applyName: string, opts?: Record<string, unknown>) =>
        // [LAW:one-source-of-truth] The same option reader the loader folds
        // over the static dict — vocabulary, types, defaults live once.
        renderMenu(applyName, parseMenuOptions(opts ?? {}), runtime),
      argTypes: ["string", "dict"],
      returnType: "T",
    },
  };
}
