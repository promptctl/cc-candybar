// The check that every value the renderer and the host hand each other
// crosses a process (src/renderer-interface/crosses.ts). Its cases are types:
// each `@ts-expect-error` fails the typecheck if the check stops refusing what
// it names, so the check cannot pass vacuously.

import type { Crosses } from "../../src/renderer-interface/crosses";
import type { Event } from "../../src/renderer-interface/interface";
import type { MainRendererInputs } from "../../src/renderer/main";

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
// @ts-expect-error an event that held a closure would not cross
const event: Crosses<Event | { kind: "x"; run: () => void }> = true;
// @ts-expect-error a renderer handed a host part's method would not cross
const handed: Crosses<
  MainRendererInputs & { readonly log: (line: string) => void }
> = true;
// @ts-expect-error a record's undefined is a key JSON drops
const unset: Crosses<Readonly<Record<string, string | undefined>>> = true;
// @ts-expect-error a number-keyed record's undefined is a key JSON drops
const numbered: Crosses<Readonly<Record<number, string | undefined>>> = true;
// @ts-expect-error a template-keyed record's undefined is a key JSON drops
const templated: Crosses<
  Readonly<Record<`env-${string}`, string | undefined>>
> = true;
// A field left out arrives left out, so an optional one crosses.
const plain: Crosses<{
  readonly name?: string;
  readonly sizes: readonly number[];
  readonly none: null;
}> = true;

describe("Crosses", () => {
  it("is a check the typecheck runs", () => {
    expect([
      closure,
      map,
      holes,
      deep,
      anything,
      event,
      handed,
      unset,
      numbered,
      templated,
      plain,
    ]).toHaveLength(11);
  });
});
