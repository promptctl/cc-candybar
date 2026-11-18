// [LAW:verifiable-goals] A turn record's faults note reads back as the faults
// the renderer wrote, `kept` as kept, and anything else as a loud refusal.

import {
  faultsNote as noteOf,
  readFaults,
  spelledFaults,
  type Fault,
} from "../../src/renderer-interface/noted-faults";

const faultsNote = (
  faults: readonly Fault[],
  last: readonly Fault[] | undefined,
): string =>
  noteOf(
    spelledFaults(faults),
    last === undefined ? undefined : spelledFaults(last),
  );

const SEGMENT: Fault = {
  level: "warning",
  kind: "segment",
  subject: "said",
  message: "said: the template broke",
};
const LOAD: Fault = { level: "error", kind: "load", message: "no parse" };

test("a note reads back as the faults it was written from", () => {
  expect(readFaults(faultsNote([SEGMENT, LOAD], undefined))).toEqual([
    SEGMENT,
    LOAD,
  ]);
  expect(readFaults(faultsNote([], undefined))).toEqual([]);
});

test("the same faults as the last note are noted as kept, and a change whole", () => {
  expect(faultsNote([{ ...SEGMENT }], [SEGMENT])).toBe("kept");
  expect(readFaults("kept")).toBe("kept");
  expect(readFaults(faultsNote([SEGMENT, LOAD], [SEGMENT]))).toEqual([
    SEGMENT,
    LOAD,
  ]);
  // A first note has nothing to be kept from, so even none is noted.
  expect(faultsNote([], undefined)).toBe("[]");
});

test.each([
  ["not JSON", "kep"],
  ["not an array", `{"level":"error"}`],
  ["an entry that is not an object", `["x"]`],
  ["a level of neither", `[{"level":"info","kind":"k","message":"m"}]`],
  ["no kind", `[{"level":"error","message":"m"}]`],
  ["no message", `[{"level":"error","kind":"k"}]`],
  [
    "a subject that is not text",
    `[{"level":"error","kind":"k","subject":1,"message":"m"}]`,
  ],
  [
    "a field no fault has",
    `[{"level":"error","kind":"k","message":"m","extra":1}]`,
  ],
])("a note with %s throws", (_what, value) => {
  expect(() => readFaults(value)).toThrow();
});
