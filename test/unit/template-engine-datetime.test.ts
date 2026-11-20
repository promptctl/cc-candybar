import { createCcCandybarEngine } from "../../src/template-engine/engine";
import { drawingAt, TEST_ENGINE } from "../helpers/test-engine";

const engine = createCcCandybarEngine({
  ...TEST_ENGINE,
  region: { locale: "de-DE", timeZone: "America/New_York" },
});

function render(source: string): string {
  using _draw = drawingAt(new Date("2024-06-04T12:00:00Z"));
  return engine
    .parse(`{{ ${source} }}`)
    .evaluate({})
    .map((text) => text.plain)
    .join("");
}

// The evaluation process's local zone is deliberately not an input to these
// templates. Run the same guarded suite in UTC and in the recorded host zone.
const layout = "2006-01-02 15:04 Z07:00";
test.each([
  [`date "${layout}" "2024-01-01T12:00:00"`, "2024-01-01 12:00 -05:00"],
  [`dateInZone "${layout}" "2024-01-01T12:00:00" "UTC"`, "2024-01-01 17:00 Z"],
  [`date "${layout}" "2024-01-01T12:00:00+02:00"`, "2024-01-01 05:00 -05:00"],
  [`date "${layout}" "2024-03-10T02:30:00"`, "2024-03-10 03:30 -04:00"],
  [`date "${layout}" "2024-11-03T01:30:00"`, "2024-11-03 01:30 -04:00"],
  [`date "${layout}" "2024/01/01 12:00 (UTC)"`, "2024-01-01 12:00 -05:00"],
  [`date "${layout}" "2024/01/01 12:00 (UTC"`, "2024-01-01 12:00 -05:00"],
  [
    `date "${layout}" "Mon, 01 Jan 2024 12:00:00 EST"`,
    "2024-01-01 12:00 -05:00",
  ],
  [`date "${layout}" "2024-01-01 12::05 +0400"`, "2024-01-01 03:00 -05:00"],
  ['htmlDate "2024-01-01T00:00:00"', "2024-01-01"],
  ['htmlDate "2024-01-01"', "2023-12-31"],
  ['htmlDate "-000000-01-01"', "2001-01-01"],
  ['htmlDateInZone "2024-01-01T23:00:00" "UTC"', "2024-01-02"],
  ['unixEpoch "2024-11-03T01:30:00"', "1730611800"],
  ['ago "2024-06-04T07:00:00"', "1h0m0s"],
])("interprets %s with the host's wall time", (source, expected) => {
  expect(render(source)).toBe(expected);
});

test.each([
  ["now", "Tue Jun 04 2024 08:00:00 GMT-0400 (Eastern Daylight Time)"],
  [
    'printf "%v" (toDate "2006-01-02" "2024-02-03")',
    "Fri Feb 02 2024 19:00:00 GMT-0500 (Eastern Standard Time)",
  ],
  [
    'printf "%s" (now)',
    "Tue Jun 04 2024 08:00:00 GMT-0400 (Eastern Daylight Time)",
  ],
  [
    'dateModify "1h" "2024-03-10T01:30:00"',
    "Sun Mar 10 2024 03:30:00 GMT-0400 (Eastern Daylight Time)",
  ],
  ["toRawJson (now)", '"2024-06-04T12:00:00.000Z"'],
])("formats %s independently of the evaluation process", (source, expected) => {
  expect(render(source)).toBe(expected);
});

test("keeps native rejection of a legacy date with an invalid separator", () => {
  expect(() => render('htmlDate "2024-01-01 12:00(a)EST"')).toThrow(
    /sprig: cannot parse date value/,
  );
});
