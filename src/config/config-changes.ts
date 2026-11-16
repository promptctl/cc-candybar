// [LAW:one-source-of-truth] What a config write is, as data: the changes that
// turn one document into another, each at an address and each carrying what it
// read there (docs/design/host-and-renderer.md §7, "Effects"). The renderer
// derives them from the text it validated (`diffChanges`), and the host splices
// them into the file it holds (`applyChanges`); both run this one module, so
// what a change does cannot mean one thing to its author and another to the
// host that performs it.
//
// [LAW:effects-at-boundaries] Pure: text in, text out.

import JSON5 from "json5";
import type { JsonValue } from "../var-system/types";
import { sameValue } from "../utils/plain";
import {
  addressText,
  JSON5_DIALECT,
  movableTextOf,
  nodeAtAddress,
  parseDocument,
  removeAt,
  setAt,
  textOf,
  type Address,
  type Node,
} from "./json5-edit";

export type { Address } from "./json5-edit";
export { addressText } from "./json5-edit";

// What a change read at its address: a value, or nothing there.
export type Read =
  | { readonly kind: "value"; readonly value: JsonValue }
  | { readonly kind: "absent" };

// [LAW:types-are-the-program] A value travels as its JSON5 text, never as a
// parsed value, so a row copied with its comments keeps them and an inline
// placement stays inline: the bytes a writer chose are the bytes that land.
// The empty address is the document: `set` there writes the whole text over
// what it read (creating the file over absence), and `remove` deletes it.
export type Change =
  | {
      readonly op: "set";
      readonly at: Address;
      readonly text: string;
      readonly read: Read;
    }
  | { readonly op: "remove"; readonly at: Address; readonly read: JsonValue };

// [LAW:types-are-the-program] What applying changes came to: the document as
// it now stands (null: no file), or the first change whose address no longer
// holds what it read — and what it holds instead.
export type Applied =
  | { readonly kind: "applied"; readonly text: string | null }
  | {
      readonly kind: "moved";
      readonly at: Address;
      readonly read: Read;
      readonly found: Read;
    };

// A document with nothing in it (no file, or only whitespace) has no root to
// address below.
function docOf(text: string | null): Node | null {
  return text === null || /^\s*$/.test(text) ? null : parseDocument(text);
}

function valueOf(text: string, node: Node): JsonValue {
  return JSON5.parse(textOf(text, node)) as JsonValue;
}

function readAt(text: string | null, at: Address): Read {
  if (at.length === 0) {
    const doc = docOf(text);
    return doc === null
      ? { kind: "absent" }
      : { kind: "value", value: valueOf(text!, doc) };
  }
  const doc = docOf(text);
  const node = doc === null ? undefined : nodeAtAddress(doc, at);
  return node === undefined
    ? { kind: "absent" }
    : { kind: "value", value: valueOf(text!, node) };
}

/**
 * The changes that turn `before` into `after`. Objects are compared by key and
 * equal-length arrays by index; anything else that differs is one `set` of the
 * node in `after`'s own text, so an element inserted into a row replaces the
 * row whole, its bytes and comments as the writer left them. A document that
 * is absent or empty on either side is one change of the document itself.
 */
export function diffChanges(
  before: string | null,
  after: string | null,
): readonly Change[] {
  const was = docOf(before);
  const will = docOf(after);
  if (was === null || will === null) {
    if (before === after) return [];
    const read = readAt(before, []);
    return after === null
      ? read.kind === "absent"
        ? []
        : [{ op: "remove", at: [], read: read.value }]
      : [{ op: "set", at: [], text: after, read }];
  }
  return between(before!, was, after!, will, []);
}

function between(
  before: string,
  was: Node,
  after: string,
  will: Node,
  at: Address,
): readonly Change[] {
  if (textOf(before, was) === textOf(after, will)) return [];
  if (was.kind === "object" && will.kind === "object") {
    const kept = new Set(will.entries.map((e) => e.key));
    const had = new Map(was.entries.map((e) => [e.key, e.value]));
    const members: readonly Change[] = [
      ...was.entries
        .filter((e) => !kept.has(e.key))
        .map(
          (e): Change => ({
            op: "remove",
            at: [...at, e.key],
            read: valueOf(before, e.value),
          }),
        ),
      ...will.entries.flatMap((e) => {
        const prior = had.get(e.key);
        return prior === undefined
          ? [
              {
                op: "set",
                at: [...at, e.key],
                text: movableTextOf(after, e.value),
                read: { kind: "absent" },
              } satisfies Change,
            ]
          : between(before, prior, after, e.value, [...at, e.key]);
      }),
    ];
    // A key comes back at its object's end, in its object's style, so an
    // object whose members' changes do not rebuild it as `after` has it (a
    // key restored to the middle, a pruned object restored inline) is set
    // whole instead.
    if (landsAs(before, members, at, textOf(after, will))) return members;
  }
  if (
    was.kind === "array" &&
    will.kind === "array" &&
    was.elements.length === will.elements.length
  ) {
    return was.elements.flatMap((element, i) =>
      between(before, element, after, will.elements[i]!, [...at, i]),
    );
  }
  return [
    {
      op: "set",
      at,
      text: at.length === 0 ? after : movableTextOf(after, will),
      read: { kind: "value", value: valueOf(before, was) },
    },
  ];
}

// Whether `changes`, applied to `before`, leave the node at `at` reading
// `expected` byte for byte.
function landsAs(
  before: string,
  changes: readonly Change[],
  at: Address,
  expected: string,
): boolean {
  const result = applyChanges(before, changes);
  if (result.kind === "moved" || result.text === null) return false;
  const doc = docOf(result.text);
  const node = doc === null ? undefined : nodeAtAddress(doc, at);
  return node !== undefined && textOf(result.text, node) === expected;
}

/**
 * Each change applied in order, each checked against the document as the ones
 * before it left it: a change whose address no longer holds what it read stops
 * the fold, and nothing is applied. Every byte no change touches is kept.
 */
export function applyChanges(
  text: string | null,
  changes: readonly Change[],
): Applied {
  let now = text;
  for (const change of changes) {
    const read: Read =
      change.op === "set" ? change.read : { kind: "value", value: change.read };
    const found = readAt(now, change.at);
    if (!sameRead(read, found)) {
      return { kind: "moved", at: change.at, read, found };
    }
    now = applied(now, change);
  }
  return { kind: "applied", text: now };
}

function applied(text: string | null, change: Change): string | null {
  if (change.at.length === 0) return change.op === "set" ? change.text : null;
  // A change below the document's root read a value there, so the document is.
  return change.op === "set"
    ? setAt(text!, change.at, change.text, JSON5_DIALECT)
    : removeAt(text!, change.at);
}

function sameRead(a: Read, b: Read): boolean {
  return a.kind === "absent"
    ? b.kind === "absent"
    : b.kind === "value" && sameValue(a.value, b.value);
}

// How a moved setting reads to a person: where, what the change read there,
// and what is there now.
export function movedText(moved: Extract<Applied, { kind: "moved" }>): string {
  const said = (r: Read): string =>
    r.kind === "absent" ? "unset" : JSON.stringify(r.value);
  return `${addressText(moved.at)} changed since it was read: it was ${said(moved.read)}, and is now ${said(moved.found)}`;
}
