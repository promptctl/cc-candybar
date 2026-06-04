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
import type { Engine, FuncMap, Template } from "@promptctl/go-template-js";
import type { VariableStore } from "../var-system/store.js";
import { toString as varToString } from "../var-system/types.js";
import { buildScope } from "../template-engine/scope.js";
import type { ActionDecl } from "../config/action.js";
import {
  effectsUrl,
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_SET_STATE,
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
type CompiledActionDecl =
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
    }
  | {
      readonly kind: "set-bounded";
      readonly key: string;
      readonly stateVar: string;
      readonly min: number;
      readonly max: number;
      readonly by: number;
    }
  | { readonly kind: "copy"; readonly text: Template<RichText> }
  | { readonly kind: "open"; readonly target: Template<RichText> };

export type CompiledActions = ReadonlyMap<string, CompiledActionDecl>;

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
export function compileActions(
  engine: Engine<RichText>,
  actions: Readonly<Record<string, ActionDecl>>,
  stateKeyToVar: ReadonlyMap<string, string>,
): CompiledActions {
  const out = new Map<string, CompiledActionDecl>();
  for (const [name, action] of Object.entries(actions)) {
    out.set(name, compileAction(engine, name, action, stateKeyToVar));
  }
  return out;
}

// [LAW:dataflow-not-control-flow] One total fold maps each ActionDecl to its
// compiled shape — the discriminator is which key is present (set's value SOURCE
// for the three set arms; copy/open otherwise). Every arm reads only its own
// fields; a new arm is one new branch.
function compileAction(
  engine: Engine<RichText>,
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
      return { kind: "set-option", key: action.set, stateVar };
    }
    return {
      kind: "set-bounded",
      key: action.set,
      stateVar,
      min: action.min,
      max: action.max,
      by: action.by,
    };
  }
  if ("copy" in action) {
    return {
      kind: "copy",
      text: parseActionTemplate(engine, action.copy, name),
    };
  }
  return {
    kind: "open",
    target: parseActionTemplate(engine, action.open, name),
  };
}

function parseActionTemplate(
  engine: Engine<RichText>,
  src: string,
  name: string,
): Template<RichText> {
  try {
    return engine.parse(src);
  } catch (e) {
    throw new Error(
      `Template parse error in actions.${name}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function readVar(store: VariableStore, name: string): string {
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

function linkFragment(text: string, url: string, active: boolean): RichText {
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

// [LAW:single-enforcer] One integer-read boundary mirroring the range validator's
// canonical shape (`^-?\d+$`): only an integer-shaped string is a value (clamped
// into [min,max]); anything else — empty (unset/no backing var), a float, a typo —
// starts at the floor. So the value a bounded action steps FROM is always an
// in-range integer the wire validator would also accept.
const INT_RE = /^-?\d+$/;
function readClampedInt(
  store: VariableStore,
  name: string,
  min: number,
  max: number,
): number {
  const raw = readVar(store, name);
  return INT_RE.test(raw)
    ? Math.max(min, Math.min(max, parseInt(raw, 10)))
    : min;
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
//   • set-bounded: writes wrap(current ± by) clamped to [min,max] — the stepper
//                  affordance; never "active" (an affordance is not a selection).
//   • copy/open:   one copy/open effect of the evaluated template; never active.
function realize(
  c: CompiledActionDecl,
  display: string,
  boundValue: string | undefined,
  scope: object,
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
    case "set-bounded": {
      const current = readClampedInt(store, c.stateVar, c.min, c.max);
      const next = current + c.by;
      // The stepper owns navigation: stepping past a bound WRAPS to the other
      // end, so the written value is always inside [min,max] (the range gate
      // passes it through).
      const wrapped = next > c.max ? c.min : next < c.min ? c.max : next;
      return {
        effect: {
          verb: VERB_SET_STATE,
          args: [sessionId, c.key, String(wrapped)],
        },
        active: false,
      };
    }
    case "copy":
      return {
        effect: { verb: VERB_COPY, args: [evalTemplate(c.text, scope)] },
        active: false,
      };
    case "open":
      return {
        effect: {
          verb: VERB_OPEN_VSCODE,
          args: [evalTemplate(c.target, scope)],
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
  const scope = buildScope(store);
  const sessionId = readVar(store, "session.id");
  const { effect, active } = realize(
    action,
    display,
    boundValue,
    scope,
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
