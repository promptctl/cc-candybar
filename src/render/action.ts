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
import {
  actionDestinations,
  actionIsDual,
  PERSIST_WHEN,
  type ActionDecl,
} from "../config/action.js";
import { resolveOptionDomain } from "../config/option-domain.js";
import { encodeLayoutOp, type LayoutOp } from "../config/layout-ops.js";
import { parseSessionBoolean, type StripStyle } from "../themes/policy.js";
import {
  effectsUrl,
  VERB_APPLY_LAYOUT_OP,
  VERB_CLEAR_STATE,
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_REDO,
  VERB_RESET_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_UNDO,
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
  | { readonly kind: "open"; readonly target: Template<RichText> }
  // [LAW:one-source-of-truth] `persist`'s twin of the set-* kinds above,
  // MINUS set-int (a page cursor is never persisted — see action.ts). Carries
  // the SAME shapes for the SAME reason: a persistent write is gated and
  // realized exactly like a session write, only the wire verb (VERB_SET_CONFIG/
  // VERB_STEP_CONFIG) and the write's durability differ.
  | {
      readonly kind: "persist-literal";
      readonly key: string;
      readonly value: string;
      readonly stateVar: string;
    }
  | {
      readonly kind: "persist-option";
      readonly key: string;
      readonly stateVar: string;
      readonly options: readonly string[];
    }
  | {
      readonly kind: "persist-bounded";
      readonly key: string;
      readonly by: number;
    }
  | {
      readonly kind: "persist-cycle";
      readonly key: string;
      readonly stateVar: string;
      readonly members: readonly string[];
    }
  // [LAW:one-source-of-truth] The gated undo for a persistent write: clears
  // one config-overrides key. Carries only the key — there is no value to
  // realize, so it shares copy/open's "no gate" shape at compile time (the
  // GATE is the key-membership check the reset-config verb handler applies).
  | { readonly kind: "reset"; readonly key: string }
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.1's structural-edit
  // arms. Fully literal at compile time (the op IS the declaration — no
  // template-bound option, unlike persist-option), so `op` is precomputed
  // here rather than reconstructed from raw fields at every realize() call.
  | { readonly kind: "layout-op"; readonly key: string; readonly op: LayoutOp }
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.3's domain-sourced
  // sibling of layout-op: `anchor`/`relation` are fixed at compile time (the
  // POSITION is author-time data) but the segment name comes from the
  // template's bound option — the option-picking shape `persist-option`
  // already has, minus the value being written VERBATIM. `requireOptionKind`
  // (render/picker.ts) admits this kind alongside set-option/persist-option
  // so a `{{ menu }}`/`{{ picker }}` can drive it with zero picker changes;
  // only the WRITE (realize(), below) differs — it encodes the picked option
  // into a LayoutOp instead of persisting it as-is.
  | {
      readonly kind: "layout-op-option";
      readonly key: string;
      readonly anchor: string;
      readonly relation: "before" | "after";
      readonly options: readonly string[];
    }
  // [LAW:one-source-of-truth] brandon-layout-edit-2gc.2's global history
  // step over the overrides layer — `reset`'s fine-grained sibling. No key:
  // there is nothing to carry, since the history stack (not this action) is
  // what decides which entry moves.
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  // [LAW:dataflow-not-control-flow] candybar-settings-ui-aok.3's ONE control
  // per setting. Both destinations are compiled here as the ordinary
  // single-destination shapes they are, and `selector` names the session key
  // whose boolean value picks between them at click time. The destination is
  // therefore a VALUE flowing through `activeDestination` — every consumer
  // (realize, the picker, selectDisplay) resolves it once at the top and then
  // runs the code it has always run, so nothing downstream branches on
  // "is this dual".
  | {
      readonly kind: "dual";
      readonly selector: string;
      readonly session: CompiledActionDecl;
      readonly durable: CompiledActionDecl;
      // The SessionState key the session half writes, carried so a durable
      // click can clear it in the same dispatch (see realize's dual arm).
      readonly sessionKey: string;
    };

export type CompiledActions = ReadonlyMap<string, CompiledActionDecl>;

// [LAW:one-source-of-truth] Globals fields whose CURRENT resolved value is
// exposed to templates under a different var name than the field itself (the
// daemon publishes this resolution once per render — e.g. `theme.effective`
// for `palette`, src/daemon/render-payload.ts). A `persist` action with no
// entry here reads back through its own key name as an input var (mirrors
// compileActions' stateKeyToVar fallback), so every persistable globals field
// needs an entry unless its `.effective` projection happens to be named
// exactly the bare field (none are — every projection carries the
// `.effective` suffix). Every field with a projection is listed
// (candybar-config-engine-71o.3 added style/charset/colorCompatibility/
// autoWrap/padding to palette/look's original two); a field with no entry
// here still writes correctly on `persist` — only its "current selection"
// highlight is inert (readVar falls back to "" since no such var exists).
const CONFIG_KEY_TO_EFFECTIVE_VAR: ReadonlyMap<string, string> = new Map([
  ["palette", "theme.effective"],
  ["look", "look.effective"],
  ["style", "style.effective"],
  ["charset", "charset.effective"],
  ["colorCompatibility", "colorCompatibility.effective"],
  ["autoWrap", "autoWrap.effective"],
  ["padding", "padding.effective"],
]);

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
  // This config's per-config option domains (currently just "looks" — the
  // config's merged look names) — resolveOptionDomain checks these before
  // falling back to the global registry (themes/styles).
  perConfigDomains: ReadonlyMap<string, readonly string[]>,
): CompiledActions {
  const out = new Map<string, CompiledActionDecl>();
  for (const [name, action] of Object.entries(actions)) {
    out.set(
      name,
      compileAction(parse, name, action, stateKeyToVar, perConfigDomains),
    );
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
  perConfigDomains: ReadonlyMap<string, readonly string[]>,
): CompiledActionDecl {
  // [LAW:one-source-of-truth] A dual compiles as its own two destinations —
  // the SAME explosion the validator derivations fold over
  // (actionDestinations), so the click a dual realizes and the gate it derives
  // come from one statement of what the two halves are. It is matched BEFORE
  // the `set` arm because a dual carries `set` too.
  if (actionIsDual(action)) {
    const [session, durable] = actionDestinations(action);
    return compileDual(
      stateKeyToVar.get(action[PERSIST_WHEN]) ?? action[PERSIST_WHEN],
      action.set,
      compileAction(parse, name, session!, stateKeyToVar, perConfigDomains),
      compileAction(parse, name, durable!, stateKeyToVar, perConfigDomains),
    );
  }
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
        options: [...resolveOptionDomain(action.from, perConfigDomains)],
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
  if ("persist" in action) {
    const stateVar =
      CONFIG_KEY_TO_EFFECTIVE_VAR.get(action.persist) ?? action.persist;
    if ("to" in action) {
      return {
        kind: "persist-literal",
        key: action.persist,
        value: action.to,
        stateVar,
      };
    }
    if ("from" in action) {
      return {
        kind: "persist-option",
        key: action.persist,
        stateVar,
        options: [...resolveOptionDomain(action.from, perConfigDomains)],
      };
    }
    if ("cycle" in action) {
      return {
        kind: "persist-cycle",
        key: action.persist,
        stateVar,
        members: action.cycle,
      };
    }
    if ("removeSegment" in action) {
      return {
        kind: "layout-op",
        key: action.persist,
        op: { op: "remove", target: action.removeSegment },
      };
    }
    if ("insertSegment" in action) {
      return {
        kind: "layout-op",
        key: action.persist,
        op: {
          op: "insert",
          segment: action.insertSegment,
          anchor: action.anchor,
          relation: action.relation,
        },
      };
    }
    if ("insertSegmentFrom" in action) {
      return {
        kind: "layout-op-option",
        key: action.persist,
        anchor: action.anchor,
        relation: action.relation,
        options: [
          ...resolveOptionDomain(action.insertSegmentFrom, perConfigDomains),
        ],
      };
    }
    return {
      kind: "persist-bounded",
      key: action.persist,
      by: action.by,
    };
  }
  if ("copy" in action) {
    return {
      kind: "copy",
      text: parseActionTemplate(parse, action.copy, name),
    };
  }
  if ("open" in action) {
    return {
      kind: "open",
      target: parseActionTemplate(parse, action.open, name),
    };
  }
  if ("reset" in action) {
    return { kind: "reset", key: action.reset };
  }
  return "undo" in action ? { kind: "undo" } : { kind: "redo" };
}

// [LAW:one-source-of-truth] A dual control shows ONE current value and writes
// relative to the value it showed — so both destinations read back through the
// DURABLE half's variable, which is the `.effective` projection the daemon
// resolved for this render (CONFIG_KEY_TO_EFFECTIVE_VAR above): the value the
// bar is actually rendering with, whatever chain produced it. Reading the
// session key instead would let a cycle's glyph name the effective state while
// its click stepped from an unwritten session key — the toggle would render
// "wrap: off" and write "false", a click that visibly does nothing. Arms that
// carry no `stateVar` (the bounded steppers) read nothing at render by design:
// their step is relative and resolved daemon-side.
function compileDual(
  selectorVar: string,
  sessionKey: string,
  session: CompiledActionDecl,
  durable: CompiledActionDecl,
): CompiledActionDecl {
  const readBack =
    "stateVar" in session && "stateVar" in durable
      ? { ...session, stateVar: durable.stateVar }
      : session;
  return {
    kind: "dual",
    selector: selectorVar,
    session: readBack,
    durable,
    sessionKey,
  };
}

// [LAW:dataflow-not-control-flow] THE destination fold: which store a dual
// action writes is the boolean value of its selector key, read from the same
// live store the rest of the render reads. Total over every compiled action —
// a single-destination action IS its own destination — so callers resolve
// through it unconditionally and never test for the dual kind.
//
// [LAW:one-source-of-truth] `parseSessionBoolean` is the one spelling of a
// boolean in SessionState (themes/policy.ts), the same parse `autoWrap`'s own
// session half goes through: an unwritten, malformed, or "false" selector all
// mean the session destination, and only a canonical "true" means durable.
export function activeDestination(
  c: CompiledActionDecl,
  store: VariableStore,
): CompiledActionDecl {
  if (c.kind !== "dual") return c;
  return parseSessionBoolean(readVar(store, c.selector)) === true
    ? c.durable
    : c.session;
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
  c: Extract<CompiledActionDecl, { kind: "set-cycle" | "persist-cycle" }>,
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
export function realize(
  c: CompiledActionDecl,
  display: string,
  boundValue: string | undefined,
  store: VariableStore,
  sessionId: string,
): { effects: readonly Effect[]; active: boolean } {
  switch (c.kind) {
    case "set-literal": {
      const current = readVar(store, c.stateVar);
      return {
        effects: [{ verb: VERB_SET_STATE, args: [sessionId, c.key, c.value] }],
        active: current === c.value,
      };
    }
    case "set-option": {
      const value = boundValue ?? display;
      const current = readVar(store, c.stateVar);
      return {
        effects: [{ verb: VERB_SET_STATE, args: [sessionId, c.key, value] }],
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
        effects: [{ verb: VERB_SET_STATE, args: [sessionId, c.key, value] }],
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
        effects: [{ verb: VERB_SET_STATE, args: [sessionId, c.key, next] }],
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
        effects: [
          {
            verb: VERB_STEP_STATE,
            args: [sessionId, c.key, String(c.by)],
          },
        ],
        active: false,
      };
    }
    case "copy":
      return {
        effects: [
          {
            verb: VERB_COPY,
            args: [evalTemplate(c.text, buildScope(store))],
          },
        ],
        active: false,
      };
    case "open":
      return {
        effects: [
          {
            verb: VERB_OPEN_VSCODE,
            args: [evalTemplate(c.target, buildScope(store))],
          },
        ],
        active: false,
      };
    // [LAW:one-source-of-truth] The persist-* arms mirror set-*'s realization
    // verbatim (same literal/option/cycle/bounded semantics), only the wire
    // verb differs (VERB_SET_CONFIG/VERB_STEP_CONFIG instead of
    // VERB_SET_STATE/VERB_STEP_STATE) — the daemon-side handler is what makes
    // the write durable, not the click itself.
    case "persist-literal": {
      const current = readVar(store, c.stateVar);
      return {
        effects: [{ verb: VERB_SET_CONFIG, args: [sessionId, c.key, c.value] }],
        active: current === c.value,
      };
    }
    case "persist-option": {
      const value = boundValue ?? display;
      const current = readVar(store, c.stateVar);
      return {
        effects: [{ verb: VERB_SET_CONFIG, args: [sessionId, c.key, value] }],
        active: current === value,
      };
    }
    case "persist-cycle": {
      const next = c.members[(cycleIndex(c, store) + 1) % c.members.length]!;
      return {
        effects: [{ verb: VERB_SET_CONFIG, args: [sessionId, c.key, next] }],
        active: false,
      };
    }
    case "persist-bounded": {
      return {
        effects: [
          {
            verb: VERB_STEP_CONFIG,
            args: [sessionId, c.key, String(c.by)],
          },
        ],
        active: false,
      };
    }
    case "reset":
      return {
        effects: [{ verb: VERB_RESET_CONFIG, args: [sessionId, c.key] }],
        active: false,
      };
    // [LAW:one-source-of-truth] No key to carry — the click just says "step
    // the history", and which entry moves is entirely server-side state
    // (never wire input, so there is nothing here to gate). Never "active":
    // a history step is a one-shot trigger, not a current-selection toggle.
    case "undo":
      return {
        effects: [{ verb: VERB_UNDO, args: [sessionId] }],
        active: false,
      };
    case "redo":
      return {
        effects: [{ verb: VERB_REDO, args: [sessionId] }],
        active: false,
      };
    // [LAW:one-source-of-truth] The op is fixed at compile time (see
    // compileAction) — the click just delivers it. `apply-layout-op`'s
    // handler does read-current-append-write (see verbs/index.ts), unlike
    // persist-literal's plain overwrite, so it is its own verb rather than
    // VERB_SET_CONFIG. Never "active": a structural edit is a one-shot
    // trigger, not a current-selection toggle.
    case "layout-op":
      return {
        effects: [
          {
            verb: VERB_APPLY_LAYOUT_OP,
            args: [sessionId, c.key, encodeLayoutOp(c.op)],
          },
        ],
        active: false,
      };
    // [LAW:one-source-of-truth] The picked option (boundValue ?? display — the
    // SAME resolution persist-option uses) becomes the op's `segment`; anchor/
    // relation are the compiled literals. Same wire shape a literal layout-op
    // emits, so the daemon's apply-layout-op handler and undo/redo need no
    // knowledge of where the segment name came from. Never "active": a
    // structural edit is a one-shot trigger, not a current-selection toggle.
    // [LAW:dataflow-not-control-flow] The destination is resolved to a value
    // and the SAME fold runs on it — a dual's realization is its chosen
    // half's realization, with nothing about persistence duplicated here.
    // Depth is structurally one: a dual's halves are the single-destination
    // decls actionDestinations built, which can never be dual themselves.
    //
    // [LAW:no-silent-failure] A DURABLE click carries the session clear with
    // it, as a second effect in the same atomic dispatch. Without it the write
    // would be invisible to the session that made it — every settable global
    // resolves session pick OVER durable default, so the ordinary workflow
    // this menu invites ("try it here, then tick persist? to commit it")
    // would set a default the user cannot see and leave the control dead for
    // the rest of the session, clicking forever with nothing changing.
    // "Make this everyone's default" means "and stop overriding it here",
    // and that is an ABSENCE, which is what clear-state writes.
    case "dual": {
      const chosen = activeDestination(c, store);
      const { effects, active } = realize(
        chosen,
        display,
        boundValue,
        store,
        sessionId,
      );
      return chosen === c.durable
        ? {
            effects: [
              ...effects,
              { verb: VERB_CLEAR_STATE, args: [sessionId, c.sessionKey] },
            ],
            active,
          }
        : { effects, active };
    }
    case "layout-op-option": {
      const segment = boundValue ?? display;
      const op: LayoutOp = {
        op: "insert",
        segment,
        anchor: c.anchor,
        relation: c.relation,
      };
      return {
        effects: [
          {
            verb: VERB_APPLY_LAYOUT_OP,
            args: [sessionId, c.key, encodeLayoutOp(op)],
          },
        ],
        active: false,
      };
    }
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
  if (action.kind === "set-cycle" || action.kind === "persist-cycle") {
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
  const declared = runtime.compiled.get(name);
  // [LAW:no-defensive-null-guards] The loader validates every `{{ action "x" }}`
  // reference resolves to a declared action, and compileActions compiled every
  // declared action for THIS config's engine. A miss is a caller/wiring bug.
  if (!declared) {
    throw new Error(`action "${name}" is not declared in this config`);
  }
  const store = runtime.store;
  // [LAW:dataflow-not-control-flow] DISPLAY selection reads the resolved half
  // (a cycle's glyph is the current member's, whichever store it will write),
  // while REALIZATION is handed the declaration itself — a dual realizes as
  // its chosen half PLUS the session clear that keeps a durable write visible,
  // and that pairing belongs to the one fold that owns the union.
  const { display, boundValue } = selectDisplay(
    name,
    activeDestination(declared, store),
    displays,
    store,
  );
  const sessionId = readVar(store, "session.id");
  const { effects, active } = realize(
    declared,
    display,
    boundValue,
    store,
    sessionId,
  );
  return linkFragment(display, effectsUrl(effects), active);
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
