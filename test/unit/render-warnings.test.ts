import {
  describeWarning,
  frameWarnings,
  warningChanges,
} from "../../src/renderer/render-warnings";
import {
  KEPT_FAULTS,
  readFaults,
  type Fault,
} from "../../src/renderer-interface/noted-faults";

const warning = (message: string) =>
  describeWarning({
    kind: "refresh",
    variable: message,
    error: message,
    message,
  });

const of = (...messages: string[]) => frameWarnings(messages.map(warning), []);

test("first clean and already clean report different fault baselines", () => {
  const first = of();
  expect(warningChanges(first, undefined)).toEqual({
    moved: false,
    faults: "[]",
  });
  expect(warningChanges(of(), first)).toEqual({
    moved: false,
    faults: KEPT_FAULTS,
  });
  expect(warningChanges(of("added"), first).moved).toBe(true);
  expect(warningChanges(of(), of("cleared")).moved).toBe(true);
});

test("equal warnings compare by their facts and preserve occurrences", () => {
  const same = describeWarning({
    message: "both",
    error: "both",
    variable: "both",
    kind: "refresh",
  });
  const prior = of("both", "local", "both");
  expect(
    warningChanges(frameWarnings([same, warning("local"), same], []), prior)
      .moved,
  ).toBe(false);
  expect(warningChanges(of("both", "local"), prior).moved).toBe(true);
});

test("the fault comparison reports complete faults when their contents change", () => {
  const fault: Fault = {
    level: "warning",
    kind: "segment",
    subject: "said",
    message: "explanation",
  };
  const prepared = frameWarnings([], [fault]);
  expect(readFaults(warningChanges(prepared, of()).faults)).toEqual([fault]);
  expect(
    warningChanges(frameWarnings([], [{ ...fault }]), prepared).faults,
  ).toBe(KEPT_FAULTS);
  expect(readFaults(warningChanges(of(), prepared).faults)).toEqual([]);
});
