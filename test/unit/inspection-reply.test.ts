import { inspectionPayloadProblem } from "../../src/daemon/foundations/inspection-reply";
import { EMPTY_RENDERER_STATS } from "../helpers/empty-stats";
import { formatDebug } from "../../src/daemon/client-debug";
import type { DebugSnapshot } from "../../src/daemon/foundations/debug-types";

const variable = {
  name: "label",
  source: "literal",
  type: "string",
  value: "ready",
  ageMs: 0,
  lastError: null,
} as const;
const segment = {
  name: "label",
  description: null,
  template: "{{ .label }}",
  referencedVars: ["label"],
  placements: [{ id: "status", lastRender: "ready" }],
};

test.each([
  [{ what: "vars" }, "invalid vars snapshot"],
  [
    { what: "vars", vars: [{ ...variable, value: undefined }] },
    "invalid vars snapshot",
  ],
  [
    { what: "segments", segments: [{ ...segment, placements: null }] },
    "invalid segments snapshot",
  ],
  [{ what: "config" }, "invalid config snapshot"],
])("refuses a truncated debug reply with payload %j", (snapshot, problem) => {
  expect(inspectionPayloadProblem({ kind: "debug", snapshot })).toBe(problem);
});

const formatted: ReadonlyArray<readonly [DebugSnapshot, string]> = [
  [{ what: "vars", vars: [] }, "no variables"],
  [{ what: "vars", vars: [variable] }, "ready"],
  [{ what: "segments", segments: [segment] }, "{{ .label }}"],
  [{ what: "config", config: null }, "DSL not active"],
];

test.each(formatted)(
  "admits and formats a complete debug reply %j",
  (snapshot, text) => {
    expect(inspectionPayloadProblem({ kind: "debug", snapshot })).toBeNull();
    expect(formatDebug(snapshot)).toContain(text);
  },
);

test("requires the renderer's full stats contribution, including finite counts", () => {
  const stats = EMPTY_RENDERER_STATS;
  expect(inspectionPayloadProblem({ kind: "stats", stats })).toBeNull();
  expect(
    inspectionPayloadProblem({
      kind: "stats",
      stats: { ...stats, renderCache: null, framesDrawn: "zero" },
    }),
  ).toBe("invalid stats snapshot: renderCache, framesDrawn");
  expect(
    inspectionPayloadProblem({
      kind: "stats",
      stats: { ...stats, menuIdle: { sessions: 0 } },
    }),
  ).toBe("invalid stats snapshot: menuIdle.armed");
});
