// [LAW:locality-or-seam] The runtime half of the actions seam: compiles the action
// table and realizes a named action into one RichText carrying the click URL.
// [LAW:one-source-of-truth] The action name is the seam, and the same declaration
// derives the wire gate, so the rendered click and the gate cannot diverge.

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
import { pickCycleDisplay } from "../config/disclosure.js";
import { encodeLayoutOp, type LayoutOp } from "../config/layout-ops.js";
import { parseSessionBoolean, type StripStyle } from "../themes/policy.js";
import {
  effectsUrl,
  VERB_APPLY_LAYOUT_OP,
  VERB_COPY,
  VERB_OPEN_VSCODE,
  VERB_REDO,
  VERB_RESET_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_UNDO,
  VERB_DOCTOR_RUN,
  VERB_DOCTOR_FIX,
  type Effect,
} from "../click/wire.js";

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
      readonly options: readonly string[];
    }
  | {
      // [LAW:one-source-of-truth] Only key + signed delta; bounds and the absolute target resolve at apply time.
      readonly kind: "set-bounded";
      readonly key: string;
      readonly by: number;
    }
  | {
      readonly kind: "set-int";
      readonly key: string;
      readonly stateVar: string;
    }
  | {
      // Writes the ABSOLUTE successor of the current value, wrapping, so a stale
      // link lands on the state the rendered display promised.
      readonly kind: "set-cycle";
      readonly key: string;
      readonly stateVar: string;
      readonly members: readonly string[];
    }
  | { readonly kind: "copy"; readonly text: Template<RichText> }
  | { readonly kind: "open"; readonly target: Template<RichText> }
  // [LAW:one-source-of-truth] persist's twin of the set-* kinds, minus set-int; only the verb and durability differ.
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
  | { readonly kind: "reset"; readonly key: string }
  | { readonly kind: "layout-op"; readonly key: string; readonly op: LayoutOp }
  // Anchor/relation are compile-time literals; the segment is a bound option.
  | {
      readonly kind: "layout-op-option";
      readonly key: string;
      readonly anchor: string;
      readonly relation: "before" | "after";
      readonly options: readonly string[];
    }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  // The check name is compiled in, already gated against CHECKS at load.
  | { readonly kind: "doctor-run" }
  | { readonly kind: "doctor-fix"; readonly check: string }
  // [LAW:dataflow-not-control-flow] One control per setting: `selector` names the
  // session key whose boolean picks a destination, so nothing downstream branches.
  | {
      readonly kind: "dual";
      readonly selector: string;
      readonly session: CompiledActionDecl;
      readonly durable: CompiledActionDecl;
      // Carried so a durable click can clear the session pick in the same dispatch.
      readonly sessionKey: string;
    };

export type CompiledActions = ReadonlyMap<string, CompiledActionDecl>;

// [LAW:one-source-of-truth] Globals fields exposed to templates under a different
// var name. No entry here still writes; only the current-selection mark goes inert.
const CONFIG_KEY_TO_EFFECTIVE_VAR: ReadonlyMap<string, string> = new Map([
  ["palette", "theme.effective"],
  ["preset", "preset.effective"],
  ["look", "look.effective"],
  ["style", "style.effective"],
  ["charset", "charset.effective"],
  ["colorCompatibility", "colorCompatibility.effective"],
  ["autoWrap", "autoWrap.effective"],
  ["padding", "padding.effective"],
]);

// [LAW:locality-or-seam] The holder the `action` func closes over; populated after the engine exists.
export interface ActionRuntime {
  // [LAW:types-are-the-program] Always present, so "no store" is unrepresentable.
  store: VariableStore;
  compiled: CompiledActions;
  // [LAW:no-ambient-temporal-coupling] Published per render by renderDsl.
  stripStyle: StripStyle;
  // Published per render; the picker reserves 2×padding at its pagination seam.
  padding: number;
}

// [LAW:one-source-of-truth] Parse once at registration. `stateKeyToVar` maps a
// SessionState key to the variable reading it, so an action's active value and the
// templates' come from one source.
export function compileActions(
  parse: (src: string) => Template<RichText>,
  actions: Readonly<Record<string, ActionDecl>>,
  stateKeyToVar: ReadonlyMap<string, string>,
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

// [LAW:dataflow-not-control-flow] One total fold; the discriminator is which key is present.
function compileAction(
  parse: (src: string) => Template<RichText>,
  name: string,
  action: ActionDecl,
  stateKeyToVar: ReadonlyMap<string, string>,
  perConfigDomains: ReadonlyMap<string, readonly string[]>,
): CompiledActionDecl {
  // [LAW:one-source-of-truth] A dual compiles as the same two destinations the
  // validator derivation folds over. Matched first because a dual carries `set`.
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
  if ("doctor" in action) {
    return action.doctor === "run"
      ? { kind: "doctor-run" }
      : { kind: "doctor-fix", check: action.check };
  }
  return "undo" in action ? { kind: "undo" } : { kind: "redo" };
}

// [LAW:one-source-of-truth] Both halves read back through the durable half's
// `.effective` variable, so a cycle's glyph and its click agree.
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

// [LAW:dataflow-not-control-flow] THE destination fold, total over every action, so
// callers never test for the dual kind. [LAW:one-source-of-truth] parseSessionBoolean:
// only a canonical "true" means durable.
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

// [LAW:one-source-of-truth] Exported so the picker reads SessionState here too.
export function readVar(store: VariableStore, name: string): string {
  // [LAW:no-defensive-null-guards] "Never written" is legitimate; absence yields "".
  return store.has(name) ? varToString(store.read(name)) : "";
}

function evalTemplate(tpl: Template<RichText>, scope: object): string {
  return tpl
    .evaluate(scope)
    .map((f) => f.plain)
    .join("");
}

// [LAW:single-enforcer] One link-span constructor for action and picker cells.
export function linkFragment(
  text: string,
  url: string,
  active: boolean,
  base?: Style,
): RichText {
  // [LAW:one-source-of-truth] Built as rich-js's `link`; `active` rides as bold.
  const rt = new RichText(text, {
    style: Style.combine([base, new Style({ link: url, bold: active })]),
  });
  rt.noWrap = true;
  rt.end = "";
  return rt;
}

// [LAW:one-source-of-truth] An unknown current value counts as the first member.
function cycleIndex(
  c: Extract<CompiledActionDecl, { kind: "set-cycle" | "persist-cycle" }>,
  store: VariableStore,
): number {
  return Math.max(c.members.indexOf(readVar(store, c.stateVar)), 0);
}

// [LAW:dataflow-not-control-flow] The single total projection onto (effect, active)
// — the one place the union is matched. The scope is built where consumed
// (copy/open); buildScope snapshots store.names() per call.
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
      // [LAW:no-silent-failure] The display IS the value written when nothing is
      // bound; a non-integer is rejected loudly at the wire, not coerced.
      const value = boundValue ?? display;
      const current = readVar(store, c.stateVar);
      return {
        effects: [{ verb: VERB_SET_STATE, args: [sessionId, c.key, value] }],
        active: current === value,
      };
    }
    case "set-cycle": {
      // [LAW:one-source-of-truth] One read picks both the display and the write.
      const next = c.members[(cycleIndex(c, store) + 1) % c.members.length]!;
      return {
        effects: [{ verb: VERB_SET_STATE, args: [sessionId, c.key, next] }],
        active: false,
      };
    }
    case "set-bounded": {
      // [LAW:one-source-of-truth] A RELATIVE nudge, never a render-time snapshot, so
      // the link is byte-identical across renders and rapid clicks accumulate.
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
    // [LAW:one-source-of-truth] persist-* mirrors set-*; only the wire verb differs.
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
    case "doctor-run":
      return {
        effects: [{ verb: VERB_DOCTOR_RUN, args: [sessionId] }],
        active: false,
      };
    case "doctor-fix":
      return {
        effects: [{ verb: VERB_DOCTOR_FIX, args: [sessionId, c.check] }],
        active: false,
      };
    // [LAW:one-source-of-truth] The op is fixed at compile. Its own verb because the
    // handler appends to the current config rather than overwriting.
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
    // [LAW:dataflow-not-control-flow] The destination resolves to a value and the
    // SAME fold runs on it; a dual's halves can never be dual themselves.
    // [LAW:no-silent-failure] A durable click carries the session key to RELEASE, or
    // the commit would be invisible to the session that made it.
    case "dual": {
      const chosen = activeDestination(c, store);
      const { effects, active } = realize(
        chosen,
        display,
        boundValue,
        store,
        sessionId,
      );
      // Riding the write makes the pair unsplittable: dispatch runs every effect.
      return chosen === c.durable
        ? {
            effects: effects.map((e) => ({
              ...e,
              args: [...e.args, c.sessionKey],
            })),
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

// [LAW:dataflow-not-control-flow] Display is a pure function of (kind, bound
// displays, state). Wrong arity is a loud render error.
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
    // [LAW:single-enforcer] The arity rule belongs to the disclosure primitive.
    const display = pickCycleDisplay(
      `action "${name}"`,
      displays,
      action.members.length,
      cycleIndex(action, store),
    );
    return { display, boundValue: undefined };
  }
  if (displays.length > 2) {
    throw new Error(
      `action "${name}" takes a display and an optional bound value, got ${displays.length} arguments (per-state displays are a cycle action's form)`,
    );
  }
  return { display: displays[0]!, boundValue: displays[1] };
}

export function renderAction(
  name: string,
  displays: readonly string[],
  runtime: ActionRuntime,
): RichText {
  const declared = runtime.compiled.get(name);
  // [LAW:no-defensive-null-guards] The loader validates every reference; a miss is a wiring bug.
  if (!declared) {
    throw new Error(`action "${name}" is not declared in this config`);
  }
  const store = runtime.store;
  // [LAW:dataflow-not-control-flow] Display selection reads the resolved half;
  // realization is handed the declaration, so a dual also emits the session clear.
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

// [LAW:dataflow-not-control-flow] One func; the NAME selects the declared effect,
// the trailing strings are the bound displays.
// [LAW:one-way-deps] Injected by the caller so the generic engine never imports it.
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
