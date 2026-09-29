// [LAW:dataflow-not-control-flow] Best-effort extraction of the references a
// template string makes — dotted variable refs, `action "name"` refs, and
// `picker "apply" "page"` refs. Pure text walks over `{{ … }}` blocks: no
// full template parse (that is the engine's compile-time job). This file changes
// when the surface grammar of those refs changes; the cross-ref/cycle passes
// consume the sets it returns without re-deriving them.

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
// blocks from here.
function* templateBlocks(template: string): IterableIterator<string> {
  let open = template.indexOf("{{");
  while (open !== -1) {
    let block = "";
    let i = open + 2;
    while (i < template.length && !template.startsWith("}}", i)) {
      if (template.startsWith("/*", i)) {
        const close = template.indexOf("*/", i + 2);
        i = close === -1 ? template.length : close + 2;
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
    yield block;
    open = template.indexOf("{{", i + 2);
  }
}

// Where the dot stands, as a prefix relative to the walk's `$` (the template's
// root, or the argument a helper was called with): "" is `$` itself, "a.b." is
// its field `a.b`, and null is a value no path names — a `range` element, a
// computed `with`. A ref on a null dot reads that value, never the root.
type Dot = string | null;

// A `.`, `.a.b`, `$` or `$.a.b` operand at the start of `text`, as the Dot it
// names; anything else — a `dict`, a pipeline, `$x`, nothing — is null.
const PATH = "[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*";
const OPERAND_RE = new RegExp(
  `^(?:(\\$)(?:\\.(${PATH}))?|\\.(${PATH})?)(?=[\\s)]|$)`,
);
function operandAt(text: string, dot: Dot): Dot {
  const m = OPERAND_RE.exec(text.trimStart());
  if (m === null) return null;
  if (m[1] !== undefined) return m[2] === undefined ? "" : `${m[2]}.`;
  if (dot === null) return null;
  return m[3] === undefined ? dot : `${dot}${m[3]}.`;
}

// [LAW:types-are-the-program] Every `{{ … }}` action with the Dot its text is
// evaluated at, tracking the rebinding Go templates do: `with X` binds the dot
// to X for its body, `range` binds it to each element, `else` returns to the
// enclosing dot (an `else with X` binds X there), `end` closes. A header
// (`range .items`) is evaluated at the dot OUTSIDE the body it opens.
const KEYWORD_RE = /^(\w+)\b\s*([\s\S]*)$/;
function* scopedBlocks(
  template: string,
): IterableIterator<{ code: string; dot: Dot }> {
  const stack: Dot[] = [""];
  for (const raw of templateBlocks(template)) {
    const code = raw.replace(/^-(?=\s)/, "").trim();
    const [, keyword = "", rest = ""] = KEYWORD_RE.exec(code) ?? [];
    const top = stack[stack.length - 1]!;
    const outer = stack.length > 1 ? stack[stack.length - 2]! : top;
    if (keyword === "end") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (keyword === "else") {
      yield { code, dot: outer };
      const chained = /^with\b([\s\S]*)$/.exec(rest);
      stack[stack.length - 1] =
        chained === null ? outer : operandAt(chained[1]!, outer);
      continue;
    }
    yield { code, dot: top };
    if (keyword === "if") stack.push(top);
    if (keyword === "with") stack.push(operandAt(rest, top));
    if (keyword === "range" || keyword === "define" || keyword === "block")
      stack.push(null);
  }
}

// The refs an action's text spells, relative to the walk's `$`. A `$.a` ref
// is `a` whatever the dot; a `.a` ref is under the dot, and reads nothing
// nameable when the dot is null.
const REF_RE = new RegExp(`(?<![A-Za-z0-9_)$])(\\$?)\\.(${PATH})`, "g");
function* dotRefs(code: string, dot: Dot): IterableIterator<string> {
  const text = code.replace(STRING_LITERAL_RE, "");
  for (const r of [...text.matchAll(REF_RE)]) {
    if (r[1] === "$") yield r[2]!;
    else if (dot !== null) yield `${dot}${r[2]!}`;
  }
}

// The `{{ template "name" <arg> }}` calls in an action, each with the Dot its
// argument hands the helper; a call whose argument names no path hands it a
// value whose reads the caller already spelled building it, and is left out.
const TEMPLATE_KEYWORD_RE = /\btemplate\s+$/;
function* helperCalls(
  code: string,
  dot: Dot,
): IterableIterator<{ name: string; at: string }> {
  let cursor = 0;
  for (const s of [...code.matchAll(STRING_LITERAL_RE)]) {
    const end = s.index + s[0].length;
    if (TEMPLATE_KEYWORD_RE.test(code.slice(cursor, s.index))) {
      const at = operandAt(code.slice(end), dot);
      if (at !== null) yield { name: s[0].slice(1, -1), at };
    }
    cursor = end;
  }
}

// [LAW:single-enforcer] What a template READS, as paths from its root: its own
// refs, plus the refs of every helper it hands a path, followed through the
// helpers those call. A helper's refs are relative to the argument it was
// given — a helper fed a `dict` reads the dict, one called with `.` inside a
// `range` reads the element. A helper already on the call chain is not
// followed again (a recursive walker, `{{ template "walk" .child }}`, hands
// itself a longer path each time, so the path cannot be what stops it), and a
// helper already walked at a path is not walked there twice. Each ref maps to
// the helper whose body spells it (`null` = the template itself), so a load
// error names the body to fix. Every variable-read question — reachability,
// cross-ref, cycles, synthesis, introspection — asks this, so none is blind to
// a helper's reads.
export function templateReads(
  template: string,
  helpers: Readonly<Record<string, string>>,
): ReadonlyMap<string, string | null> {
  const reads = new Map<string, string | null>();
  const walked = new Set<string>();
  const walk = (
    src: string,
    base: string,
    via: string | null,
    chain: ReadonlySet<string>,
  ): void => {
    for (const { code, dot } of [...scopedBlocks(src)]) {
      for (const ref of dotRefs(code, dot)) {
        if (!reads.has(base + ref)) reads.set(base + ref, via);
      }
      for (const call of [...helperCalls(code, dot)]) {
        const body = helpers[call.name];
        const at = base + call.at;
        const key = `${call.name}\0${at}`;
        if (body === undefined || chain.has(call.name) || walked.has(key))
          continue;
        walked.add(key);
        walk(body, at, call.name, new Set([...chain, call.name]));
      }
    }
  };
  walk(template, "", null, new Set());
  return reads;
}

// [LAW:dataflow-not-control-flow] Extract every `action "name"` call from a
// template, for the load-time existence check. Same best-effort code-span /
// string-literal walk as helperCalls: the `action` keyword lives in a
// CODE span and its NAME is the very next string literal (the display/boundValue
// literals that follow are preceded by a non-`action` span, so they are never
// misread as the name).
const ACTION_ARG_RE = /\baction\s+$/;
export function extractActionRefs(template: string): Set<string> {
  const refs = new Set<string>();
  for (const block of templateBlocks(template)) {
    let cursor = 0;
    let s: RegExpExecArray | null;
    STRING_LITERAL_RE.lastIndex = 0;
    while ((s = STRING_LITERAL_RE.exec(block)) !== null) {
      if (ACTION_ARG_RE.test(block.slice(cursor, s.index))) {
        refs.add(s[0].slice(1, -1));
      }
      cursor = s.index + s[0].length;
    }
  }
  return refs;
}

// [LAW:dataflow-not-control-flow] Extract the action names a `picker`, `menu`
// or `carousel` call references, for the load-time existence check. A `picker`
// binds an (apply, page) action pair as its first two string-literal args
// (`{{ picker "applyTheme" "themePage" true true }}`); a `menu` binds ONLY its
// apply action (`{{ menu "applyTheme" (dict …) }}`) — its page cursor is
// synthesized from identity, and the dict's option-name literals must never be
// misread as action refs — and a `carousel` binds only its apply action too.
// All three lay out one option domain, so the existence check is identical;
// one extractor arms on any keyword with the keyword's own arg count
// [LAW:single-enforcer]. Same code/string-span walk as extractActionRefs.
const PICKER_OR_MENU_ARG_RE = /\b(picker|menu|carousel)\s+$/;
export function extractPickerMenuRefs(template: string): Set<string> {
  const refs = new Set<string>();
  for (const block of templateBlocks(template)) {
    let cursor = 0;
    let pending = 0; // remaining name args to capture for the current call
    let s: RegExpExecArray | null;
    STRING_LITERAL_RE.lastIndex = 0;
    while ((s = STRING_LITERAL_RE.exec(block)) !== null) {
      const kw = PICKER_OR_MENU_ARG_RE.exec(block.slice(cursor, s.index));
      if (kw !== null) pending = kw[1] === "picker" ? 2 : 1;
      if (pending > 0) {
        refs.add(s[0].slice(1, -1));
        pending--;
      }
      cursor = s.index + s[0].length;
    }
  }
  return refs;
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

// A ref resolves if (a) the full dotted name is a declared variable, (b) it
// is a strict prefix of some declared variable (namespace navigation like
// .session in `.session.id` when only `session.id` is declared), or (c) a
// declared document is a strict prefix of it (a field read).
export function refResolves(ref: string, scope: TemplateScope): boolean {
  if (scope.names.has(ref)) return true;
  const prefix = `${ref}.`;
  for (const name of scope.names) {
    if (name.startsWith(prefix)) return true;
  }
  for (const doc of scope.documents) {
    if (ref.startsWith(`${doc}.`)) return true;
  }
  return false;
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
  for (const [name, v] of Object.entries(cfg.variables)) declare(name, v);
  for (const [segName, seg] of Object.entries(cfg.segments)) {
    for (const [name, v] of Object.entries(seg.vars ?? {})) {
      declare(`${segName}.${name}`, v);
    }
  }
  return { names, documents, helpers: cfg.helpers };
}

function isDocumentDecl(v: VariableDecl): boolean {
  return (
    (v.kind === "shell" || v.kind === "file") && parseArm(v.parse) === "json"
  );
}
