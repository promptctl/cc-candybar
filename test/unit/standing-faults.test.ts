// [LAW:verifiable-goals] A lasting fault stands from its first throw until its
// source succeeds or is let go, and the log records each start, reason change
// and clear once.

import {
  StandingFaults,
  type FaultSource,
} from "../../src/daemon/foundations/standing-faults";
import { fieldsOf } from "../../src/utils/logfmt";

const REPO: FaultSource = { work: "git refresh", subject: [["repo", "/r"]] };
const OTHER: FaultSource = { work: "git refresh", subject: [["repo", "/o"]] };

const rig = () => {
  const logged: { level: string; line: string }[] = [];
  const faults = new StandingFaults((level, line) =>
    logged.push({ level, line }),
  );
  return { faults, logged };
};

test("a fault stands from its first throw, and the same reason again is the fault already standing", () => {
  const { faults, logged } = rig();
  faults.raise(REPO, new Error("no repo"));
  faults.raise(REPO, new Error("no repo"));
  expect(faults.list()).toEqual([
    {
      kind: "daemon-fault",
      about: "git refresh repo=/r",
      message: 'git refresh threw repo=/r failed="no repo"',
    },
  ]);
  expect(logged).toHaveLength(1);
  expect(logged[0]!.level).toBe("warn");
  const fields = fieldsOf(logged[0]!.line);
  expect(fields.get("failed")).toBe("no repo");
  expect(fields.get("detail")).toContain("Error: no repo");
});

test("a changed reason is logged and replaces the fault the bar shows", () => {
  const { faults, logged } = rig();
  faults.raise(REPO, new Error("first"));
  faults.raise(REPO, new Error("second"));
  expect(faults.list().map((fault) => fault.message)).toEqual([
    "git refresh threw repo=/r failed=second",
  ]);
  expect(logged.map(({ line }) => fieldsOf(line).get("failed"))).toEqual([
    "first",
    "second",
  ]);
});

test("a clear logs why the fault ended, once, and leaves the other sources standing", () => {
  const { faults, logged } = rig();
  faults.raise(REPO, new Error("no repo"));
  faults.raise(OTHER, new Error("no other"));
  faults.clear(REPO, "recovered");
  faults.clear(REPO, "recovered");
  faults.clear(OTHER, "let go");
  expect(faults.list()).toEqual([]);
  expect(logged.slice(2)).toEqual([
    { level: "info", line: "git refresh recovered repo=/r" },
    { level: "info", line: "git refresh let go repo=/o" },
  ]);
});

test("clearing a source with no fault writes nothing", () => {
  const { faults, logged } = rig();
  faults.clear(REPO, "recovered");
  expect(logged).toEqual([]);
  expect(faults.list()).toEqual([]);
});
