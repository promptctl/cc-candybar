// [LAW:dataflow-not-control-flow] Best-effort extraction of the references a
// template string makes — dotted variable refs, `action "name"` refs, and
// `picker "apply" "page"` refs. Pure text walks over `{{ … }}` blocks: no
// full template parse (that is the engine's compile-time job). This file changes
// when the surface grammar of those refs changes; the cross-ref/cycle passes
// consume the sets it returns without re-deriving them.

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

// [LAW:dataflow-not-control-flow] Extract every `.<id>(.<id>)*` token inside
// `{{ ... }}` blocks after stripping string literals. The result is a set of
// dotted reference candidates; the caller decides which are valid.
export function extractTemplateRefs(template: string): Set<string> {
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

// [LAW:dataflow-not-control-flow] Extract every `action "name"` call from a
// template, for the load-time existence check. Same best-effort code-span /
// string-literal walk as extractTemplateRefs: the `action` keyword lives in a
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
// exact key).
export interface TemplateScope {
  readonly names: ReadonlySet<string>;
  readonly documents: ReadonlySet<string>;
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
