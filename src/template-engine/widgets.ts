// [LAW:locality-or-seam] The render half of the widgets seam. A widget is
// reusable interactive content a segment template pulls in via `{{ widget
// "name" }}`. This module compiles widget declarations (pre-parsing the
// copy/open action templates once) and renders a named widget to a single
// RichText whose spans each carry an OSC-8 click URL.
//
// [LAW:one-type-per-behavior] A widget reference is NOT a kind of segment — it
// is content, exactly like `link` or a variable. The `widget` function returns
// a RichText that flows through the same fragmentsToCells → strip pipeline as
// any other template output.
//
// [LAW:dataflow-not-control-flow] `{{ widget "x" }}` is ONE top-level template
// expression, so it must emit ONE value. go-template-js stringifies array
// returns on direct emit, so a func cannot emit multiple fragments — instead we
// assemble one RichText from many link-bearing spans (RichText.fromFragments),
// which serializes to one correctly-delimited OSC-8 region per span. Terminals
// dispatch clicks per OSC-8 region regardless of cc-candybar's cell model.

import { RichText, Style } from "@promptctl/rich-js";
import type { Engine, FuncMap, Template } from "@promptctl/go-template-js";
import type { VariableStore } from "../var-system/store.js";
import { toString as varToString } from "../var-system/types.js";
import { buildScope } from "./scope.js";
import {
  isOptionsButtonItem,
  type Action,
  type WidgetDecl,
} from "../config/dsl-types.js";
import { listResolvablePaletteNames } from "../themes/cascade.js";
import { STYLE_ORDER } from "../themes/default-mapping.js";

// ─── Compiled shapes ───────────────────────────────────────────────────────────

// [LAW:types-are-the-program] A `set` action carries literal key/value (literal
// so the validator can be DERIVED — see deriveWidgetValidators); `value: null`
// means "bind the enclosing option's value" (an optionsFrom picker). copy/open
// carry a pre-parsed template evaluated against the live scope at render.
type CompiledAction =
  | {
      readonly kind: "set";
      readonly key: string;
      readonly value: string | null;
    }
  | { readonly kind: "copy"; readonly text: Template<RichText> }
  | { readonly kind: "open"; readonly target: Template<RichText> };

interface CompiledButton {
  // Fixed display text (glyph/label joined). null for an optionsFrom button —
  // each option supplies its own text.
  readonly display: string | null;
  // Optional leading glyph for an optionsFrom button (rendered before each
  // option). null for fixed buttons (display already carries the glyph).
  readonly glyph: string | null;
  // The option list for an optionsFrom button, else null.
  readonly options: readonly string[] | null;
  // The key an optionsFrom button's set action writes — used to mark the
  // currently-selected option. null when the button is not an option picker.
  readonly setKey: string | null;
  readonly actions: readonly CompiledAction[];
}

interface CompiledWidget {
  readonly items: readonly CompiledButton[];
}

export type CompiledWidgets = ReadonlyMap<string, CompiledWidget>;

// [LAW:locality-or-seam] The runtime holder the `widget` template function
// closes over. Populated after the engine is constructed (the func references
// the engine, the compiled widgets reference the engine — the holder breaks the
// cycle). `store` is the live VariableStore the renderer reads, so the widget
// reads session.id and the current picker value from the same source the rest
// of the render does.
export interface WidgetRuntime {
  store: VariableStore | null;
  compiled: CompiledWidgets;
}

// ─── Compilation ───────────────────────────────────────────────────────────────

// Pre-parse the copy/open action templates for every widget once, at config
// registration. set actions stay literal. [LAW:one-source-of-truth] parse-once,
// evaluate-many — renderWidget only evaluates.
export function compileWidgets(
  engine: Engine<RichText>,
  widgets: Readonly<Record<string, WidgetDecl>>,
): CompiledWidgets {
  const out = new Map<string, CompiledWidget>();
  for (const [name, widget] of Object.entries(widgets)) {
    const items: CompiledButton[] = widget.items.map((item) => {
      const options = isOptionsButtonItem(item)
        ? item.optionsFrom === "themes"
          ? listResolvablePaletteNames()
          : [...STYLE_ORDER]
        : null;
      const actions = item.onClick.map((a) => compileAction(engine, a, name));
      const setKey =
        options !== null
          ? (actions.find((a) => a.kind === "set")?.key ?? null)
          : null;
      const display =
        options !== null
          ? null
          : joinDisplay(item.glyph, "label" in item ? item.label : undefined);
      const glyph = options !== null ? (item.glyph ?? null) : null;
      return { display, glyph, options, setKey, actions };
    });
    out.set(name, { items });
  }
  return out;
}

function compileAction(
  engine: Engine<RichText>,
  action: Action,
  widgetName: string,
): CompiledAction {
  if ("set" in action) {
    return { kind: "set", key: action.set, value: action.to ?? null };
  }
  if ("copy" in action) {
    return {
      kind: "copy",
      text: parseActionTemplate(engine, action.copy, widgetName),
    };
  }
  return {
    kind: "open",
    target: parseActionTemplate(engine, action.open, widgetName),
  };
}

function parseActionTemplate(
  engine: Engine<RichText>,
  src: string,
  widgetName: string,
): Template<RichText> {
  try {
    return engine.parse(src);
  } catch (e) {
    throw new Error(
      `Template parse error in widgets.${widgetName} action: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

function joinDisplay(
  glyph: string | undefined,
  label: string | undefined,
): string {
  return [glyph, label].filter((s): s is string => !!s).join(" ");
}

// ─── Rendering ───────────────────────────────────────────────────────────────

// [LAW:single-enforcer] One click-URL composer. encodeURIComponent each segment
// and join with "/" — parseHandlerUrl (src/install/index.ts) decodes the value
// with a single decodeURIComponent, so per-segment encoding round-trips and the
// structural "/" separators survive. set-state values never contain "/" (the
// loader + validators reject it), so no separator can be smuggled in.
function clickUrl(verb: string, ...segments: string[]): string {
  const tail = segments.map((s) => encodeURIComponent(s)).join("/");
  return `cc-candybar://${verb}/${tail}`;
}

// [LAW:dataflow-not-control-flow] A button's onClick is homogeneous (the loader
// enforces: all `set`, or one `copy`, or one `open`). set actions batch into one
// set-state URL (the .2 batched wire); copy/open compose their own verb URL.
// `optionValue` is the option string for an optionsFrom button (bound into set
// actions whose literal value is null), else null.
function composeUrl(
  actions: readonly CompiledAction[],
  scope: object,
  sessionId: string,
  optionValue: string | null,
): string {
  const sets = actions.filter(
    (a): a is Extract<CompiledAction, { kind: "set" }> => a.kind === "set",
  );
  if (sets.length > 0) {
    const pairs = sets.flatMap((a) => [a.key, a.value ?? optionValue ?? ""]);
    return clickUrl("set-state", sessionId, ...pairs);
  }
  // [LAW:no-defensive-null-guards] The loader guarantees a non-set button has
  // exactly one copy/open action; index 0 is that action by construction.
  const action = actions[0]!;
  if (action.kind === "copy") {
    return clickUrl("copy", evalTemplate(action.text, scope));
  }
  if (action.kind === "open") {
    return clickUrl("open-vscode", evalTemplate(action.target, scope));
  }
  // [LAW:types-are-the-program] Unreachable: sets.length===0 above means no set
  // action, and the loader rejects an empty/mixed onClick — so index 0 is
  // copy/open. The throw makes the exhaustiveness explicit rather than silent.
  throw new Error("widget: non-set button had no copy/open action");
}

function evalTemplate(tpl: Template<RichText>, scope: object): string {
  return tpl
    .evaluate(scope)
    .map((f) => f.plain)
    .join("");
}

function linkFragment(text: string, url: string, active: boolean): RichText {
  // [LAW:one-source-of-truth] Build the link span exactly as rich-js's `link`
  // does: a Style carrying the OSC-8 url. The active option carries bold so the
  // currently-selected pick reads as current — a value on the span, not a
  // branch in the walk.
  return new RichText(text, { style: new Style({ link: url, bold: active }) });
}

function readVar(store: VariableStore, name: string): string {
  // [LAW:no-defensive-null-guards] "current value may not exist" is a legitimate
  // state (the key was never written) — guard the store lookup, not a downstream
  // operation. has() is the discriminator; absence yields "".
  return store.has(name) ? varToString(store.read(name)) : "";
}

// Render a named widget to one RichText (many link-bearing spans). The `widget`
// template function delegates here.
export function renderWidget(name: string, runtime: WidgetRuntime): RichText {
  const widget = runtime.compiled.get(name);
  // [LAW:no-defensive-null-guards] The loader validates every `{{ widget "x" }}`
  // reference resolves to a declared widget, and compileWidgets compiled every
  // declared widget for THIS config's engine. A miss is a caller/wiring bug.
  if (!widget) {
    throw new Error(`widget "${name}" is not declared in this config`);
  }
  const store = runtime.store;
  if (!store) {
    throw new Error(
      `widget "${name}" rendered without a VariableStore — registerDslConfig was not given one`,
    );
  }
  const scope = buildScope(store);
  const sessionId = readVar(store, "session.id");

  const fragments: RichText[] = [];
  const push = (frag: RichText): void => {
    if (fragments.length > 0) fragments.push(new RichText(" "));
    fragments.push(frag);
  };

  for (const item of widget.items) {
    if (item.options !== null) {
      const current = item.setKey !== null ? readVar(store, item.setKey) : "";
      for (const option of item.options) {
        const text = item.glyph ? `${item.glyph} ${option}` : option;
        const url = composeUrl(item.actions, scope, sessionId, option);
        push(linkFragment(text, url, option === current));
      }
    } else {
      const url = composeUrl(item.actions, scope, sessionId, null);
      push(linkFragment(item.display ?? "", url, false));
    }
  }

  const assembled = RichText.fromFragments(fragments);
  assembled.noWrap = true;
  assembled.end = "";
  return assembled;
}

// ─── FuncMap entry ─────────────────────────────────────────────────────────────

// [LAW:dataflow-not-control-flow] One zero-config func; the widget NAME is the
// data that selects which declared component renders. Returns T (RichText), the
// single fragment go-template-js emits for `{{ widget "name" }}`.
export function widgetFuncs(runtime: WidgetRuntime): FuncMap {
  return {
    widget: {
      fn: (name: string) => renderWidget(name, runtime),
      argTypes: ["string"],
      returnType: "T",
    },
  };
}
