// [LAW:dataflow-not-control-flow] Best-effort extraction of the references a
// template string makes — dotted variable refs, `action "name"` refs, and
// `picker "apply" "page"` refs. Pure text walks over `{{ … }}` blocks: no
// full template parse (that is the engine's compile-time job). This file changes
// when the surface grammar of those refs changes; the cross-ref/cycle passes
// consume the sets it returns without re-deriving them.

import { parseArm, type DslConfig, type VariableDecl } from "../dsl-types.js";

const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;
const DOTTED_REF_RE =
  /(?<![A-Za-z0-9_)])\.([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/g;

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

// Every `.<id>(.<id>)*` token inside `{{ ... }}` blocks after stripping string
// literals — the refs this template text spells itself, blind to the helpers it
// calls. Local on purpose: every reader asks `templateReads`.
function dottedRefs(template: string): Set<string> {
  const refs = new Set<string>();
  for (const raw of templateBlocks(template)) {
    const block = raw.replace(STRING_LITERAL_RE, "");
    let r: RegExpExecArray | null;
    DOTTED_REF_RE.lastIndex = 0;
    while ((r = DOTTED_REF_RE.exec(block)) !== null) {
      refs.add(r[1]!);
    }
  }
  return refs;
}

// A `{{ template "name" <arg> }}` call, with where its argument puts the
// helper's dot: `.` hands it the root (prefix ""), `.a.b` hands it the field
// `a.b` (prefix "a.b."), anything else — a `dict`, a pipeline, `$x`, no arg —
// hands it a value whose reads the CALLER already spelled building it.
const TEMPLATE_KEYWORD_RE = /\btemplate\s+$/;
const DOT_ARG_RE = /^\s+\.((?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?)(?=\s|\)|$)/;
function* helperCalls(
  template: string,
): IterableIterator<{ name: string; prefix: string }> {
  for (const block of templateBlocks(template)) {
    let cursor = 0;
    let s: RegExpExecArray | null;
    STRING_LITERAL_RE.lastIndex = 0;
    while ((s = STRING_LITERAL_RE.exec(block)) !== null) {
      const end = s.index + s[0].length;
      if (TEMPLATE_KEYWORD_RE.test(block.slice(cursor, s.index))) {
        const arg = DOT_ARG_RE.exec(block.slice(end));
        if (arg !== null) {
          yield {
            name: s[0].slice(1, -1),
            prefix: arg[1] === "" ? "" : `${arg[1]}.`,
          };
        }
      }
      cursor = end;
    }
  }
}

// [LAW:single-enforcer] What a template READS: its own dotted refs, plus the
// refs of every helper it hands a root-relative dot to, followed through
// helpers those call. A helper's `.x` is relative to the argument it was
// given, so it is a root read only when that argument is `.` or a `.a.b` path
// — a helper fed a `dict` reads the dict. Each ref maps to the helper it was
// reached through (`null` = the template itself), so a load error can name
// the body that spells it. Every reader — reachability, cross-ref, cycles,
// introspection — asks this, so none is blind to a helper's reads.
export function templateReads(
  template: string,
  helpers: Readonly<Record<string, string>>,
): ReadonlyMap<string, string | null> {
  const reads = new Map<string, string | null>();
  const seen = new Set<string>();
  const walk = (src: string, prefix: string, via: string | null): void => {
    for (const ref of dottedRefs(src)) {
      if (!reads.has(prefix + ref)) reads.set(prefix + ref, via);
    }
    // Collected before recursing: the scan's regexes are shared globals.
    for (const call of [...helperCalls(src)]) {
      const body = helpers[call.name];
      const at = prefix + call.prefix;
      const key = `${call.name}\0${at}`;
      if (body === undefined || seen.has(key)) continue;
      seen.add(key);
      walk(body, at, via ?? call.name);
    }
  };
  walk(template, "", null);
  return reads;
}

// [LAW:dataflow-not-control-flow] Extract every `action "name"` call from a
// template, for the load-time existence check. Same best-effort code-span /
// string-literal walk as dottedRefs: the `action` keyword lives in a
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
