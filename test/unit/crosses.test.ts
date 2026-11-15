// The check that every value the renderer and the host hand each other
// crosses a process (src/renderer-interface/crosses.ts). Its cases are types:
// each `@ts-expect-error` fails the typecheck if the check stops refusing what
// it names, so the check cannot pass vacuously.

import type { Crosses, Reaches } from "../../src/renderer-interface/crosses";
import type {
  AdapterPush,
  HostCalls,
} from "../../src/renderer-interface/adapter";

// @ts-expect-error a closure does not cross
const closure: Crosses<{ readonly done: () => void }> = true;
// @ts-expect-error a Map does not cross
const map: Crosses<{ readonly seen: ReadonlyMap<string, number> }> = true;
// @ts-expect-error a list's undefined arrives as null
const holes: Crosses<readonly (string | undefined)[]> = true;
// @ts-expect-error a function deep in a value is found
const deep: Crosses<{ a: { b: { c: { d: () => void } } } }> = true;
// @ts-expect-error an `any` holds whatever it was handed, read or not
const anything: Crosses<{ readonly parsed: any }> = true;
// @ts-expect-error a push that held a closure would not cross
const push: Crosses<AdapterPush | { kind: "x"; run: () => void }> = true;
// @ts-expect-error a record's undefined is a key JSON drops
const unset: Crosses<Readonly<Record<string, string | undefined>>> = true;
// A field left out arrives left out, so an optional one crosses.
const plain: Crosses<{
  readonly name?: string;
  readonly sizes: readonly number[];
  readonly none: null;
}> = true;

// @ts-expect-error a reach answering a value in place does not cross
const inPlace: Reaches<{ readonly read: () => boolean }> = true;
// @ts-expect-error an argument that holds a closure does not cross
const handed: Reaches<{ readonly on: (heard: () => void) => void }> = true;
// @ts-expect-error an argument list's undefined arrives as null
const hole: Reaches<{ readonly see: (tmux: string | undefined) => void }> =
  true;
// @ts-expect-error an awaited answer that holds a Map does not cross
const held: Reaches<{ readonly ask: () => Promise<Map<string, number>> }> =
  true;
// @ts-expect-error a reach group that grew one in-place reach is found
const grown: Reaches<HostCalls & { readonly x: { y: () => number } }> = true;
// A notice and an awaited call, in a group, cross.
const reaches: Reaches<{
  readonly told: (line: string) => void;
  readonly asked: { readonly when: (at: number) => Promise<number | null> };
  readonly done: () => Promise<void>;
}> = true;

describe("Crosses", () => {
  it("is a check the typecheck runs", () => {
    expect([
      closure,
      map,
      holes,
      deep,
      anything,
      push,
      unset,
      plain,
    ]).toHaveLength(8);
  });
});

describe("Reaches", () => {
  it("is a check the typecheck runs", () => {
    expect([inPlace, handed, hole, held, grown, reaches]).toHaveLength(6);
  });
});
