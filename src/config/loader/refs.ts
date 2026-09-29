// [LAW:dataflow-not-control-flow] Best-effort extraction of the references a
// template string makes — dotted variable refs, and the actions an `action`,
// `picker`, `menu` or `carousel` binds — through the template's own text and
// every helper it reaches. Pure text walks over `{{ … }}` blocks: no full
// template parse (that is the engine's compile-time job). Every question is a
// fold over the one call-graph walk (`callGraphBlocks`); a new question is a new
// fold over it, never a second walker, or it is blind to helpers again.

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
): IterableIterator<{ code: string; dot: Dot }> {
  const stack: Dot[] = [root];
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
        chained === null ? outer : operandAt(chained[1]!, outer, root);
      continue;
    }
    yield { code, dot: top };
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
): IterableIterator<{ name: string; at: Dot }> {
  let cursor = 0;
  for (const s of [...code.matchAll(STRING_LITERAL_RE)]) {
    const end = s.index + s[0].length;
    if (TEMPLATE_KEYWORD_RE.test(code.slice(cursor, s.index))) {
      yield {
        name: s[0].slice(1, -1),
        at: operandAt(code.slice(end), dot, root),
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
  for (const block of callGraphBlocks(template, helpers)) {
    for (const ref of dotRefs(block)) {
      if (!reads.has(ref)) reads.set(ref, block.via);
    }
  }
  return reads;
}

// [LAW:types-are-the-program] How a template binds a declared action: an
// `{{ action "name" … }}` region, or the option domain a `picker`, `menu` or
// `carousel` lays out.
export type ActionSite = "action" | "options";

// [LAW:dataflow-not-control-flow] The action names one action's text binds,
// for the load-time existence check. The `action` keyword lives in a CODE span
// and its NAME is the very next string literal (the display/boundValue
// literals that follow are preceded by a non-`action` span, so they are never
// misread as the name). A `picker` binds an (apply, page) pair as its first
// two string literals (`{{ picker "applyTheme" "themePage" true true }}`); a
// `menu` binds ONLY its apply action (`{{ menu "applyTheme" (dict …) }}`) —
// its page cursor is synthesized from identity, and the dict's option-name
// literals must never be misread as action refs — and a `carousel` binds only
// its apply action too. One scan arms on any keyword with that keyword's own
// arg count [LAW:single-enforcer]. A keyword after `.` or `$` is a field read
// (`eq .menu "open"`), never a call.
const BINDING_KEYWORD_RE = /(?<![.$])\b(action|picker|menu|carousel)\s+$/;
const NAME_ARGS: Readonly<Record<string, number>> = {
  action: 1,
  picker: 2,
  menu: 1,
  carousel: 1,
};
function* actionBindings(
  code: string,
): IterableIterator<{ name: string; site: ActionSite }> {
  let cursor = 0;
  let pending = 0; // remaining name args to capture for the current call
  let site: ActionSite = "action";
  for (const s of [...code.matchAll(STRING_LITERAL_RE)]) {
    const kw = BINDING_KEYWORD_RE.exec(code.slice(cursor, s.index));
    if (kw !== null) {
      pending = NAME_ARGS[kw[1]!]!;
      site = kw[1] === "action" ? "action" : "options";
    }
    if (pending > 0) {
      yield { name: s[0].slice(1, -1), site };
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
  for (const { code, via } of callGraphBlocks(template, helpers)) {
    for (const { name, site } of actionBindings(code)) {
      const key = `${name}\0${via ?? "\0"}`;
      if (!refs.has(key)) refs.set(key, { name, site, via });
    }
  }
  return [...refs.values()];
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
