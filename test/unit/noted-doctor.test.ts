// The doctor note a turn's record carries, read back as written, and a note no
// renderer writes refused loudly.

import {
  doctorNote,
  readDoctorNote,
  type NotedReport,
} from "../../src/renderer-interface/noted-doctor";
import { nextRunName } from "../../src/doctor/gather";
import { instantOf } from "../../src/utils/instant";

const RUN = nextRunName(instantOf(new Date(0)), null);

const REPORTS: readonly NotedReport[] = [
  { name: "config", label: "config", verdict: { ok: true } },
  {
    name: "daemon",
    label: "daemon",
    verdict: { ok: true, note: "the daemon's memory is not judged here" },
  },
  {
    name: "nerdFont",
    label: "Nerd Font",
    verdict: {
      ok: false,
      reason: "the font lacks 3 glyphs",
      more: ["a second problem"],
      fixable: false,
      look: "",
    },
  },
];

test("a note reads back as the run it was written from", () => {
  const reported = { run: RUN, kind: "reported", reports: REPORTS } as const;
  expect(readDoctorNote(doctorNote(reported))).toEqual(reported);
  const failed = {
    run: RUN,
    kind: "failed",
    reason: "the probe was refused",
  } as const;
  expect(readDoctorNote(doctorNote(failed))).toEqual(failed);
});

const reported = (reports: string): string =>
  `{"run":1,"kind":"reported","reports":${reports}}`;

test.each([
  ["not an object", `[]`, /neither reported nor failed/],
  ["a failed run with no reason", `{"kind":"failed"}`, /has no reason/],
  ["reports that are not a list", reported(`{}`), /not a JSON array/],
  [
    "a note that names no run",
    `{"kind":"reported","reports":[]}`,
    /names no run/,
  ],
  [
    "a report with no label",
    reported(`[{"name":"x","verdict":{"ok":true}}]`),
    /report 0 .* has no name or label/,
  ],
  [
    "a verdict neither ok nor failed",
    reported(`[{"name":"x","label":"x","verdict":{"ok":"yes"}}]`),
    /neither ok nor failed/,
  ],
  [
    "a failed verdict with no list of problems",
    reported(
      `[{"name":"x","label":"x","verdict":{"ok":false,"reason":"r","fixable":false}}]`,
    ),
    /no list of further problems/,
  ],
])("%s is refused, naming what is wrong", (_what, note, problem) => {
  expect(() => readDoctorNote(note)).toThrow(problem);
});
