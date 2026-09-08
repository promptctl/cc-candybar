// [LAW:one-source-of-truth] The one way a test drives a config TEXT through
// `cc-candybar check`: a real temp file and the actual CLI entry function.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkConfig, checkPlan, type CheckOutcome } from "../../src/check";

export async function withTempConfig<T>(
  text: string,
  fn: (configPath: string) => Promise<T> | T,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-check-config-"));
  const configPath = path.join(dir, ".cc-candybar.json5");
  fs.writeFileSync(configPath, text);
  try {
    return await fn(configPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

export function checkText(
  label: string,
  text: string,
): Promise<Extract<CheckOutcome, { kind: "clean" }>> {
  return withTempConfig(text, async (p) =>
    expectClean(label, await checkConfig(p)),
  );
}
