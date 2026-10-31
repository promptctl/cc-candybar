// [LAW:dataflow-not-control-flow] Best-effort extraction of the references a
// template string makes — dotted variable refs, and the actions an `action`,
// `picker`, `menu` or `carousel` binds — through the template's own text and
// every helper it reaches. Pure text walks over `{{ … }}` blocks: no full
// template parse (that is the engine's compile-time job). Every question is a
// fold over the one call-graph walk (`callGraphBlocks`); a new question is a new
// fold over it, never a second walker, or it is blind to helpers again.

import { ownedBy } from "./plugin-scope.js";
import { parseArm, type DslConfig, type VariableDecl } from "../dsl-types.js";

const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;

// [LAW:single-enforcer] The inside of every `{{ … }}` action in a template,
// string literals intact. A block closes at the first `}}` OUTSIDE a string
// literal, as the engine's own lexer closes it: a literal carrying `}}` (a
// display, an escaped glyph) is text, and a regex ending at the first `}}`
// would read the rest of that literal as code. A `/* … */` comment is skipped
// the same way, and left out of the block: it is neither code nor a literal,
// and an apostrophe in it opens nothing. An unclosed action yields nothing:
// it is the engine's parse error to report. Every extractor below reads its
// blocks from here, and each block says where each of its characters sits in
// the template, so a rewrite lands on the template's own text.
interface Block {
  readonly text: string;
  readonly at: (index: number) => number;
}

function* templateBlocks(template: string): IterableIterator<Block> {
  let open = template.indexOf("{{");
  while (open !== -1) {
    let block = "";
    let i = open + 2;
    // [block index, template index] at the start of each run of kept text.
    const spans: Array<readonly [number, number]> = [[0, i]];
    while (i < template.length && !template.startsWith("}}", i)) {
      if (template.startsWith("/*", i)) {
        const close = template.indexOf("*/", i + 2);
        i = close === -1 ? template.length : close + 2;
        spans.push([block.length, i]);
        continue;
      }
      const start = i;
      const quote = template[i]!;
      i += 1;
      if (quote === '"' || quote === "'" || quote === "`") {
        while (i < template.length && template[i] !== quote) {
          i += template[i] === "\\" && quote !== "`" ? 2 : 1;
        }
        i += 1;
      }
      block += template.slice(start, i);
    }
    if (i >= template.length) return;
    yield {
      text: block,
      at: (index) => {
        let [from, to] = spans[0]!;
        for (const [b, t] of spans) if (b <= index) [from, to] = [b, t];
        return to + index - from;
      },
    };
    open = template.indexOf("{{", i + 2);
  }
}

// Where the dot stands, as a prefix from the walk's root (the template the
// walk started at): "" is that root, "a.b." is its field `a.b`, and null is a
// value no path names — a `range` element, a computed `with`, the argument a
// helper was handed as a `dict`. A ref on a null dot reads that value, never
// the root.
type Dot = string | null;

// A `.`, `.a.b`, `$` or `$.a.b` operand at the start of `text`, as the Dot it
// names — `$` being `root`, the dot the enclosing body was entered at;
// anything else — a `dict`, a pipeline, `$x`, nothing — is null.
const PATH = "[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*";
const OPERAND_RE = new RegExp(
  `^(?:(\\$)(?:\\.(${PATH}))?|\\.(${PATH})?)(?=[\\s)]|$)`,
);
function operandAt(text: string, dot: Dot, root: Dot): Dot {
  const m = OPERAND_RE.exec(text.trimStart());
  if (m === null) return null;
  const [base, field] = m[1] !== undefined ? [root, m[2]] : [dot, m[3]];
  if (base === null) return null;
  return field === undefined ? base : `${base}${field}.`;
}

// [LAW:types-are-the-program] Every `{{ … }}` action of a body entered at
// `root`, with the Dot its text is evaluated at, tracking the rebinding Go
// templates do: `with X` binds the dot to X for its body, `range` binds it to
// each element, `else` returns to the enclosing dot (an `else with X` binds X
// there), `end` closes. A header (`range .items`) is evaluated at the dot
// OUTSIDE the body it opens.
const KEYWORD_RE = /^(\w+)\b\s*([\s\S]*)$/;
function* scopedBlocks(
  template: string,
  root: Dot,
): IterableIterator<{ code: string; dot: Dot; block: Block }> {
  const stack: Dot[] = [root];
  for (const block of templateBlocks(template)) {
    const code = block.text.replace(/^-(?=\s)/, "").trim();
    const [, keyword = "", rest = ""] = KEYWORD_RE.exec(code) ?? [];
    const top = stack[stack.length - 1]!;
    const outer = stack.length > 1 ? stack[stack.length - 2]! : top;
    if (keyword === "end") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (keyword === "else") {
      yield { code, dot: outer, block };
      const chained = /^with\b([\s\S]*)$/.exec(rest);
      stack[stack.length - 1] =
        chained === null ? outer : operandAt(chained[1]!, outer, root);
      continue;
    }
    yield { code, dot: top, block };
    if (keyword === "if") stack.push(top);
    if (keyword === "with") stack.push(operandAt(rest, top, root));
    if (keyword === "range" || keyword === "define" || keyword === "block")
      stack.push(null);
  }
}

// The `{{ template "name" <arg> }}` calls in an action, each with the Dot its
// argument hands the helper — null when the argument names no path (a
// `dict`, a pipeline): the reads that built it are the caller's own, spelled
// where it was built, and the helper's refs on it name nothing.
const TEMPLATE_KEYWORD_RE = /(?<![.$])\btemplate\s+$/;
function* helperCalls(
  code: string,
  dot: Dot,
  root: Dot,
): IterableIterator<{ name: string; at: Dot; index: number }> {
  let cursor = 0;
  for (const s of [...code.matchAll(STRING_LITERAL_RE)]) {
    const end = s.index + s[0].length;
    if (TEMPLATE_KEYWORD_RE.test(code.slice(cursor, s.index))) {
      yield {
        name: s[0].slice(1, -1),
        at: operandAt(code.slice(end), dot, root),
        index: s.index,
      };
    }
    cursor = end;
  }
}

// One action of a template's call graph: its text, the Dot it is evaluated
// at and the one `$` names in it (both from the TEMPLATE's root), and the
// helper whose body spells it (`null` = the template itself).
interface GraphBlock {
  readonly code: string;
  readonly dot: Dot;
  readonly root: Dot;
  readonly via: string | null;
}

// [LAW:single-enforcer] THE walk of a template's call graph: every action of
// the template, then of every helper it calls, followed through the helpers
// those call — whatever the argument, since a helper handed a `dict` still
// spells its own actions and picks. A helper already on the call chain is not
// followed again (a recursive walker, `{{ template "walk" .child }}`, hands
// itself a longer path each time, so the path cannot be what stops it), and a
// helper already walked at a Dot is not walked there twice. Every question a
// template's text answers at load — what it reads, which actions it binds —
// folds over this, so none is blind to a helper.
function* callGraphBlocks(
  template: string,
  helpers: Readonly<Record<string, string>>,
): IterableIterator<GraphBlock> {
  const walked = new Set<string>();
  function* walk(
    src: string,
    root: Dot,
    via: string | null,
    chain: ReadonlySet<string>,
  ): IterableIterator<GraphBlock> {
    for (const { code, dot } of [...scopedBlocks(src, root)]) {
      yield { code, dot, root, via };
      for (const call of [...helperCalls(code, dot, root)]) {
        // An own key only: `helpers` is a plain object, and a call naming
        // `toString` must find no helper, not Object.prototype's.
        const body = Object.hasOwn(helpers, call.name)
          ? helpers[call.name]
          : undefined;
        const key = `${call.name}\0${call.at ?? "\0"}`;
        if (body === undefined || chain.has(call.name) || walked.has(key))
          continue;
        walked.add(key);
        yield* walk(body, call.at, call.name, new Set([...chain, call.name]));
      }
    }
  }
  yield* walk(template, "", null, new Set());
}

// One answer per template text: a gate's text recurs at every node of every
// preset that edit chrome wraps alike, and every question asked of a template
// is asked of the same text again at compile.
export function perTemplate<T>(
  answer: (template: string) => T,
): (t: string) => T {
  const answers = new Map<string, T>();
  return (template) => {
    if (!answers.has(template)) answers.set(template, answer(template));
    return answers.get(template)!;
  };
}

// [LAW:one-source-of-truth] The walk, materialised once per template under one
// helpers object, and read by every question asked of that template: a
// template is asked what it reads, which actions it binds, which functions
// and helpers it calls, at load and again at compile, and each was a walk of
// its own over the same text. The helpers object is the config's, so the
// walks live exactly as long as the config does, as a config's value-reads
// fold does (value-reads.ts).
const WALKS = new WeakMap<
  object,
  (template: string) => readonly GraphBlock[]
>();
function callGraph(
  template: string,
  helpers: Readonly<Record<string, string>>,
): readonly GraphBlock[] {
  let walks = WALKS.get(helpers);
  if (walks === undefined) {
    walks = perTemplate((t) => [...callGraphBlocks(t, helpers)]);
    WALKS.set(helpers, walks);
  }
  return walks(template);
}

// The refs an action's text spells, as paths from the template's root. A `$.a`
// ref is under `root` whatever the dot; a `.a` ref is under the dot; either
// reads nothing nameable when its base is null.
const REF_RE = new RegExp(`(?<![A-Za-z0-9_)$])(\\$?)\\.(${PATH})`, "g");
function* dotRefs({ code, dot, root }: GraphBlock): IterableIterator<string> {
  const text = code.replace(STRING_LITERAL_RE, "");
  for (const r of [...text.matchAll(REF_RE)]) {
    const base = r[1] === "$" ? root : dot;
    if (base !== null) yield `${base}${r[2]!}`;
  }
}

// [LAW:single-enforcer] What a template READS, as paths from its root: its own
// refs and every reachable helper's (`callGraphBlocks`). A helper's refs are
// relative to the argument it was given — a helper fed a `dict` reads the
// dict, one called with `.` inside a `range` reads the element. Each ref maps
// to the helper whose body spells it (`null` = the template itself), so a load
// error names the body to fix. Every variable-read question — reachability,
// cross-ref, cycles, synthesis, introspection — asks this, so none is blind to
// a helper's reads.
export function templateReads(
  template: string,
  helpers: Readonly<Record<string, string>>,
): ReadonlyMap<string, string | null> {
  const reads = new Map<string, string | null>();
  for (const block of callGraph(template, helpers)) {
    for (const ref of dotRefs(block)) {
      if (!reads.has(ref)) reads.set(ref, block.via);
    }
  }
  return reads;
}

// [LAW:types-are-the-program] How a template binds a declared action: an
// `{{ action "name" … }}` region, or the option domain a `picker`, `menu`,
// `carousel`, `swatch`, `swatches` or `themePreview` lays out.
export type ActionSite = "action" | "options";

// [LAW:dataflow-not-control-flow] The action names one action's text binds,
// for the load-time existence check. The `action` keyword lives in a CODE span
// and its NAME is the very next string literal (the display/boundValue
// literals that follow are preceded by a non-`action` span, so they are never
// misread as the name). A `picker` binds an (apply, page) pair as its first
// two string literals (`{{ picker "applyTheme" "themePage" true true }}`); a
// `menu` binds ONLY its apply action (`{{ menu "applyTheme" (dict …) }}`) —
// its page cursor is synthesized from identity, and the dict's option-name
// literals must never be misread as action refs — and a `carousel` binds its
// (apply, open) pair the same way (`{{ carousel "applyTheme" "openThemes"
// "theme" }}`): its label comes last so a computed one cannot shift them.
// A `swatches` row binds (apply, page) as a picker does; a `swatch` binds only
// its apply action — the literal after it names an option, not an action —
// and a `themePreview` binds the apply action it is named, when it is.
// One scan arms on any keyword with that keyword's own arg count
// [LAW:single-enforcer], and a name is a literal among the call's OWN
// arguments: one inside a parenthesised argument belongs to that expression,
// and the call ends at its closing `)` or a `|`, so an optional name left out
// is never filled from whatever follows. A keyword after `.` or `$` is a field
// read (`eq .menu "open"`), never a call.
const BINDING_KEYWORD_RE =
  /(?<![.$])\b(action|picker|menu|carousel|swatches|swatch|themePreview)\s+$/;
const NAME_ARGS: Readonly<Record<string, number>> = {
  action: 1,
  picker: 2,
  menu: 1,
  carousel: 2,
  swatch: 1,
  swatches: 2,
  themePreview: 1,
};
function* actionBindings(
  code: string,
): IterableIterator<{ name: string; site: ActionSite; index: number }> {
  let cursor = 0;
  let pending = 0; // remaining name args to capture for the current call
  let depth = 0; // parentheses open inside the current call's argument list
  let site: ActionSite = "action";
  for (const s of [...code.matchAll(STRING_LITERAL_RE)]) {
    const between = code.slice(cursor, s.index);
    const kw = BINDING_KEYWORD_RE.exec(between);
    if (kw !== null) {
      pending = NAME_ARGS[kw[1]!]!;
      depth = 0;
      site = kw[1] === "action" ? "action" : "options";
    } else {
      for (const ch of between) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (depth < 0 || (ch === "|" && depth === 0)) pending = 0;
      }
    }
    if (pending > 0 && depth === 0) {
      yield { name: s[0].slice(1, -1), site, index: s.index };
      pending--;
    }
    cursor = s.index + s[0].length;
  }
}

// [LAW:single-enforcer] Every action a template binds — through its own text
// and every reachable helper's (`callGraphBlocks`), exactly as its reads are
// found — once per body that binds it: the name, how that body first binds it,
// and the helper whose body spells it (`null` = the template itself). Per body,
// not per name, so a misspelling bound in two bodies is reported at both.
export interface ActionRef {
  readonly name: string;
  readonly site: ActionSite;
  readonly via: string | null;
}
export function templateActionRefs(
  template: string,
  helpers: Readonly<Record<string, string>>,
): readonly ActionRef[] {
  const refs = new Map<string, ActionRef>();
  for (const { code, via } of callGraph(template, helpers)) {
    for (const { name, site } of actionBindings(code)) {
      const key = `${name}\0${via ?? "\0"}`;
      if (!refs.has(key)) refs.set(key, { name, site, via });
    }
  }
  return [...refs.values()];
}

// Whether a template — through its own text or any helper it calls — binds an
// action by a name it computes (`{{ action $name "x" }}`, `{{ menu .which }}`)
// rather than spells: a binding keyword whose first argument is no literal.
// `templateActionRefs` reads only spelled names, so such a template may bind
// any declared action. A keyword with no argument (`{{ themePreview }}`)
// binds none.
const COMPUTED_BINDING_RE =
  /(?<![\w.$])(?:action|picker|menu|carousel|swatches|swatch|themePreview)\s+(?=[^\s"`)|}])/;
export function bindsComputedAction(
  template: string,
  helpers: Readonly<Record<string, string>>,
): boolean {
  for (const { code } of callGraph(template, helpers)) {
    if (COMPUTED_BINDING_RE.test(code.replace(STRING_LITERAL_RE, '""'))) {
      return true;
    }
  }
  return false;
}

// [LAW:single-enforcer] Every function a template CALLS by name — in its own
// text and every reachable helper's (`callGraphBlocks`) — as one more fold over
// the call-graph walk. A name is a bare identifier in code: a field (`.now`), a
// variable (`$now`) and a string literal ("now") call nothing. The keywords
// (`if`, `range`, `template`) are bare identifiers too, so ask it about a
// function's name, never for a list of functions.
const BARE_NAME_RE = /(?<![\w.$])[A-Za-z_]\w*/g;
export function templateFunctions(
  template: string,
  helpers: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const called = new Set<string>();
  for (const { code } of callGraph(template, helpers)) {
    for (const [name] of code
      .replace(STRING_LITERAL_RE, "")
      .matchAll(BARE_NAME_RE)) {
      called.add(name);
    }
  }
  return called;
}

// [LAW:single-enforcer] Every declared helper a template CALLS — directly, or
// through a helper it calls — as one more fold over the call-graph walk. Read
// off the calls rather than off the blocks a helper yields, so a helper with
// an empty body is still called.
export function templateHelperRefs(
  template: string,
  helpers: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  return new Set(
    [...templateHelperCalls(template, helpers)].filter((name) =>
      Object.hasOwn(helpers, name),
    ),
  );
}

// Every helper name a template calls, declared or not — a call to a dropped
// plugin's helper names nothing until it stands in.
export function templateHelperCalls(
  template: string,
  helpers: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const called = new Set<string>();
  for (const { code, dot, root } of callGraph(template, helpers)) {
    for (const { name } of helperCalls(code, dot, root)) called.add(name);
  }
  return called;
}

// [LAW:single-enforcer] A template with every reference it spells to `self`
// bound to `ns`: a read whose path starts `self` from the template's root
// (`.self.data` where the dot is the root, or `$.self.data` anywhere), and a
// helper or action named `self.…` where a call names one (`template
// "self.state"`, `action "self.raise"`, a picker's pair). Found by the same
// lexer and dot tracking every question above asks, so a string literal that
// only displays `self`, a field `self` of a `range` element or a `with` value,
// and a longer name (`.selfish`) are left as written.
const SELF_REF_RE = (self: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_)$])(\\$?)\\.${self}(?![A-Za-z0-9_])`, "g");
export function bindSelf(template: string, self: string, ns: string): string {
  const refRe = SELF_REF_RE(self);
  const named = ownedBy(self);
  const starts: number[] = [];
  for (const { dot, block } of scopedBlocks(template, "")) {
    const code = block.text.replace(STRING_LITERAL_RE, (s) =>
      " ".repeat(s.length),
    );
    for (const r of code.matchAll(refRe)) {
      const base = r[1] === "$" ? "" : dot;
      if (base === "") starts.push(block.at(r.index + r[1]!.length + 1));
    }
    for (const { name, index } of [
      ...helperCalls(block.text, dot, ""),
      ...actionBindings(block.text),
    ]) {
      if (named(name)) starts.push(block.at(index + 1));
    }
  }
  return [...new Set(starts)]
    .sort((a, b) => b - a)
    .reduce(
      (t, start) => t.slice(0, start) + ns + t.slice(start + self.length),
      template,
    );
}

// Every variable the config declares, under the name the store holds it by
// (a global by its own name, a segment's local as `segName.varName`), with the
// config path that declares it.
// [LAW:one-source-of-truth] The one spelling of a segment variable's store name.
export function* declarationsAt(
  // What it reads: a config's variables and its segments' own vars, so an
  // authored file's sections answer as a built config's do.
  config: Pick<DslConfig, "variables"> & {
    readonly segments: Readonly<
      Record<string, Pick<DslConfig["segments"][string], "vars">>
    >;
  },
): IterableIterator<
  readonly [name: string, decl: VariableDecl, at: readonly string[]]
> {
  for (const [name, decl] of Object.entries(config.variables)) {
    yield [name, decl, ["variables", name]];
  }
  for (const [segName, seg] of Object.entries(config.segments)) {
    for (const [varName, decl] of Object.entries(seg.vars ?? {})) {
      yield [
        `${segName}.${varName}`,
        decl,
        ["segments", segName, "vars", varName],
      ];
    }
  }
}

export function* declaredVariables(
  config: Pick<DslConfig, "variables" | "segments">,
): IterableIterator<readonly [name: string, decl: VariableDecl]> {
  for (const [name, decl] of declarationsAt(config)) yield [name, decl];
}

// [LAW:single-enforcer] THE resolution of a read to the declarations it
// reaches, for every walk that asks: the declared name the path starts with
// (`.budget.spent` reads the document `budget`), else — a read that reaches no
// declared name — every name under it, as a namespace (`.git` reads every
// `git.*`). Empty for a read of nothing declared. No declared name sits under
// another (nesting.ts), so at most one declared name starts a path, and the
// draw's scope proxy, which takes the first it reaches, lands on the same one.
export function variableRead(
  path: string,
  names: ReadonlySet<string>,
): readonly string[] {
  const parts = path.split(".");
  for (let n = parts.length; n > 0; n--) {
    const name = parts.slice(0, n).join(".");
    if (names.has(name)) return [name];
  }
  const namespace = `${path}.`;
  return [...names].filter((name) => name.startsWith(namespace));
}

// [LAW:types-are-the-program] What a template reference resolves against:
// the declared variable NAMES (exactly the keys the runtime store holds) and,
// among them, the DOCUMENTS — `parse: { json }` sources whose fields are a
// namespace UNDER the name (the scope proxy hands the engine the document and
// `.doc.a.b` is a field walk the loader cannot see into; a missing field is
// the runtime's MissingFieldError, as for a payload field). One value, so
// every reference surface — template refs, `when`, cache.key — resolves the
// same way; `depends_on` reads `names` alone (the reaction calls the store by
// exact key). And the HELPERS, because a ref a helper spells on the root dot is
// a read of the template that calls it (`templateReads`).
export interface TemplateScope {
  readonly names: ReadonlySet<string>;
  readonly documents: ReadonlySet<string>;
  readonly helpers: Readonly<Record<string, string>>;
}

// A ref resolves when it reaches a declaration (variableRead): the name
// itself, a namespace of names under it, or a declared document whose field it
// reads. Past any other declared name it reads into a value the loader cannot
// see, so it does not resolve.
export function refResolves(ref: string, scope: TemplateScope): boolean {
  return variableRead(ref, scope.names).some(
    (name) => !ref.startsWith(`${name}.`) || scope.documents.has(name),
  );
}

// [LAW:one-source-of-truth] The one scope every reference surface resolves
// against, built from the same declarations src/dsl/render.ts registers:
// globals under their bare names, segment locals under segName.varName — and
// which of those are documents (a json-parsed shell/file source).
export function templateScopeOf(cfg: DslConfig): TemplateScope {
  const names = new Set<string>();
  const documents = new Set<string>();
  const declare = (name: string, v: VariableDecl): void => {
    names.add(name);
    if (isDocumentDecl(v)) documents.add(name);
  };
  for (const [name, v] of declaredVariables(cfg)) declare(name, v);
  return { names, documents, helpers: cfg.helpers };
}

// [LAW:one-source-of-truth] The one document predicate: what cross-ref lets a
// field read reach into is what the store declares a document (declareOne,
// src/dsl/render.ts) — a json shell or file, a plugin's source, a tombstone.
function isDocumentDecl(v: VariableDecl): boolean {
  return (
    v.kind === "dropped" ||
    v.kind === "source" ||
    ((v.kind === "shell" || v.kind === "file") && parseArm(v.parse) === "json")
  );
}
