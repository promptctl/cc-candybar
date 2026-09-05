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
      // [LAW:parse-dont-validate] JSON5 reads the LAST duplicate; an edit
      // here would address one and leave the other live.
      if (entries.some((e) => e.key === key)) {
        throw new Json5EditError(`duplicate key "${key}"`, keySpan.start);
      }
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
 * The dialect SYNTHESIZED text is written in — a fact about the file's
 * consumer, which neither the text nor its path can tell the splicer: the
 * cc-candybar loader reads `.json` and `.json5` alike through the JSON5 parser,
 * so bare keys and trailing commas are legal in either; Claude Code reads its
 * settings.json strictly, so there they are corruption. Edits that mirror an
 * existing member's style (insertLineAfter) need no dialect — a JSON file has
 * no trailing comma to mirror — so the dialect reaches only the text minted
 * with no neighbour to copy: a key, and the comma after a container's last
 * member. [LAW:one-type-per-behavior] One splicer, two values.
 * [LAW:dataflow-not-control-flow] The same synthesis runs for both; the
 * dialect is data it reads, never a branch it takes.
 *
 * `parse` is the same fact read in the other direction: a reader that accepts
 * more than the file's consumer does would call a file readable that the
 * consumer refuses, and then splice into it [LAW:one-source-of-truth].
 */
export interface Dialect {
  readonly key: (key: string) => string;
  readonly trailingComma: "," | "";
  readonly parse: (text: string) => unknown;
}

export const JSON5_DIALECT: Dialect = {
  key: keyText,
  trailingComma: ",",
  parse: (text) => JSON5.parse(text),
};
export const JSON_DIALECT: Dialect = {
  key: (key) => JSON.stringify(key),
  trailingComma: "",
  parse: (text) => JSON.parse(text),
};

/**
 * A JSON value as JSON5 text — identifier keys unquoted, one member per line,
 * two-space indent — so materialized text (a bundled segment decl, a layout
 * tree) reads like the authored surface rather than JSON.stringify output.
 * The result is indented from column zero; nest it with `reindent`.
 */
export function json5Text(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `  ${reindent(json5Text(v), "  ", "\n")},`);
    return `[\n${items.join("\n")}\n]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return "{}";
    const items = entries.map(
      ([k, v]) => `  ${keyText(k)}: ${reindent(json5Text(v), "  ", "\n")},`,
    );
    return `{\n${items.join("\n")}\n}`;
  }
  return JSON.stringify(value);
}

/** The document's line terminator: CRLF when it uses one anywhere, else LF. */
function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Indent every line after the first by `indent` (nesting a multi-line value)
 * and end each on `eol`. [LAW:single-enforcer] Synthesized text is built on
 * LF; this is the one place it takes the document's own terminator.
 */
export function reindent(
  valueText: string,
  indent: string,
  eol: string,
): string {
  return valueText.split("\n").join(`${eol}${indent}`);
}

/** `key: value` for a path's steps, nesting one object per intermediate step. */
function entryText(
  path: readonly string[],
  valueText: string,
  dialect: Dialect,
): string {
  const [head, ...rest] = path as [string, ...string[]];
  const inner =
    rest.length === 0
      ? valueText
      : `{\n  ${reindent(entryText(rest, valueText, dialect), "  ", "\n")}${dialect.trailingComma}\n}`;
  return `${dialect.key(head)}: ${inner}`;
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

/** An optional line comment, then the line's terminator (CRLF, LF, or the text's end). */
const LINE_TRAILER = /(?:\/\/[^\n]*?)?(\r\n|\n|$)/y;

/** Where a line ends: its terminator's start, and the next line's start (both EOF at the text's end). */
interface LineEnd {
  readonly at: number;
  readonly next: number;
}

/**
 * The bytes right after a member span: an optional comma, then the line's
 * end when the rest of the line holds nothing but an optional line comment,
 * else null.
 */
function trailerAfter(
  text: string,
  end: number,
): { commaEnd: number; line: LineEnd | null } {
  let i = end;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  const commaEnd = text[i] === "," ? i + 1 : -1;
  if (commaEnd !== -1) i = commaEnd;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  LINE_TRAILER.lastIndex = i;
  const m = LINE_TRAILER.exec(text);
  if (m === null) return { commaEnd, line: null };
  const next = i + m[0].length;
  return { commaEnd, line: { at: next - m[1]!.length, next } };
}

/**
 * Remove a member span (an object entry or an array element) together with
 * its separator. A member alone on its line(s) — nothing but whitespace
 * before it, nothing but an optional comma and line comment after it — takes
 * its whole lines with it, so no blank line is left behind; an inline member
 * takes one adjacent comma and the spaces beside it.
 */
function removeMember(text: string, span: Span): string {
  const { commaEnd, line } = trailerAfter(text, span.end);
  if (startsLine(text, span.start) && line !== null) {
    return splice(text, lineStartOf(text, span.start), line.next, "");
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
 * Insert `memberText` as its own line after the member at `span`, whose
 * trailer ends its line. The new line goes AFTER any trailing line comment —
 * that comment belongs to the existing member and stays on its line — and
 * mirrors the member's trailing-comma style.
 */
function insertLineAfter(
  text: string,
  span: Span,
  trailer: { commaEnd: number; line: LineEnd },
  memberText: string,
  indent: string,
): string {
  const hasComma = trailer.commaEnd !== -1;
  const withComma = hasComma ? text : splice(text, span.end, span.end, ",");
  const at = trailer.line.at + (hasComma ? 0 : 1);
  const eol = eolOf(text);
  const line = `${eol}${indent}${reindent(memberText, indent, eol)}${hasComma ? "," : ""}`;
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
  dialect: Dialect,
): string {
  const members: ReadonlyArray<{ span: Span }> =
    container.kind === "object" ? container.entries : container.elements;
  const last = members[members.length - 1];
  const baseIndent = indentOfLine(text, container.span.start);
  if (last === undefined) {
    const inner = baseIndent + "  ";
    const eol = eolOf(text);
    return splice(
      text,
      container.span.start + 1,
      container.span.end - 1,
      `${eol}${inner}${reindent(memberText, inner, eol)}${dialect.trailingComma}${eol}${baseIndent}`,
    );
  }
  const { commaEnd, line } = trailerAfter(text, last.span.end);
  if (startsLine(text, last.span.start) && line !== null) {
    const indent = text.slice(
      lineStartOf(text, last.span.start),
      last.span.start,
    );
    return insertLineAfter(
      text,
      last.span,
      { commaEnd, line },
      memberText,
      indent,
    );
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
  dialect: Dialect,
): string {
  if (path.length === 0) {
    throw new Json5EditError("setValue needs a non-empty path", 0);
  }
  if (/^\s*$/.test(text)) {
    const eol = eolOf(text);
    return `{${eol}  ${reindent(entryText(path, valueText, dialect), "  ", eol)}${dialect.trailingComma}${eol}}${eol}`;
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
      return appendMember(
        text,
        node,
        entryText(path.slice(i), valueText, dialect),
        dialect,
      );
    }
    if (i === path.length - 1) {
      const indent = indentOfLine(text, entry.keySpan.start);
      return splice(
        text,
        entry.value.span.start,
        entry.value.span.end,
        reindent(valueText, indent, eolOf(text)),
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
// arrays hold the children of a container or group; a root's `rows` object
// holds its named rows, each any layout node. Edits address a segment by
// NAME, in the same pre-order the lowered-tree walk uses, so an op that
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

/**
 * The named rows of a `{ rows }` root fragment, or null when the node is a
 * whole tree — the same discriminator the loader reads (`"rows" in fragment`,
 * src/config/root.ts), on the document.
 */
export function rowEntriesOf(node: Node): readonly Entry[] | null {
  const rows = entryOf(node, "rows")?.value;
  return rows?.kind === "object" ? rows.entries : null;
}

/**
 * Whether a root fragment restages anything — false exactly for the merge's
 * identity, an empty rows map carrying no own field — root.ts's `restages`
 * read off the document, so the file store and the loader classify one
 * fragment alike: a tree restages, and so does any entry beside `rows`,
 * exactly as any own field beside `rows` does there. [LAW:one-source-of-truth]
 * the two are one predicate on two substrates; change them together.
 */
export function restagesFragment(node: Node): boolean {
  if (node.kind !== "object") return true;
  const rows = rowEntriesOf(node);
  return (
    rows === null ||
    rows.length > 0 ||
    node.entries.some((entry) => entry.key !== "rows")
  );
}

// [LAW:types-are-the-program] Every node of a layout fragment in pre-order,
// each with the config-file path it can be REWRITTEN at when it is a bare
// segment ref — the fragment itself, or one member of its `rows` map — and
// null for an array element, which is spliced in place. A bare ref IS the
// one-child horizontal container it abbreviates; the walk carries the
// address so `refAt` can normalize exactly that one ref and nothing beside
// it.
function* nodesIn(
  node: Node,
  bareAt: readonly string[] | null,
): IterableIterator<{ node: Node; bareAt: readonly string[] | null }> {
  yield { node, bareAt };
  for (const array of childArraysOf(node)) {
    for (const child of array.elements) yield* nodesIn(child, null);
  }
  for (const row of rowEntriesOf(node) ?? []) {
    yield* nodesIn(
      row.value,
      bareAt === null ? null : [...bareAt, "rows", row.key],
    );
  }
}

/** Whether the fragment holds a segment ref named `name`, anywhere. */
export function hasSegmentRef(root: Node, name: string): boolean {
  for (const { node } of nodesIn(root, null)) {
    if (segmentNameOf(node) === name) return true;
  }
  return false;
}

// [LAW:one-source-of-truth] The first segment ref named `name` under the
// fragment at `rootPath`, as an array element — normalized once, here, so the
// splices below are total over every legal shape. A ref that is the whole
// fragment (`root: "directory"`) or a whole row (`rows: { sys: "demo" }`)
// is rewritten as the one-child container it abbreviates — the original text
// kept verbatim as the sole child, its own `when` included — and found again
// inside it; every other byte, every other row, stays untouched. The rewrite
// is only committed by an edit that then finds its target, so a miss leaves
// the file as it was.
function refAt(
  text: string,
  rootPath: readonly string[],
  name: string,
): { text: string; ref: Node } | null {
  const root = nodeAt(parseDocument(text), rootPath);
  if (root === undefined) return null;
  for (const { node, bareAt } of nodesIn(root, rootPath)) {
    if (segmentNameOf(node) !== name) continue;
    if (bareAt === null) return { text, ref: node };
    const wrapped = setValue(
      text,
      bareAt,
      `{ h: [${textOf(text, node)}] }`,
      JSON5_DIALECT,
    );
    return refAt(wrapped, rootPath, name);
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
  const hit = refAt(text, rootPath, target);
  return hit === null ? null : removeMember(hit.text, hit.ref.span);
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
  const hit = refAt(text, rootPath, anchor);
  if (hit === null) return null;
  const { text: src, ref } = hit;
  const newText = JSON.stringify(segment);
  const { commaEnd, line } = trailerAfter(src, ref.span.end);
  if (startsLine(src, ref.span.start) && line !== null) {
    const indent = src.slice(lineStartOf(src, ref.span.start), ref.span.start);
    return relation === "after"
      ? insertLineAfter(src, ref.span, { commaEnd, line }, newText, indent)
      : splice(
          src,
          ref.span.start,
          ref.span.start,
          `${newText},${eolOf(src)}${indent}`,
        );
  }
  const refText = textOf(src, ref);
  const pair =
    relation === "before" ? `${newText}, ${refText}` : `${refText}, ${newText}`;
  return splice(src, ref.span.start, ref.span.end, pair);
}
