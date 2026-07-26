// [LAW:dataflow-not-control-flow] Best-effort extraction of the references a
// template string makes — dotted variable refs, `action "name"` refs, and
// `picker "apply" "page"` refs. Pure text walks over `{{ … }}` blocks: no
// full template parse (that is the engine's compile-time job). This file changes
// when the surface grammar of those refs changes; the cross-ref/cycle passes
// consume the sets it returns without re-deriving them.

const TEMPLATE_BLOCK_RE = /{{([\s\S]*?)}}/g;
const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;
const DOTTED_REF_RE =
  /(?<![A-Za-z0-9_)])\.([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/g;

// [LAW:dataflow-not-control-flow] Extract every `.<id>(.<id>)*` token inside
// `{{ ... }}` blocks after stripping string literals. The result is a set of
// dotted reference candidates; the caller decides which are valid.
export function extractTemplateRefs(template: string): Set<string> {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  TEMPLATE_BLOCK_RE.lastIndex = 0;
  while ((m = TEMPLATE_BLOCK_RE.exec(template)) !== null) {
    const block = m[1]!.replace(STRING_LITERAL_RE, "");
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
  TEMPLATE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_BLOCK_RE.exec(template)) !== null) {
    const block = m[1]!;
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

// [LAW:dataflow-not-control-flow] Extract the action names a `picker` OR `menu`
// call references, for the load-time existence check. A `picker` binds an
// (apply, page) action pair as its first two string-literal args
// (`{{ picker "applyTheme" "themePage" true true }}`); a `menu` binds ONLY its
// apply action (`{{ menu "applyTheme" (dict …) }}`) — its page cursor is
// synthesized from identity, and the dict's option-name literals must never be
// misread as action refs. A menu's body IS a picker, so the existence check is
// identical; one extractor arms on either keyword with the keyword's own arg
// count [LAW:single-enforcer]. Same code/string-span walk as extractActionRefs.
const PICKER_OR_MENU_ARG_RE = /\b(picker|menu)\s+$/;
export function extractPickerMenuRefs(template: string): Set<string> {
  const refs = new Set<string>();
  TEMPLATE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_BLOCK_RE.exec(template)) !== null) {
    const block = m[1]!;
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

// A ref resolves if (a) the full dotted name is a declared variable, OR
// (b) it's a strict prefix of some declared variable (namespace navigation
// like .session in `.session.id` when only `session.id` is declared).
export function refResolves(ref: string, allVars: Set<string>): boolean {
  if (allVars.has(ref)) return true;
  const prefix = `${ref}.`;
  for (const name of allVars) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}
