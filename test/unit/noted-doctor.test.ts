// The doctor note a turn's record carries, read back as written, and a note no
// renderer writes refused loudly.

import {
  doctorNote,
  readDoctorNote,
  type NotedReport,
} from "../../src/renderer-interface/noted-doctor";

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

test("a note reads back as the reports it was written from", () => {
  expect(readDoctorNote(doctorNote(REPORTS))).toEqual(REPORTS);
});

test.each([
  ["not an array", `{"name":"config"}`, /a doctor note is a JSON array/],
  [
    "a report with no label",
    `[{"name":"x","verdict":{"ok":true}}]`,
    /report 0 .* has no name or label/,
  ],
  [
    "a verdict neither ok nor failed",
    `[{"name":"x","label":"x","verdict":{"ok":"yes"}}]`,
    /neither ok nor failed/,
  ],
  [
    "a failed verdict with no list of problems",
    `[{"name":"x","label":"x","verdict":{"ok":false,"reason":"r","fixable":false}}]`,
    /no list of further problems/,
  ],
])("%s is refused, naming what is wrong", (_what, note, problem) => {
  expect(() => readDoctorNote(note)).toThrow(problem);
});
