// [LAW:dataflow-not-control-flow] Best-effort text walks over `{{ … }}` blocks — no full template parse; that is the engine's compile-time job.

const TEMPLATE_BLOCK_RE = /{{([\s\S]*?)}}/g;
const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;
const DOTTED_REF_RE =
  /(?<![A-Za-z0-9_)])\.([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/g;

// Candidates only: the caller decides which resolve.
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

// The name is the string literal immediately following the `action` keyword in a code span; later display literals are preceded by a non-`action` span.
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

// [LAW:single-enforcer] One extractor for both keywords: a `picker` binds (apply, page) as its first two string args, a `menu` only its apply — so a menu's dict literals are never misread as action refs.
const PICKER_OR_MENU_ARG_RE = /\b(picker|menu)\s+$/;
export function extractPickerMenuRefs(template: string): Set<string> {
  const refs = new Set<string>();
  TEMPLATE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_BLOCK_RE.exec(template)) !== null) {
    const block = m[1]!;
    let cursor = 0;
    let pending = 0;
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

// [LAW:types-are-the-program] Names are the runtime store's exact keys; a document's
// fields are a namespace under its name that the loader cannot see into.
export interface TemplateScope {
  readonly names: ReadonlySet<string>;
  readonly documents: ReadonlySet<string>;
}

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
