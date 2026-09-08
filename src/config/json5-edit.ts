// [LAW:one-source-of-truth] The config file is the durable store, so it is a document
// this module edits: exactly one span is rewritten, every other byte survives verbatim.

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
        // A line continuation may be CRLF: skip the whole terminator.
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
      // [LAW:parse-dont-validate] JSON5 reads the LAST duplicate; an edit would address one.
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

export function parseDocument(text: string): Node {
  const s = new Scanner(text);
  const root = s.value();
  s.skipTrivia();
  if (s.pos !== text.length) s.fail("trailing content after the document");
  return root;
}

export function entryOf(node: Node, key: string): Entry | undefined {
  return node.kind === "object"
    ? node.entries.find((e) => e.key === key)
    : undefined;
}

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

const IDENT_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function keyText(key: string): string {
  return IDENT_KEY.test(key) ? key : JSON.stringify(key);
}

/** The dialect SYNTHESIZED text is written in: JSON5 for cc-candybar's own config,
 * strict JSON for settings.json. [LAW:one-type-per-behavior] One splicer, two values. */
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

/** A JSON value as JSON5 text — unquoted identifier keys, one member per line. */
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

/** [LAW:single-enforcer] The one place synthesized LF text takes the document's terminator. */
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

function indentOfLine(text: string, offset: number): string {
  const ls = lineStartOf(text, offset);
  return /^[ \t]*/.exec(text.slice(ls))![0];
}

function startsLine(text: string, offset: number): boolean {
  return isBlank(text.slice(lineStartOf(text, offset), offset));
}

/** An optional line comment, then the line's terminator (CRLF, LF, or the text's end). */
const LINE_TRAILER = /(?:\/\/[^\n]*?)?(\r\n|\n|$)/y;

interface LineEnd {
  readonly at: number;
  readonly next: number;
}

/** After a member span: an optional comma, then the line's end when only a comment follows. */
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

/** Remove a member span with its separator; a member alone on its line takes its lines. */
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

/** Insert `memberText` as its own line, AFTER any trailing comment on the member's line. */
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

/** Add a member after the last, matching the container's indentation and comma style. */
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

/** Set the value at an object path, creating missing objects; an empty doc becomes one entry. */
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

// [LAW:one-source-of-truth] Edits address a segment by NAME, in the loader's own pre-order.
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

/** The named rows of a `{ rows }` root fragment, or null when the node is a whole tree. */
export function rowEntriesOf(node: Node): readonly Entry[] | null {
  const rows = entryOf(node, "rows")?.value;
  return rows?.kind === "object" ? rows.entries : null;
}

/** [LAW:one-source-of-truth] root.ts's `restages` read off the document; change them together. */
export function restagesFragment(node: Node): boolean {
  if (node.kind !== "object") return true;
  const rows = rowEntriesOf(node);
  return (
    rows === null ||
    rows.length > 0 ||
    node.entries.some((entry) => entry.key !== "rows")
  );
}

// [LAW:types-are-the-program] Pre-order nodes, each with the path a bare ref is rewritten at.
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

export function hasSegmentRef(root: Node, name: string): boolean {
  for (const { node } of nodesIn(root, null)) {
    if (segmentNameOf(node) === name) return true;
  }
  return false;
}

// [LAW:one-source-of-truth] Normalized to an array element so the splices below are total.
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

/** Remove the first segment ref named `target`; null when the tree holds no such ref. */
export function removeSegmentRef(
  text: string,
  rootPath: readonly string[],
  target: string,
): string | null {
  const hit = refAt(text, rootPath, target);
  return hit === null ? null : removeMember(hit.text, hit.ref.span);
}

/** Insert a bare-string ref before/after the first ref named `anchor`; null when absent. */
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
