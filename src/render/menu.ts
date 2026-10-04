// [LAW:locality-or-seam] The runtime half of the `{{ menu }}` seam — sibling to
// `{{ action }}`/`{{ picker }}`. A menu is a self-contained disclosure: an inline
// TRIGGER that toggles open/closed, and (when open) its body — a picker grid —
// that DROPS onto the line(s) below the enclosing row. The body is the one picker
// renderer (`renderPicker`); the trigger is a coupled set-state the menu composes
// directly (like the picker's closeOnPick) — it toggles the open-state AND resets
// the page cursor in one atomic batch, gated by the synthesized cycle action.
//
// [LAW:one-source-of-truth] The trigger's TEXT is authored, never emitted here.
// This module used to append ▸/▾ from the glyph constants, while the codebase's
// other disclosure — group sugar — spliced those same constants into the
// template it synthesized, where an author could see and change them. Two
// policies for one fact; the docs sided with the visible one ("the trigger is
// any template content you like") while a menu appended a glyph nobody wrote,
// which is why edit mode's `+` rendered `+▸`. A menu's disclosure IS a
// two-member cycle, so its trigger now binds displays exactly as a cycle
// `{{ action }}` does, through the same `pickCycleDisplay` (candybar-settings-
// ui-aok.4).
//
// [LAW:decomposition] The glyph and the body travel on SEPARATE channels: the
// glyph is the fragment the helper returns, and the body is appended to the
// active-segment record the walk published for this segment, which the walk
// reads when the segment exits and stacks below the row. The body never enters
// the visible inline text, so a menu may sit ANYWHERE in a template (content
// after it stays inline on row 0), under any wrapper (`fg`, `bold`, `link` …
// return a new RichText, and the record is not on it), and a segment may
// contain ANY NUMBER of menus (each appends its own body, in template order).
//
// [LAW:one-source-of-truth] A menu is CONTEXT-FREE about its NAME in the template
// (it cannot see the placement it sits in), so the host placement's id is
// published into this runtime by the render walk before each segment's template
// evaluates. The helper combines that id with its own apply-action arg (and an
// optional shared key) to derive identity via menu-keys — the SAME derivation the
// loader synthesis uses — so the rendered toggle and the loader-synthesized state
// var + gate share one source.
//
// [LAW:dataflow-not-control-flow] Openness is the value of the menu's state key,
// not a when-gated reveal: open ⇔ the state key holds THIS menu's member name.
// A menu appends a list whose length carries open/closed (1 open, 0 closed).

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
import { renderPicker, requireOptionKind } from "./picker.js";
import { closeOn, optionItemStyle } from "./band-style.js";
import { bandFor } from "../themes/decor.js";
import {
  requireActiveSegment,
  type ActiveSegmentRef,
} from "./active-segment.js";

// [LAW:one-type-per-behavior] A `{{ menu }}` needs one structural fact it cannot
// see about itself — the placement it renders inside. That used to be its own
// `MenuPlacement` type; it is now a field on the ONE active-segment record the
// walk publishes (see render/active-segment.ts), because "which placement is
// rendering" is a single fact and a per-feature copy of it is a second clock.
// The menu reads `placementId` and ignores the rest.

// [LAW:locality-or-seam] The runtime the `menu` func closes over. It shares the
// ACTION runtime (the menu's glyph and body resolve their actions/state from the
// same compiled table + store as every other helper) and READS the walk-published
// active segment — both inputs, never written by the helper. The record is
// mutated only by the single owner (the render walk, around each segment eval) —
// one mutator, never ambient.
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

// Realize a `{{ menu }}` against the live placement + state: return its inline
// trigger, and append its (open) body to the segment it renders in.
function renderMenu(
  applyName: string,
  displays: readonly string[],
  options: MenuOptions,
  runtime: MenuRuntime,
): RichText {
  const placement = requireActiveSegment(runtime.activeSegment, "{{ menu }}");
  const action = runtime.action;
  // [LAW:one-source-of-truth] Identity — and the page-cursor key derived from it
  // — comes from the SAME menu-keys derivation the loader synthesis used, so the
  // key this render reads/writes is the key whose state var + int gate the
  // loader emitted. No page-action argument to mis-wire.
  const stateKey = menuStateKey(placement.placementId, applyName, options.key);
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
  // [LAW:one-source-of-truth] The trigger's text is AUTHORED, resolved through
  // the one display rule a cycle `{{ action }}` uses — a menu's disclosure is a
  // two-member cycle, so binding `"▸" "▾"` gives the per-state form and binding
  // `"+"` gives the static one. Nothing is appended here: a disclosure glyph an
  // author never wrote is a glyph they cannot decline, which is exactly how
  // edit mode's `+` came to read `+▸`.
  const glyph = linkFragment(
    pickCycleDisplay(`{{ menu "${applyName}" }}`, displays, 2, open ? 1 : 0),
    effectsUrl([
      {
        verb: VERB_SET_STATE,
        args: [sessionId, stateKey, successor, pageKey, "0"],
      },
    ]),
    false,
  );

  // [LAW:dataflow-not-control-flow] The body is a VALUE whose length carries
  // open/closed — `[body]` open, `[]` closed — appended to the record of the
  // segment this menu renders in, the one record the walk owns and reads at
  // the segment's exit. (renderPicker is pure, so it is only built when open —
  // skipping wasted computation, gating no effect.)
  // [LAW:effects-at-boundaries] exception: the body cannot ride the returned
  // glyph as a description, because whatever wraps the call (`fg`, `bold`,
  // `link` …) rebuilds that glyph and keeps only its declared fields. So the
  // menu appends to the one record the walk publishes for this segment and
  // tears down after it — a mutation scoped to one segment's evaluation, never
  // a shared sink.
  // [LAW:one-source-of-truth] The body's page cursor is the identity-derived
  // key (its synthesized state var is named by it, the disclosure-var
  // convention), and CLOSING — the ✕ affordance or a closeOnPick pick — writes
  // the disclosure back to the closed sentinel and resets the page, the same
  // coupled pair the toggle glyph above writes. What the ▾ promised, ✕ delivers.
  // [LAW:one-source-of-truth] The body's items and its ✕ sit on the band's
  // plane: the band THIS segment opens, the same record the walk draws the
  // trigger from.
  const body = (): readonly RichText[] => {
    const drawnAt = runtime.activeSegment.drawnAt();
    const plane = bandFor(
      placement.palette,
      placement.disclosure,
      drawnAt,
    ).plane;
    return renderPicker(
      applyName,
      { key: pageKey, stateVar: pageKey },
      {
        kind: "own",
        writes: [
          [stateKey, DISCLOSURE_CLOSED],
          [pageKey, "0"],
        ],
        onPick: options.closeOnPick,
      },
      options.paged,
      action,
      // Placed by THIS menu's distribution: the picker knows positions,
      // the instance knows how it places them. Unless the domain is
      // colour-valued, in which case every option sits on the plane in
      // its own text colour; one call decides, the same one the
      // standalone `{{ picker }}` makes.
      optionItemStyle(
        placement,
        options.distribution,
        action,
        requireOptionKind(action, applyName, "menu").paletteOf,
        drawnAt,
        plane,
      ),
      closeOn(placement.palette, plane, drawnAt),
    );
  };
  placement.drops.push(...(open ? body() : []));
  return glyph;
}

// [LAW:parse-dont-validate] THE crossing for a `{{ menu }}`'s argument tail.
// The engine cannot type these slots for us — displays are strings and the
// optional trailing knobs are a dict, so one declared slot type would refuse
// one of them — so the tail arrives as opaque values and leaves here as a
// record whose shape the renderer can no longer doubt: displays are strings,
// options are parsed. Every rejected shape names the legal one.
interface MenuArgs {
  readonly displays: readonly string[];
  readonly options: MenuOptions;
}
// [LAW:one-source-of-truth] This splits the tail on VALUES; the loader splits
// the same tail on EXPRS (`menu-synth.ts`). They agree because the loader admits
// only call sites where they provably must: a last argument that is neither a
// string literal nor a literal `(dict …)` is a load error whenever both readings
// would be legal, so what reaches here can only match the loader's reading or
// throw below.
const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseMenuArgs(applyName: string, tail: readonly unknown[]): MenuArgs {
  // The dict is the LAST argument when present; everything before it is a
  // display. One position, so a reader never has to count.
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
    // [LAW:one-source-of-truth] The same option reader the loader folds over
    // the static dict — vocabulary, types, defaults live once.
    options: parseMenuOptions(optsArg ?? {}),
  };
}

// [LAW:dataflow-not-control-flow] One func; the apply-action NAME is the menu's
// whole identity (the page cursor is derived from it, not passed), the TRIGGER
// TEXT is bound like a cycle action's display (one per state, or one static),
// and the rare knobs travel as ONE optional trailing `(dict …)` — closeOnPick
// (default false: stay-open), paged (default true: a drop menu wants bounded
// height), key (accordion grouping: omitted ⇒ independent, present ⇒ mutually
// exclusive with siblings sharing it). Values, not modes. The loader gates the
// same dict statically (staticDictEntries), so an old positional tail never
// reaches this fn — it is a migration-pointing load error.
//
// [LAW:one-way-deps] Injected into the engine by registerDslConfig as data; the
// generic engine never imports this module.
export function menuFuncs(runtime: MenuRuntime): FuncMap {
  return {
    menu: {
      fn: (applyName: string, ...tail: unknown[]) => {
        const { displays, options } = parseMenuArgs(applyName, tail);
        return renderMenu(applyName, displays, options, runtime);
      },
      argTypes: ["string", "value"],
      arity: { kind: "variadic" },
      returnType: "T",
    },
  };
}
