// [LAW:single-enforcer] A config write as data: the changes that take a file's
// text from what a click read to what it wrote, each at a setting's address
// and carrying what the click read there. The renderer makes them, and the
// host applies them to the file as it stands, refusing the whole list when a
// setting it read has moved since. The guard is per setting, so a write to
// another part of a file many sessions share never refuses one.
//
// [LAW:effects-at-boundaries] Pure: text in, text out, over the span editor
// (src/config/json5-edit.ts), so every byte a change does not touch survives,
// comments included.

import JSON5 from "json5";
import {
  deleteValue,
  insertValue,
  JSON5_DIALECT,
  movableTextOf,
  nodeAt,
  parseDocument,
  setValue,
  textOf,
  Json5EditError,
  type Dialect,
  type Node,
  type ObjectNode,
} from "./json5-edit.js";

// A setting's address: object keys from the document's root. The empty
// address is the document. An array is addressed whole, so a layout edit is
// guarded per row.
export type Address = readonly string[];

// What a change read at its address: a setting's text, the whole file's
// bytes, or nothing there. Two settings agree when their texts decode to the
// same value, so a hand edit that only reformats a setting has not moved it.
// The whole file is read as bytes, since a file that does not parse has no
// settings to compare. Text, so a read crosses a process whatever JSON5 value
// it holds.
export type Read =
  | { readonly kind: "value"; readonly text: string }
  | { readonly kind: "file"; readonly text: string }
  | { readonly kind: "absent" };

// [LAW:types-are-the-program] A value is JSON5 text, not a decoded value, so
// a copied row keeps its comments and an inline placement stays inline. An
// insert reads nothing there, and goes back where the written text holds it:
// before the member it `precedes`, or last.
export type Change =
  | {
      readonly op: "replace";
      readonly at: Address;
      readonly text: string;
      readonly read: Read;
    }
  | {
      readonly op: "insert";
      readonly at: Address;
      readonly text: string;
      readonly precedes: string | null;
    }
  | { readonly op: "remove"; readonly at: Address; readonly read: Read };

export type Applied =
  | { readonly kind: "applied"; readonly text: string | null }
  // The first address that moved: what the change read there (`object` for
  // an ancestor it needed to hold the setting), and what is there instead.
  | {
      readonly kind: "moved";
      readonly at: Address;
      readonly read: Read | "object";
      readonly found: Read;
    };

const ABSENT: Read = { kind: "absent" };

// [LAW:types-are-the-program] An absent file holds none. One holding only
// whitespace is empty: an object with no members, as every reader of a config
// or a settings file reads it, with no text a span could point into. Text the
// span editor refuses is unparsed: a change can only replace it whole.
type Parsed =
  | { readonly kind: "none" }
  | { readonly kind: "empty" }
  | { readonly kind: "unparsed" }
  | { readonly kind: "document"; readonly root: Node };

function parse(text: string | null): Parsed {
  if (text === null) return { kind: "none" };
  if (/^\s*$/.test(text)) return { kind: "empty" };
  try {
    return { kind: "document", root: parseDocument(text) };
  } catch (e) {
    if (!(e instanceof Json5EditError)) throw e;
    return { kind: "unparsed" };
  }
}

// What is at `at` in `text`. [LAW:no-silent-failure] A setting in a file that
// no longer parses is not there to agree with what was read, so the file's
// bytes are what was found.
function readAt(text: string | null, parsed: Parsed, at: Address): Read {
  if (text === null) return ABSENT;
  if (at.length === 0) return { kind: "file", text };
  switch (parsed.kind) {
    case "empty":
      return ABSENT;
    case "document":
      return readOf(text, nodeAt(parsed.root, at));
    default:
      return { kind: "file", text };
  }
}

function readOf(text: string, node: Node | undefined): Read {
  return node === undefined
    ? ABSENT
    : { kind: "value", text: movableTextOf(text, node) };
}

function sameRead(a: Read, b: Read): boolean {
  if (a.kind === "value" && b.kind === "value")
    return sameValue(JSON5.parse(a.text), JSON5.parse(b.text));
  if (a.kind === "file" && b.kind === "file") return a.text === b.text;
  return a.kind === "absent" && b.kind === "absent";
}

// Two decoded JSON5 values are the same value. A JSON5 value is null, a
// boolean, a number (NaN equal to itself), a string, an array or a plain
// object, so this needs no runtime's deep equality.
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (k) =>
        Object.hasOwn(b, k) &&
        sameValue(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
}

/**
 * The changes that take `before` to `after`: one per setting that differs,
 * down to the first level where either side is not an object, and the whole
 * value of an object whose members do not rebuild it. When the changes do not
 * rebuild `after` byte for byte (a comment outside the root edited), the
 * change is the whole document, read whole. So is a change to or from a file
 * that does not parse, or one holding nothing.
 */
export function diffChanges(
  before: string | null,
  after: string | null,
): readonly Change[] {
  if (before === after) return [];
  if (before === null)
    return [{ op: "insert", at: [], text: after!, precedes: null }];
  const read: Read = { kind: "file", text: before };
  if (after === null) return [{ op: "remove", at: [], read }];
  const whole: readonly Change[] = [
    { op: "replace", at: [], text: after, read },
  ];
  const was = parse(before);
  const will = parse(after);
  if (was.kind !== "document" || will.kind !== "document") return whole;
  const members = diffNode([], before, was.root, after, will.root);
  const rebuilt = applyChanges(before, members);
  return rebuilt.kind === "applied" && rebuilt.text === after ? members : whole;
}

// [LAW:single-enforcer] Each object's members are its change only when they
// rebuild its written text byte for byte; when they do not (an emptied
// object's braces, members reordered, a comment between them edited), the
// change is the object's whole value. So a change is as narrow as what
// rebuilds, and an edit elsewhere in the file never refuses it.
function diffNode(
  at: Address,
  beforeText: string,
  was: Node,
  afterText: string,
  will: Node,
): Change[] {
  const written = textOf(afterText, will);
  if (textOf(beforeText, was) === written) return [];
  const whole: Change[] =
    at.length === 0
      ? [
          {
            op: "replace",
            at,
            text: afterText,
            read: { kind: "file", text: beforeText },
          },
        ]
      : [
          {
            op: "replace",
            at,
            text: movableTextOf(afterText, will),
            read: readOf(beforeText, was),
          },
        ];
  if (was.kind !== "object" || will.kind !== "object") return whole;
  const members = diffMembers(at, beforeText, was, afterText, will);
  return rebuilds(beforeText, members, at, written) ? members : whole;
}

// Whether `changes` leave the setting at `at` written as `written`.
function rebuilds(
  text: string,
  changes: readonly Change[],
  at: Address,
  written: string,
): boolean {
  const result = applyChanges(text, changes);
  if (result.kind !== "applied") return false;
  const parsed = parse(result.text);
  if (parsed.kind !== "document") return false;
  const node = nodeAt(parsed.root, at);
  return node !== undefined && textOf(result.text!, node) === written;
}

function diffMembers(
  at: Address,
  beforeText: string,
  was: ObjectNode,
  afterText: string,
  will: ObjectNode,
): Change[] {
  const prior = new Map(was.entries.map((e) => [e.key, e.value] as const));
  const kept = new Set(will.entries.map((e) => e.key));
  const gone = was.entries
    .filter((e) => !kept.has(e.key))
    .map(
      (e): Change => ({
        op: "remove",
        at: [...at, e.key],
        read: readOf(beforeText, e.value),
      }),
    );
  // An inserted member goes before the next member the written text holds
  // that was already there, so a removed key restored goes back in place.
  const anchors = will.entries.map((e, i) => {
    const next = will.entries.slice(i + 1).find((n) => prior.has(n.key));
    return next?.key ?? null;
  });
  const changed = will.entries.flatMap((e, i): Change[] => {
    const old = prior.get(e.key);
    return old === undefined
      ? [
          {
            op: "insert",
            at: [...at, e.key],
            text: movableTextOf(afterText, e.value),
            precedes: anchors[i]!,
          },
        ]
      : diffNode([...at, e.key], beforeText, old, afterText, e.value);
  });
  return [...gone, ...changed];
}

/**
 * `changes` applied to `text` in order, each checked against the document as
 * it then stands. A setting that moved, or an ancestor a change needs that is
 * no longer an object, refuses the whole list. `dialect` is the document's:
 * a cc-candybar config is JSON5, and Claude Code parses its settings as
 * strict JSON, so a splice there quotes its keys and leaves no trailing comma.
 */
export function applyChanges(
  text: string | null,
  changes: readonly Change[],
  dialect: Dialect = JSON5_DIALECT,
): Applied {
  let current = text;
  for (const change of changes) {
    const parsed = parse(current);
    const ancestor = movedAncestor(parsed, change.at);
    if (ancestor !== null)
      return {
        kind: "moved",
        at: ancestor,
        read: "object",
        found: readAt(current, parsed, ancestor),
      };
    const read = change.op === "insert" ? ABSENT : change.read;
    const found = readAt(current, parsed, change.at);
    if (!sameRead(found, read))
      return { kind: "moved", at: change.at, read, found };
    current = applied(current, change, dialect);
  }
  return { kind: "applied", text: current };
}

// The first ancestor of a setting that is not an object holding it, or null
// when every one is. The document is the first ancestor of every setting.
function movedAncestor(parsed: Parsed, at: Address): Address | null {
  if (at.length === 0) return null;
  // An empty document is an object holding nothing, so only its own members
  // have every ancestor.
  if (parsed.kind === "empty") return at.length === 1 ? null : at.slice(0, 1);
  if (parsed.kind !== "document") return [];
  for (let depth = 0; depth < at.length; depth++) {
    const up = at.slice(0, depth);
    if (nodeAt(parsed.root, up)?.kind !== "object") return up;
  }
  return null;
}

function applied(
  text: string | null,
  change: Change,
  dialect: Dialect,
): string | null {
  if (change.at.length === 0)
    return change.op === "remove" ? null : change.text;
  // Every ancestor is an object and the read matched, so a remove finds its
  // member, and leaves every ancestor standing even when it empties one: the
  // diff removes an ancestor by its own change.
  switch (change.op) {
    case "replace":
      return setValue(text!, change.at, change.text, dialect);
    case "insert":
      return insertValue(
        text!,
        change.at,
        change.text,
        dialect,
        change.precedes,
      );
    case "remove":
      return deleteValue(text!, change.at, change.at.length - 1);
  }
}

// A setting's address as a reader names it.
export function addressText(at: Address): string {
  return at.length === 0 ? "the whole file" : at.join(".");
}
