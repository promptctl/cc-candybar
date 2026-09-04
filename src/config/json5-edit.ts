// [LAW:one-source-of-truth] The config FILE is the durable store for every
// value a click can persist (candybar-config-dqe) — there is no second
// machine-written file. That makes the file a document the daemon edits, not
// a value it serializes: JSON5.stringify would drop every comment, reorder
// keys, and requote strings in a format chosen FOR its comments. This module
// treats the source as text with a span map over it and rewrites exactly one
// span per edit; every byte outside that span survives verbatim.
//
// [LAW:effects-at-boundaries] Pure: text in, text out. No fs, no clock. The
// daemon's config-file store (src/daemon/config-file-store.ts) is the one
// edge that reads and writes the file.
//
// [LAW:single-enforcer] The scanner finds token BOUNDARIES only; every leaf
// (string, number, identifier word) is decoded by JSON5.parse over its own
// slice, so a string escape or number form this scanner never considered is
// still decoded exactly as the loader decodes it — one decoder, no drift.

import JSON5 from "json5";

export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface Entry {
  readonly key: string;
  readonly keySpan: Span;
  readonly value: Node;
  /** From the key's first byte to the value's last byte, exclusive. */
  readonly span: Span;
}

export interface ObjectNode {
  readonly kind: "object";
  readonly span: Span;
  readonly entries: readonly Entry[];
}

export interface ArrayNode {
  readonly kind: "array";
  readonly span: Span;
  readonly elements: readonly Node[];
}

// [LAW:types-are-the-program] The document model: only the shapes an edit
// needs to navigate (objects by key, arrays by position) carry structure;
// every scalar is a decoded value plus its span.
export type Node =
  | ObjectNode
  | ArrayNode
  | { readonly kind: "string"; readonly span: Span; readonly value: string }
  | { readonly kind: "number"; readonly span: Span; readonly value: number }
  | { readonly kind: "boolean"; readonly span: Span; readonly value: boolean }
  | { readonly kind: "null"; readonly span: Span };

export class Json5EditError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (at offset ${offset})`);
    this.name = "Json5EditError";
  }
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

const IDENT_START = /[A-Za-z_$\p{L}]/u;
const IDENT_PART = /[A-Za-z0-9_$\u200C\u200D\p{L}\p{N}]/u;
const WORD_PART = /[A-Za-z0-9_$.+\-\p{L}\p{N}]/u;
const WHITESPACE = /[\t\n\v\f\r \u00A0\uFEFF\u2028\u2029\p{Zs}]/u;

class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  peek(): string {
    return this.text[this.pos] ?? "";
  }

  fail(message: string): never {
    throw new Json5EditError(message, this.pos);
  }

  skipTrivia(): void {
    for (;;) {
      const c = this.peek();
      if (c === "") return;
      if (WHITESPACE.test(c)) {
        this.pos++;
      } else if (c === "/" && this.text[this.pos + 1] === "/") {
        const nl = this.text.indexOf("\n", this.pos);
        this.pos = nl === -1 ? this.text.length : nl;
      } else if (c === "/" && this.text[this.pos + 1] === "*") {
        const close = this.text.indexOf("*/", this.pos + 2);
        if (close === -1) this.fail("unterminated block comment");
        this.pos = close + 2;
      } else {
        return;
      }
    }
  }

  expect(c: string): void {
    if (this.peek() !== c) this.fail(`expected "${c}"`);
    this.pos++;
  }

  value(): Node {
    this.skipTrivia();
    const c = this.peek();
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") {
      const span = this.stringSpan();
      return { kind: "string", span, value: this.decode(span) as string };
    }
    if (c === "") this.fail("unexpected end of input");
    const start = this.pos;
    while (this.pos < this.text.length && WORD_PART.test(this.peek())) {
      this.pos++;
    }
    if (this.pos === start) this.fail(`unexpected character "${c}"`);
    const span = { start, end: this.pos };
    const decoded = this.decode(span);
    if (decoded === null) return { kind: "null", span };
    if (typeof decoded === "boolean") {
      return { kind: "boolean", span, value: decoded };
    }
    if (typeof decoded === "number") {
      return { kind: "number", span, value: decoded };
    }
    return this.fail(`unexpected word "${this.text.slice(start, this.pos)}"`);
  }

  // [LAW:single-enforcer] JSON5 itself decodes every leaf slice.
  private decode(span: Span): unknown {
    try {
      return JSON5.parse(this.text.slice(span.start, span.end));
    } catch (e) {
      throw new Json5EditError((e as Error).message, span.start);
    }
  }

  private stringSpan(): Span {
    const start = this.pos;
    const quote = this.peek();
    this.pos++;
    for (;;) {
      const c = this.peek();
      if (c === "") this.fail("unterminated string");
      if (c === "\\") {
        // A line continuation may be CRLF: skip the backslash and the whole
        // terminator so the LF is not mistaken for an unterminated string.
        const crlf = this.text.startsWith("\r\n", this.pos + 1);
        this.pos += crlf ? 3 : 2;
        continue;
      }
      this.pos++;
      if (c === quote) return { start, end: this.pos };
      if (c === "\n") this.fail("unterminated string");
    }
  }

  private key(): { key: string; span: Span } {
    const c = this.peek();
    if (c === '"' || c === "'") {
      const span = this.stringSpan();
      return { key: this.decode(span) as string, span };
    }
    const start = this.pos;
    if (!IDENT_START.test(c)) this.fail("expected an object key");
    while (this.pos < this.text.length && IDENT_PART.test(this.peek())) {
      this.pos++;
    }
    return {
      key: this.text.slice(start, this.pos),
      span: { start, end: this.pos },
    };
  }

  private object(): ObjectNode {
    const start = this.pos;
    this.expect("{");
    const entries: Entry[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === "}") break;
      const { key, span: keySpan } = this.key();
      this.skipTrivia();
      this.expect(":");
      const value = this.value();
      entries.push({
        key,
        keySpan,
        value,
        span: { start: keySpan.start, end: value.span.end },
      });
      this.skipTrivia();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() !== "}") this.fail('expected "," or "}"');
    }
    this.expect("}");
    return { kind: "object", span: { start, end: this.pos }, entries };
  }

  private array(): ArrayNode {
    const start = this.pos;
    this.expect("[");
    const elements: Node[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === "]") break;
      elements.push(this.value());
      this.skipTrivia();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() !== "]") this.fail('expected "," or "]"');
    }
    this.expect("]");
    return { kind: "array", span: { start, end: this.pos }, elements };
  }
}

/**
 * Parse a whole JSON5 document into a span-carrying node tree. Throws
 * Json5EditError on any syntax error — the loader already accepted this text,
 * so a failure here means the file changed underneath the daemon.
 */
export function parseDocument(text: string): Node {
  const s = new Scanner(text);
  const root = s.value();
  s.skipTrivia();
  if (s.pos !== text.length) s.fail("trailing content after the document");
  return root;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export function entryOf(node: Node, key: string): Entry | undefined {
  return node.kind === "object"
    ? node.entries.find((e) => e.key === key)
    : undefined;
}

/** The node at an object path, or undefined where any step is absent. */
export function nodeAt(root: Node, path: readonly string[]): Node | undefined {
  let node: Node | undefined = root;
  for (const key of path) {
    node = node === undefined ? undefined : entryOf(node, key)?.value;
  }
  return node;
}

export function textOf(text: string, node: Node): string {
  return text.slice(node.span.start, node.span.end);
}

// ─── Text generation ─────────────────────────────────────────────────────────

const IDENT_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function keyText(key: string): string {
  return IDENT_KEY.test(key) ? key : JSON.stringify(key);
}

/**
 * A JSON value as JSON5 text — identifier keys unquoted, one member per line,
 * two-space indent — so materialized text (a bundled segment decl, a layout
 * tree) reads like the authored surface rather than JSON.stringify output.
 * The result is indented from column zero; nest it with `reindent`.
 */
export function json5Text(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `  ${reindent(json5Text(v), "  ")},`);
    return `[\n${items.join("\n")}\n]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return "{}";
    const items = entries.map(
      ([k, v]) => `  ${keyText(k)}: ${reindent(json5Text(v), "  ")},`,
    );
    return `{\n${items.join("\n")}\n}`;
  }
  return JSON.stringify(value);
}

/** Indent every line after the first by `indent` (nesting a multi-line value). */
export function reindent(valueText: string, indent: string): string {
  return valueText.split("\n").join(`\n${indent}`);
}

/** `key: value` for a path's steps, nesting one object per intermediate step. */
function entryText(path: readonly string[], valueText: string): string {
  const [head, ...rest] = path as [string, ...string[]];
  const inner =
    rest.length === 0
      ? valueText
      : `{\n  ${reindent(entryText(rest, valueText), "  ")},\n}`;
  return `${keyText(head)}: ${inner}`;
}

// ─── Splicing ────────────────────────────────────────────────────────────────

function splice(
  text: string,
  start: number,
  end: number,
  insert: string,
): string {
  return text.slice(0, start) + insert + text.slice(end);
}

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function isBlank(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/** Leading whitespace of the line containing `offset`. */
function indentOfLine(text: string, offset: number): string {
  const ls = lineStartOf(text, offset);
  return /^[ \t]*/.exec(text.slice(ls))![0];
}

/** True when nothing but whitespace precedes `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
  return isBlank(text.slice(lineStartOf(text, offset), offset));
}

/**
 * The bytes right after a member span: an optional comma, then whether the
 * rest of the line holds nothing but an optional line comment. `lineEnd` is
 * the offset of that line's newline (or the text's end) when so, -1 otherwise.
 */
function trailerAfter(
  text: string,
  end: number,
): { commaEnd: number; lineEnd: number } {
  let i = end;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  const commaEnd = text[i] === "," ? i + 1 : -1;
  if (commaEnd !== -1) i = commaEnd;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  if (text.startsWith("//", i)) {
    const nl = text.indexOf("\n", i);
    i = nl === -1 ? text.length : nl;
  }
  const lineEnd = i === text.length || text[i] === "\n" ? i : -1;
  return { commaEnd, lineEnd };
}

/**
 * Remove a member span (an object entry or an array element) together with
 * its separator. A member alone on its line(s) — nothing but whitespace
 * before it, nothing but an optional comma and line comment after it — takes
 * its whole lines with it, so no blank line is left behind; an inline member
 * takes one adjacent comma and the spaces beside it.
 */
function removeMember(text: string, span: Span): string {
  const { commaEnd, lineEnd } = trailerAfter(text, span.end);
  if (startsLine(text, span.start) && lineEnd !== -1) {
    const ls = lineStartOf(text, span.start);
    return splice(text, ls, Math.min(lineEnd + 1, text.length), "");
  }
  if (commaEnd !== -1) {
    let end = commaEnd;
    while (end < text.length && text[end] === " ") end++;
    return splice(text, span.start, end, "");
  }
  let start = span.start;
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) {
    start--;
  }
  if (text[start - 1] === ",") return splice(text, start - 1, span.end, "");
  return splice(text, span.start, span.end, "");
}

/**
 * Insert `memberText` as its own line after the member at `span`, which ends
 * its line (trailerAfter's lineEnd !== -1). The new line goes AFTER any
 * trailing line comment — that comment belongs to the existing member and
 * stays on its line — and mirrors the member's trailing-comma style.
 */
function insertLineAfter(
  text: string,
  span: Span,
  memberText: string,
  indent: string,
): string {
  const { commaEnd, lineEnd } = trailerAfter(text, span.end);
  const hasComma = commaEnd !== -1;
  const withComma = hasComma ? text : splice(text, span.end, span.end, ",");
  const at = lineEnd + (hasComma ? 0 : 1);
  const line = `\n${indent}${reindent(memberText, indent)}${hasComma ? "," : ""}`;
  return splice(withComma, at, at, line);
}

/**
 * Add a member after the last existing one, matching the container's own
 * style: its indentation, one-member-per-line versus inline, and whether it
 * uses trailing commas. An empty container opens onto a new indented line.
 */
function appendMember(
  text: string,
  container: ObjectNode | ArrayNode,
  memberText: string,
): string {
  const members: ReadonlyArray<{ span: Span }> =
    container.kind === "object" ? container.entries : container.elements;
  const last = members[members.length - 1];
  const baseIndent = indentOfLine(text, container.span.start);
  if (last === undefined) {
    const inner = baseIndent + "  ";
    return splice(
      text,
      container.span.start + 1,
      container.span.end - 1,
      `\n${inner}${reindent(memberText, inner)},\n${baseIndent}`,
    );
  }
  const { commaEnd, lineEnd } = trailerAfter(text, last.span.end);
  if (startsLine(text, last.span.start) && lineEnd !== -1) {
    const indent = text.slice(
      lineStartOf(text, last.span.start),
      last.span.start,
    );
    return insertLineAfter(text, last.span, memberText, indent);
  }
  const at = commaEnd === -1 ? last.span.end : commaEnd;
  const sep = commaEnd === -1 ? ", " : " ";
  const tail = commaEnd === -1 ? "" : ",";
  return splice(text, at, at, `${sep}${memberText}${tail}`);
}

/**
 * Set the value at an object path, creating every missing object along the
 * way. An existing value is replaced within its own span; a new entry is
 * appended to the deepest existing object. An empty document becomes a
 * one-entry object.
 */
export function setValue(
  text: string,
  path: readonly string[],
  valueText: string,
): string {
  if (path.length === 0) {
    throw new Json5EditError("setValue needs a non-empty path", 0);
  }
  if (/^\s*$/.test(text)) {
    return `{\n  ${reindent(entryText(path, valueText), "  ")},\n}\n`;
  }
  let node: Node = parseDocument(text);
  for (let i = 0; i < path.length; i++) {
    if (node.kind !== "object") {
      throw new Json5EditError(
        `cannot set ${path.join(".")}: ${path.slice(0, i).join(".") || "the document"} is not an object`,
        node.span.start,
      );
    }
    const entry = entryOf(node, path[i]!);
    if (entry === undefined) {
      return appendMember(text, node, entryText(path.slice(i), valueText));
    }
    if (i === path.length - 1) {
      const indent = indentOfLine(text, entry.keySpan.start);
      return splice(
        text,
        entry.value.span.start,
        entry.value.span.end,
        reindent(valueText, indent),
      );
    }
    node = entry.value;
  }
  throw new Json5EditError("unreachable: path exhausted", 0);
}

/** Delete the entry at an object path. An absent path returns the text unchanged. */
export function deleteValue(text: string, path: readonly string[]): string {
  if (path.length === 0) {
    throw new Json5EditError("deleteValue needs a non-empty path", 0);
  }
  if (/^\s*$/.test(text)) return text;
  const parent = nodeAt(parseDocument(text), path.slice(0, -1));
  const entry =
    parent === undefined ? undefined : entryOf(parent, path[path.length - 1]!);
  return entry === undefined ? text : removeMember(text, entry.span);
}

// ─── Layout tree edits on the authored (shape-grammar) tree ─────────────────

// [LAW:one-source-of-truth] The raw layout grammar the loader accepts
// (src/config/loader/layout.ts): a bare string names a segment; `{ seg }` and
// `{ kind: "segment", name }` name one with options; `h`/`v`/`children`
// arrays hold the children of a container or group. Edits address a segment
// by NAME, in the same pre-order the lowered-tree walk uses, so an op that
// removes the first `weekly` removes the one the bar shows first.
const CHILD_KEYS = ["h", "v", "children"] as const;

function segmentNameOf(node: Node): string | undefined {
  if (node.kind === "string") return node.value;
  if (node.kind !== "object") return undefined;
  const seg = entryOf(node, "seg")?.value;
  if (seg?.kind === "string") return seg.value;
  const kind = entryOf(node, "kind")?.value;
  const name = entryOf(node, "name")?.value;
  return kind?.kind === "string" &&
    kind.value === "segment" &&
    name?.kind === "string"
    ? name.value
    : undefined;
}

function childArraysOf(node: Node): readonly ArrayNode[] {
  if (node.kind !== "object") return [];
  return CHILD_KEYS.map((k) => entryOf(node, k)?.value).filter(
    (v): v is ArrayNode => v?.kind === "array",
  );
}

// [LAW:types-are-the-program] A layout root is one of two shapes: a container
// (an `h`/`v`/`children` array to splice) or the bare segment ref a bare
// string / `{ seg }` object spells. The loader accepts both at a preset root
// and edit chrome decorates both with `-`/`+`, but only the first has an
// array to address. A bare ref IS the one-child horizontal container it
// abbreviates, so it is rewritten as one here — the original text kept
// verbatim as the sole child, its own `when` included — and the splices
// below are total over every legal root: normalized once, never branched on
// per site. The rewrite is only committed by an edit that then finds its
// target, so a miss leaves the file untouched.
function containerAt(
  text: string,
  rootPath: readonly string[],
): { text: string; root: Node } | null {
  const root = nodeAt(parseDocument(text), rootPath);
  if (root === undefined) return null;
  if (childArraysOf(root).length > 0) return { text, root };
  const wrapped = setValue(text, rootPath, `{ h: [${textOf(text, root)}] }`);
  return { text: wrapped, root: nodeAt(parseDocument(wrapped), rootPath)! };
}

/** The array holding the first segment ref named `name`, and its index. */
function findSegmentRef(
  root: Node,
  name: string,
): { array: ArrayNode; index: number } | null {
  for (const array of childArraysOf(root)) {
    for (const [index, child] of array.elements.entries()) {
      if (segmentNameOf(child) === name) return { array, index };
      const deeper = findSegmentRef(child, name);
      if (deeper !== null) return deeper;
    }
  }
  return null;
}

/**
 * Remove the first segment ref named `target` from the layout tree rooted at
 * `rootPath`. Returns the edited text, or null when the tree holds no such
 * ref — the caller decides whether that is an error.
 */
export function removeSegmentRef(
  text: string,
  rootPath: readonly string[],
  target: string,
): string | null {
  const tree = containerAt(text, rootPath);
  if (tree === null) return null;
  const hit = findSegmentRef(tree.root, target);
  if (hit === null) return null;
  return removeMember(tree.text, hit.array.elements[hit.index]!.span);
}

/**
 * Insert a bare-string segment ref named `segment` immediately before or
 * after the first ref named `anchor`. A ref alone on its line gets its own
 * line at the same indentation; an inline ref gets an inline sibling.
 * Returns null when the anchor is absent.
 */
export function insertSegmentRef(
  text: string,
  rootPath: readonly string[],
  segment: string,
  anchor: string,
  relation: "before" | "after",
): string | null {
  const tree = containerAt(text, rootPath);
  if (tree === null) return null;
  const hit = findSegmentRef(tree.root, anchor);
  if (hit === null) return null;
  const src = tree.text;
  const ref = hit.array.elements[hit.index]!;
  const newText = JSON.stringify(segment);
  const { lineEnd } = trailerAfter(src, ref.span.end);
  if (startsLine(src, ref.span.start) && lineEnd !== -1) {
    const indent = src.slice(lineStartOf(src, ref.span.start), ref.span.start);
    return relation === "after"
      ? insertLineAfter(src, ref.span, newText, indent)
      : splice(src, ref.span.start, ref.span.start, `${newText},\n${indent}`);
  }
  const refText = textOf(src, ref);
  const pair =
    relation === "before" ? `${newText}, ${refText}` : `${refText}, ${newText}`;
  return splice(src, ref.span.start, ref.span.end, pair);
}
