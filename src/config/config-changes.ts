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

import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";
import {
  deleteValue,
  JSON5_DIALECT,
  Json5EditError,
  movableTextOf,
  parseDocument,
  setValue,
  textOf,
  type Node,
} from "./json5-edit.js";

// A setting's address: object keys from the document's root. The empty
// address is the document, so a set there writes the whole file and a remove
// there deletes it. An array is addressed whole, so a layout edit is guarded
// per row.
export type Address = readonly string[];

// What a change read at its address: the decoded value, or nothing there.
export type Read =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "absent" };

// [LAW:types-are-the-program] A set carries JSON5 text, not a value, so a
// copied row keeps its comments and an inline placement stays inline.
export type Change =
  | {
      readonly op: "set";
      readonly at: Address;
      readonly text: string;
      readonly read: Read;
    }
  | { readonly op: "remove"; readonly at: Address; readonly read: Read };

export type Applied =
  | { readonly kind: "applied"; readonly text: string | null }
  // The first change whose setting moved, and what it found there instead.
  | {
      readonly kind: "moved";
      readonly at: Address;
      readonly read: Read;
      readonly found: Read;
    };

const ABSENT: Read = { kind: "absent" };

// A file's text as a document: an absent file and one holding only
// whitespace both hold none.
function documentOf(text: string | null): Node | null {
  return text === null || /^\s*$/.test(text) ? null : parseDocument(text);
}

function readOf(text: string, node: Node | undefined): Read {
  return node === undefined
    ? ABSENT
    : { kind: "value", value: JSON5.parse(textOf(text, node)) };
}

function nodeAtAddress(root: Node | null, at: Address): Node | undefined {
  let node: Node | undefined = root ?? undefined;
  for (const key of at) {
    node =
      node?.kind === "object"
        ? node.entries.find((e) => e.key === key)?.value
        : undefined;
  }
  return node;
}

/**
 * The changes that take `before` to `after`: one per setting that differs,
 * down to the first level where either side is not an object. When those do
 * not rebuild `after` byte for byte (a key restored in the middle of an
 * object, members reordered, a comment edited), the change is the whole
 * document, read whole.
 */
export function diffChanges(
  before: string | null,
  after: string | null,
): readonly Change[] {
  if (before === after) return [];
  const was = documentOf(before);
  const will = documentOf(after);
  const read = readOf(before ?? "", was ?? undefined);
  const whole: readonly Change[] =
    after === null
      ? [{ op: "remove", at: [], read }]
      : [{ op: "set", at: [], text: after, read }];
  if (was === null || will === null) return whole;
  const members = diffNode([], before!, was, after!, will);
  const rebuilt = applyChanges(before, members);
  return rebuilt.kind === "applied" && rebuilt.text === after
    ? members
    : whole;
}

function diffNode(
  at: Address,
  beforeText: string,
  was: Node,
  afterText: string,
  will: Node,
): Change[] {
  if (textOf(beforeText, was) === textOf(afterText, will)) return [];
  return was.kind === "object" && will.kind === "object"
    ? diffMembers(at, beforeText, was, afterText, will)
    : [
        {
          op: "set",
          at,
          text: movableTextOf(afterText, will),
          read: readOf(beforeText, was),
        },
      ];
}

function diffMembers(
  at: Address,
  beforeText: string,
  was: Extract<Node, { kind: "object" }>,
  afterText: string,
  will: Extract<Node, { kind: "object" }>,
): Change[] {
  const kept = new Map(will.entries.map((e) => [e.key, e.value] as const));
  const gone = was.entries
    .filter((e) => !kept.has(e.key))
    .map(
      (e): Change => ({
        op: "remove",
        at: [...at, e.key],
        read: readOf(beforeText, e.value),
      }),
    );
  const prior = new Map(was.entries.map((e) => [e.key, e.value] as const));
  const moved = will.entries.flatMap((e): Change[] => {
    const old = prior.get(e.key);
    return old === undefined
      ? [
          {
            op: "set",
            at: [...at, e.key],
            text: movableTextOf(afterText, e.value),
            read: ABSENT,
          },
        ]
      : diffNode([...at, e.key], beforeText, old, afterText, e.value);
  });
  return [...gone, ...moved];
}

/**
 * `changes` applied to `text` in order, each checked against the document as
 * it then stands. A setting that moved, or a container a change needs that is
 * no longer an object, refuses the whole list.
 */
export function applyChanges(
  text: string | null,
  changes: readonly Change[],
): Applied {
  let current = text;
  for (const change of changes) {
    const found = readOf(current ?? "", nodeAtAddress(documentOf(current), change.at));
    if (!isDeepStrictEqual(found, change.read))
      return { kind: "moved", at: change.at, read: change.read, found };
    try {
      current = applied(current, change);
    } catch (e) {
      if (!(e instanceof Json5EditError)) throw e;
      return { kind: "moved", at: change.at, read: change.read, found };
    }
  }
  return { kind: "applied", text: current };
}

function applied(text: string | null, change: Change): string | null {
  if (change.at.length === 0) return change.op === "set" ? change.text : null;
  // The read matched, so a remove finds its member, and leaves every
  // ancestor standing even when it empties one: the diff removes an ancestor
  // by its own change.
  return change.op === "set"
    ? setValue(text ?? "", change.at, change.text, JSON5_DIALECT)
    : deleteValue(text!, change.at, change.at.length - 1);
}

// A setting's address as a reader names it.
export function addressText(at: Address): string {
  return at.length === 0 ? "the whole file" : at.join(".");
}
