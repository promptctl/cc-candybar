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
import { listResolvablePaletteNames, STYLE_ORDER } from "../themes/policy.js";
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
  | { readonly kind: "copy"; readonly text: Template<RichText> }
  | { readonly kind: "open"; readonly target: Template<RichText> };

export type CompiledActions = ReadonlyMap<string, CompiledActionDecl>;

// [LAW:one-source-of-truth] An option source resolves to the SAME canonical list
// the `themes()`/`styles()` bindings and the derived gate consult — rendered
// options and the gate cannot diverge. The render-side resolver (the daemon's
// validator-derivation has its own that must agree, both reading themes/policy).
export function optionDomain(src: OptionSource): readonly string[] {
  return src === "themes" ? listResolvablePaletteNames() : STYLE_ORDER;
}

// [LAW:locality-or-seam] The runtime holder the `action` template function closes
// over. Populated after the engine is constructed (the func references the
// engine, the compiled actions reference the engine — the holder breaks the
// cycle). `store` is the live VariableStore the renderer reads, so the action
// reads session.id and the current value from the same source the rest of the
// render does.
export interface ActionRuntime {
  store: VariableStore | null;
  compiled: CompiledActions;
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
): CompiledActions {
  const out = new Map<string, CompiledActionDecl>();
  for (const [name, action] of Object.entries(actions)) {
    out.set(name, compileAction(parse, name, action, stateKeyToVar));
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
        options: [...optionDomain(action.from)],
      };
    }
    if ("int" in action) {
      return { kind: "set-int", key: action.set, stateVar };
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
      // The unbounded int gate accepts it; active when the key already holds it.
      const value = boundValue ?? display;
      const current = readVar(store, c.stateVar);
      return {
        effect: { verb: VERB_SET_STATE, args: [sessionId, c.key, value] },
        active: current === value,
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

// Realize a named action against the live state into ONE clickable RichText. The
// `action` template function delegates here.
export function renderAction(
  name: string,
  display: string,
  boundValue: string | undefined,
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
  if (!store) {
    throw new Error(
      `action "${name}" rendered without a VariableStore — registerDslConfig was not given one`,
    );
  }
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
// effect fires, the `display` is the clickable text, the optional `boundValue` is
// the value an option picker binds (absent ⇒ the option IS the display, the
// common picker form `{{ action "applyTheme" . }}`). Returns T (RichText), the
// single fragment go-template-js emits for `{{ action … }}`.
//
// [LAW:one-way-deps] The caller injects this FuncMap into createCcCandybarEngine
// (capabilities-over-context) so the generic engine never imports the action
// feature.
export function actionFuncs(runtime: ActionRuntime): FuncMap {
  return {
    action: {
      fn: (name: string, display: string, boundValue?: string) =>
        renderAction(name, display, boundValue, runtime),
      argTypes: ["string", "string", "string"],
      returnType: "T",
    },
  };
}
