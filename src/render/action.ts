// [LAW:locality-or-seam] The runtime half of the actions seam. A `{{ action
// "name" display [boundValue] }}` call binds one clickable region (an OSC-8 span)
// to a statically-declared, named action. This module compiles the action table
// (pre-parsing copy/open templates once) and realizes a named action against the
// live state into ONE RichText whose span carries the click URL.
//
// [LAW:one-source-of-truth] The action NAME is the seam: the template supplies
// the REPRESENTATION (the display text), the action declaration supplies the
// BEHAVIOR (what value is written / copied / opened). The same declaration that
// realizes this click derives the wire gate (deriveActionValidators), so the
// rendered click and the gate cannot diverge.
//
// [LAW:dataflow-not-control-flow] `{{ action … }}` is ONE template expression, so
// it emits ONE value — a RichText carrying one OSC-8 span. The realization is a
// single total fold over the compiled-action union: each arm projects (effect,
// active) as DATA, never a branch that skips work.
//
// [LAW:one-way-deps] This is the action feature's runtime. It lives in render/
// (which depends on template-engine/), reads template-engine/scope, and is
// injected into the engine by the caller (registerDslConfig hands the action
// FuncMap in as data). The generic engine never imports this module.

import { RichText, Style } from "@promptctl/rich-js";
import type { FuncMap, Template } from "@promptctl/go-template-js";
import type { VariableStore } from "../var-system/store.js";
import { toString as varToString } from "../var-system/types.js";
import { buildScope } from "../template-engine/scope.js";
import type { ActionDecl, OptionSource } from "../config/action.js";
import {
  listResolvablePaletteNames,
  STRIP_STYLES,
  type StripStyle,
} from "../themes/policy.js";
import {
  effectsUrl,
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_SET_STATE,
  VERB_STEP_STATE,
  type Effect,
} from "../click/wire.js";

// ─── Compiled shapes ───────────────────────────────────────────────────────────

// [LAW:types-are-the-program] A compiled action mirrors ActionDecl, discriminated
// by `kind`. Each `set` arm carries the SessionState `key` it writes plus the
// `stateVar` that reads it back (resolved from the key, so the displayed/active
// value and the written value are one source — the same resolution a stepper
// widget uses). A literal carries its fixed `value`; an option binds the value
// from the template at render; a bounded carries its [min,max]/by navigation.
// copy/open carry a pre-parsed template evaluated against the live scope.
export type CompiledActionDecl =
  | {
      readonly kind: "set-literal";
      readonly key: string;
      readonly value: string;
      readonly stateVar: string;
    }
  | {
      readonly kind: "set-option";
      readonly key: string;
      readonly stateVar: string;
      // The resolved option domain. Stored at compile so a picker can iterate it
      // without re-resolving the source list, and so the set-option IS
      // self-describing (it knows its own domain), not just a key.
      readonly options: readonly string[];
    }
  | {
      // [LAW:types-are-the-program] A stepper affordance. It carries ONLY the
      // render-invariant click intent: the state `key` and the signed delta `by`.
      // It deliberately holds NO stateVar/min/max and reads NO current value at
      // render — the absolute target is computed at APPLY time from live state
      // (the daemon's step-state handler), so the emitted link is byte-identical
      // across renders and N rapid clicks each re-read-and-step. [LAW:one-source-
      // of-truth] the bounds live once in the range validator the handler reads.
      readonly kind: "set-bounded";
      readonly key: string;
      readonly by: number;
    }
  | {
      // [LAW:types-are-the-program] An int cursor: it writes whatever integer the
      // render binds (the picker's page nav supplies -1/p±1; a bare `{{ action }}`
      // supplies its display/boundValue). The gate is an unbounded int — the
      // renderer owns clamping to valid pages, exactly as set-bounded owns wrap.
      readonly kind: "set-int";
      readonly key: string;
      readonly stateVar: string;
    }
  | {
      // [LAW:types-are-the-program] An enumerated-domain stepper: the click
      // writes the SUCCESSOR of the current value in `members` (wrapping; a
      // current value outside the domain counts as the first member). Unlike
      // set-bounded — which emits a RELATIVE nudge so rapid clicks accumulate —
      // a cycle emits the ABSOLUTE successor computed at render: the rendered
      // display names the current state, so the click's meaning is "go to the
      // successor of what I showed you". A stale link then lands on the state
      // the user saw promised, not an extra flip past it — for toggles the
      // absolute write IS the correct intent.
      readonly kind: "set-cycle";
      readonly key: string;
      readonly stateVar: string;
      readonly members: readonly string[];
    }
  | { readonly kind: "copy"; readonly text: Template<RichText> }
  | { readonly kind: "open"; readonly target: Template<RichText> };

export type CompiledActions = ReadonlyMap<string, CompiledActionDecl>;

// [LAW:one-source-of-truth] An option source resolves to the SAME canonical list
// the `themes()`/`styles()`/`looks()` bindings and the derived gate consult —
// rendered options and the gate cannot diverge. The render-side resolver (the
// daemon's validator-derivation has its own that must agree — themes/styles from
// themes/policy, looks from the config's merged look names, threaded in as data
// because that one domain is per-config, not registry-static).
export function optionDomain(
  src: OptionSource,
  lookNames: readonly string[],
): readonly string[] {
  if (src === "themes") return listResolvablePaletteNames();
  if (src === "styles") return STRIP_STYLES;
  return lookNames;
}

// [LAW:locality-or-seam] The runtime holder the `action` template function closes
// over. Populated after the engine is constructed (the func references the
// engine, the compiled actions reference the engine — the holder breaks the
// cycle). `store` is the live VariableStore the renderer reads, so the action
// reads session.id and the current value from the same source the rest of the
// render does.
export interface ActionRuntime {
  // [LAW:types-are-the-program] Always present — registerDslConfig sources it
  // from the registry it is handed (registry.variableStore), so "no store" is
  // structurally unrepresentable. The action reads session.id and current
  // values from the same store the renderer reads.
  store: VariableStore;
  compiled: CompiledActions;
  // [LAW:locality-or-seam] The current render's strip style, published per render
  // by renderDsl. The picker reads it to reserve the joiner's end-cap chrome at
  // its pagination seam — the one place that needs strip geometry, kept off the
  // shared `term.cols` budget. Defaulted at registration; renders are sequential
  // and synchronous, so the per-render write never leaks across renders.
  // [LAW:no-ambient-temporal-coupling]
  stripStyle: StripStyle;
  // [LAW:locality-or-seam] The current render's intra-cell padding (resolved
  // globals.padding), published per render by renderDsl exactly like
  // stripStyle. The picker reserves 2×padding at its pagination seam — the
  // segment layout pads every line it emits, so a page packed to the full
  // budget would otherwise be pushed past the width by the pad spaces.
  padding: number;
}

// ─── Compilation ───────────────────────────────────────────────────────────────

// Pre-parse the copy/open templates for every action once, at config
// registration; set actions stay literal. [LAW:one-source-of-truth] parse-once,
// evaluate-many — renderAction only evaluates. `stateKeyToVar` maps a
// SessionState key → the variable that reads it (same map widgets use), so a
// set action reads its current/active value from the SAME value the templates
// read, regardless of whether the config named the variable after the key.
// [LAW:single-enforcer] `parse` is the config's ONE helper-aware parse closure
// (registerDslConfig owns it), not a bare engine — action copy/open templates
// resolve the same shared `{{ template "name" }}` helpers every segment does,
// through one boundary. compileActions needs only the ability to parse a source.
export function compileActions(
  parse: (src: string) => Template<RichText>,
  actions: Readonly<Record<string, ActionDecl>>,
  stateKeyToVar: ReadonlyMap<string, string>,
  // The config's look names — the one per-config option domain optionDomain
  // resolves from (themes/styles stay registry-static).
  lookNames: readonly string[],
): CompiledActions {
  const out = new Map<string, CompiledActionDecl>();
  for (const [name, action] of Object.entries(actions)) {
    out.set(name, compileAction(parse, name, action, stateKeyToVar, lookNames));
  }
  return out;
}

// [LAW:dataflow-not-control-flow] One total fold maps each ActionDecl to its
// compiled shape — the discriminator is which key is present (set's value SOURCE
// for the three set arms; copy/open otherwise). Every arm reads only its own
// fields; a new arm is one new branch.
function compileAction(
  parse: (src: string) => Template<RichText>,
  name: string,
  action: ActionDecl,
  stateKeyToVar: ReadonlyMap<string, string>,
  lookNames: readonly string[],
): CompiledActionDecl {
  if ("set" in action) {
    const stateVar = stateKeyToVar.get(action.set) ?? action.set;
    if ("to" in action) {
      return {
        kind: "set-literal",
        key: action.set,
        value: action.to,
        stateVar,
      };
    }
    if ("from" in action) {
      return {
        kind: "set-option",
        key: action.set,
        stateVar,
        options: [...optionDomain(action.from, lookNames)],
      };
    }
    if ("int" in action) {
      return { kind: "set-int", key: action.set, stateVar };
    }
    if ("cycle" in action) {
      return {
        kind: "set-cycle",
        key: action.set,
        stateVar,
        members: action.cycle,
      };
    }
    return {
      kind: "set-bounded",
      key: action.set,
      by: action.by,
    };
  }
  if ("copy" in action) {
    return {
      kind: "copy",
      text: parseActionTemplate(parse, action.copy, name),
    };
  }
  return {
    kind: "open",
    target: parseActionTemplate(parse, action.open, name),
  };
}

function parseActionTemplate(
  parse: (src: string) => Template<RichText>,
  src: string,
  name: string,
): Template<RichText> {
  try {
    return parse(src);
  } catch (e) {
    throw new Error(
      `Template parse error in actions.${name}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] Exported so the picker reads SessionState through the
// SAME boundary (has() discriminates "never written" → "").
export function readVar(store: VariableStore, name: string): string {
  // [LAW:no-defensive-null-guards] "current value may not exist" is a legitimate
  // state (the key was never written) — guard the store lookup, not a downstream
  // operation. has() is the discriminator; absence yields "".
  return store.has(name) ? varToString(store.read(name)) : "";
}

function evalTemplate(tpl: Template<RichText>, scope: object): string {
  return tpl
    .evaluate(scope)
    .map((f) => f.plain)
    .join("");
}

// [LAW:single-enforcer] One link-span constructor for both action and picker
// cells — a Style carrying the OSC-8 url, `active` riding as bold.
export function linkFragment(
  text: string,
  url: string,
  active: boolean,
): RichText {
  // [LAW:one-source-of-truth] Build the link span exactly as rich-js's `link`
  // does: a Style carrying the OSC-8 url. `active` rides as bold so the
  // currently-selected value reads as current — a value on the span, not a
  // branch in the walk.
  const rt = new RichText(text, {
    style: new Style({ link: url, bold: active }),
  });
  rt.noWrap = true;
  rt.end = "";
  return rt;
}

// [LAW:one-source-of-truth] THE "unknown current counts as the first member"
// rule — the one resolution both the display selection and the successor write
// fold over. Members are ordered default-state-first, so an unset/foreign value
// renders the first display and clicks to the second member (an accordion
// sibling's path "counts as closed", a never-written toggle "counts as off").
function cycleIndex(
  c: Extract<CompiledActionDecl, { kind: "set-cycle" }>,
  store: VariableStore,
): number {
  return Math.max(c.members.indexOf(readVar(store, c.stateVar)), 0);
}

// [LAW:dataflow-not-control-flow] The single total projection of a compiled action
// onto (effect, active) — the click's wire effect plus whether this region is the
// current selection. The template supplies `display` (the clickable text) and an
// optional `boundValue` (an option picker binds each option's value); the action
// declaration supplies everything else. Consumers never re-switch on the action
// kind: this fold is the one place the union is matched.
//   • set-literal: writes its fixed value; active when the key already holds it.
//   • set-option:  writes boundValue ?? display (the bound option); active when
//                  the key already holds it (the picker's current-mark).
//   • set-bounded: emits a RELATIVE step-state nudge (key + signed by); never
//                  reads current and never "active". The wrap + bounds + the
//                  unset seed are applied at APPLY time by the daemon handler
//                  reading live state, not snapshotted into the link here.
//   • copy/open:   one copy/open effect of the evaluated template; never active.
// [LAW:dataflow-not-control-flow] The template scope is an input only the copy/
// open arms consume, so it is built WHERE consumed (buildScope snapshots
// store.names() into a Set per call — paying it for a set-* region, e.g. every
// cell of an option picker, is pure waste). set-* arms read individual vars
// directly. This is data locality, not a control-flow guard: the scope simply
// flows into the arms that need it.
function realize(
  c: CompiledActionDecl,
  display: string,
  boundValue: string | undefined,
  store: VariableStore,
  sessionId: string,
): { effect: Effect; active: boolean } {
  switch (c.kind) {
    case "set-literal": {
      const current = readVar(store, c.stateVar);
      return {
        effect: { verb: VERB_SET_STATE, args: [sessionId, c.key, c.value] },
        active: current === c.value,
      };
    }
    case "set-option": {
      const value = boundValue ?? display;
      const current = readVar(store, c.stateVar);
      return {
        effect: { verb: VERB_SET_STATE, args: [sessionId, c.key, value] },
        active: current === value,
      };
    }
    case "set-int": {
      // The render binds the integer to write (a picker's page nav passes the
      // target page as boundValue; a bare `{{ action }}` passes its display).
      // [LAW:no-silent-failure] A bare `{{ action }}` on a set-int MUST render a
      // NUMERIC display (the manual "open at page 0" pattern: `{{ action "openMenu"
      // "0" }}`) — the display IS the value written, and the int gate
      // (makeIntValidator) rejects a non-integer at click with a loud "must be an
      // integer" BAD_REQUEST. There is no load-time check because the display is a
      // template evaluated at render (it may be dynamic), so the shape is enforced
      // at the wire, not silently coerced. active when the key already holds it.
      const value = boundValue ?? display;
      const current = readVar(store, c.stateVar);
      return {
        effect: { verb: VERB_SET_STATE, args: [sessionId, c.key, value] },
        active: current === value,
      };
    }
    case "set-cycle": {
      // [LAW:one-source-of-truth] The same current-index resolution that picked
      // the rendered display picks the write target — display and write derive
      // from one read, so the click delivers exactly the transition the glyph
      // promised.
      const next = c.members[(cycleIndex(c, store) + 1) % c.members.length]!;
      return {
        effect: { verb: VERB_SET_STATE, args: [sessionId, c.key, next] },
        active: false,
      };
    }
    case "set-bounded": {
      // [LAW:one-source-of-truth] Emit a RELATIVE nudge — the irreducible intent
      // (key + signed delta), never an absolute target derived from a render-time
      // snapshot of `current`. The daemon's step-state handler reads live state,
      // applies the wrap against the registry's bounds, and writes through the
      // single range gate. So the link is byte-identical across renders and N
      // rapid clicks each accumulate (the idempotent absolute-write bug is gone).
      return {
        effect: {
          verb: VERB_STEP_STATE,
          args: [sessionId, c.key, String(c.by)],
        },
        active: false,
      };
    }
    case "copy":
      return {
        effect: {
          verb: VERB_COPY,
          args: [evalTemplate(c.text, buildScope(store))],
        },
        active: false,
      };
    case "open":
      return {
        effect: {
          verb: VERB_OPEN_VSCODE,
          args: [evalTemplate(c.target, buildScope(store))],
        },
        active: false,
      };
  }
}

// [LAW:dataflow-not-control-flow] Which text a region shows is a pure function
// of (action kind, bound displays, current state). A cycle binds one display per
// member positionally (the toggle/N-state-cycler form: `{{ action "t" "▸" "▾"
// }}`) or one static display for all states; every other kind binds one display
// plus an optional boundValue (the option-picker form). Wrong arity is an author
// error surfaced loudly at render (composeWithDiagnostics shows it), never a
// silently dropped argument.
function selectDisplay(
  name: string,
  action: CompiledActionDecl,
  displays: readonly string[],
  store: VariableStore,
): { display: string; boundValue: string | undefined } {
  if (displays.length === 0) {
    throw new Error(`action "${name}" needs a display (the clickable text)`);
  }
  if (action.kind === "set-cycle") {
    if (displays.length !== 1 && displays.length !== action.members.length) {
      throw new Error(
        `action "${name}" cycles ${action.members.length} members; bind one display per member (${action.members.length}) or one static display, got ${displays.length}`,
      );
    }
    const display =
      displays.length === 1
        ? displays[0]!
        : displays[cycleIndex(action, store)]!;
    return { display, boundValue: undefined };
  }
  if (displays.length > 2) {
    throw new Error(
      `action "${name}" takes a display and an optional bound value, got ${displays.length} arguments (per-state displays are a cycle action's form)`,
    );
  }
  return { display: displays[0]!, boundValue: displays[1] };
}

// Realize a named action against the live state into ONE clickable RichText. The
// `action` template function delegates here.
export function renderAction(
  name: string,
  displays: readonly string[],
  runtime: ActionRuntime,
): RichText {
  const action = runtime.compiled.get(name);
  // [LAW:no-defensive-null-guards] The loader validates every `{{ action "x" }}`
  // reference resolves to a declared action, and compileActions compiled every
  // declared action for THIS config's engine. A miss is a caller/wiring bug.
  if (!action) {
    throw new Error(`action "${name}" is not declared in this config`);
  }
  const store = runtime.store;
  const { display, boundValue } = selectDisplay(name, action, displays, store);
  const sessionId = readVar(store, "session.id");
  const { effect, active } = realize(
    action,
    display,
    boundValue,
    store,
    sessionId,
  );
  return linkFragment(display, effectsUrl([effect]), active);
}

// ─── FuncMap entry ─────────────────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] One func; the action NAME selects which declared
// effect fires, the trailing strings are the bound displays. For most kinds that
// is the clickable text plus an optional boundValue (absent ⇒ the option IS the
// display, the common picker form `{{ action "applyTheme" . }}`); for a cycle it
// is one display per member (the current member's display renders) or one static
// display. Returns T (RichText), the single fragment go-template-js emits for
// `{{ action … }}`.
//
// [LAW:one-way-deps] The caller injects this FuncMap into createCcCandybarEngine
// (capabilities-over-context) so the generic engine never imports the action
// feature.
export function actionFuncs(runtime: ActionRuntime): FuncMap {
  return {
    action: {
      fn: (name: string, ...displays: string[]) =>
        renderAction(name, displays, runtime),
      argTypes: ["string", "string"],
      returnType: "T",
    },
  };
}
