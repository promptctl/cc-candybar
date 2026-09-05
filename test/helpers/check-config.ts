// [LAW:one-source-of-truth] The one way a test drives a config TEXT through
// `cc-candybar check`: a real temp file on disk, the actual CLI entry function,
// never a hand-built render rig. Shared by the shipped-config suites
// (examples/, plugin/templates/) so they cannot disagree about what "clean"
// means.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkConfig, checkPlan, type CheckOutcome } from "../../src/check";

// Run `fn` against a real temp config file holding `text`.
export function withTempConfig<T>(
  text: string,
  fn: (configPath: string) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-check-config-"));
  const configPath = path.join(dir, ".cc-candybar.json5");
  fs.writeFileSync(configPath, text);
  try {
    return fn(configPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// [LAW:no-silent-failure] The clean outcome, or a throw carrying the outcome's
// OWN diagnostic — a broken config names its actual load error in the Jest
// output instead of an opaque kind mismatch.
export function expectClean(
  label: string,
  outcome: CheckOutcome,
): Extract<CheckOutcome, { kind: "clean" }> {
  if (outcome.kind !== "clean") {
    throw new Error(
      `${label}: ${outcome.kind}: ${"message" in outcome ? outcome.message : ""}`,
    );
  }
  expect(checkPlan(outcome).code).toBe(0);
  expect(outcome.rendered.length).toBeGreaterThan(0);
  return outcome;
}

// The clean outcome of a config given as text.
export function checkText(
  label: string,
  text: string,
): Extract<CheckOutcome, { kind: "clean" }> {
  return withTempConfig(text, (p) => expectClean(label, checkConfig(p)));
}
