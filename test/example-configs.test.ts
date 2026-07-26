// [LAW:verifiable-goals] Every shipped example config under examples/ must
// survive the full production pipeline: parse → merge-on-default → validate →
// register → render. A template parse error in an inline override, a dangling
// segment/action reference, or a palette name the registry can't resolve would
// otherwise rot silently until a user copies the file onto their bar.
//
// [LAW:single-enforcer] The pipeline driven here IS `cc-candybar check`
// (checkConfig in src/check.ts) — the same entry function the CLI runs, which
// itself calls the same functions the daemon runs. So this suite is literally
// the ticket-level guarantee "check exits 0 on every shipped example", and the
// examples, the check command, and the daemon can never disagree about what
// loads. The rich representative payload (checkPayload) lives with the command;
// the content assertions below read the values it declares.
//
// [LAW:behavior-not-structure] The assertion is the contract a user relies on —
// "this documented config loads and renders" — not any internal shape. The test
// discovers files by globbing the directory, so a new example is covered the
// moment it lands (no per-file edit).
//
// examples/legacy-parity.json5 is the migration-completeness capstone
// (brandon-config-aoi): this test is what keeps that proof honest over time.

import fs from "node:fs";
import path from "node:path";

import { checkConfig, checkPlan } from "../src/check";

const examplesDir = path.join(__dirname, "..", "examples");

const exampleFiles = fs
  .readdirSync(examplesDir)
  .filter((f) => f.endsWith(".json5"))
  .sort();

// Run one example through the shipped check pipeline; fail loudly with the
// diagnostic if it is anything but clean, else return the rendered line for
// content assertions.
function renderExample(file: string): string {
  const outcome = checkConfig(path.join(examplesDir, file));
  if (outcome.kind !== "clean") {
    throw new Error(
      `${file}: ${outcome.kind}: ${"message" in outcome ? outcome.message : ""}`,
    );
  }
  return outcome.rendered;
}

// ANSI SGR + OSC-8 hyperlink stripped, leaving the visible glyph text. The
// OSC-8 introducer is terminated by EITHER ST (ESC \) or BEL (\x07) per spec —
// match both so the helper strips a valid sequence regardless of terminator.
function visible(line: string): string {
  return line
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
}

describe("shipped example configs (examples/*.json5)", () => {
  // Guard against the glob silently matching nothing (a moved directory would
  // make every it.each below vanish and the suite pass vacuously).
  test("at least the known examples are present", () => {
    expect(exampleFiles).toEqual(
      expect.arrayContaining([
        "legacy-parity.json5",
        "showcase.json5",
        "demo-actions.json5",
        "demo-variables.json5",
      ]),
    );
  });

  test.each(exampleFiles)(
    "%s is clean under `cc-candybar check` (exit 0) and renders",
    (file) => {
      const outcome = checkConfig(path.join(examplesDir, file));
      // Fail with the outcome's own diagnostic, not an opaque kind mismatch —
      // a broken example should name its actual load error in the Jest output.
      if (outcome.kind !== "clean") {
        throw new Error(
          `${file}: ${outcome.kind}: ${"message" in outcome ? outcome.message : ""}`,
        );
      }
      expect(checkPlan(outcome).code).toBe(0);
      expect(outcome.rendered.length).toBeGreaterThan(0);
    },
  );

  // [LAW:behavior-not-structure] The capstone parity config: assert the rich
  // template branches actually render their content, not merely that render
  // doesn't throw. This is the guard for the git-with-◷ override, both directory
  // forms (fish-abbreviated + unabbreviated), and the metrics segment — the
  // exact branches a minimal payload would gate off.
  test("legacy-parity renders the full legacy information set", () => {
    const out = visible(renderExample("legacy-parity.json5"));
    // git (line 3) with the ◷ time-since-commit override → "13m" from 780s.
    expect(out).toContain("⎇ main");
    expect(out).toContain("◷ 13m");
    // fish-abbreviated directory (line 1) AND the unabbreviated directoryFull
    // (line 4) both derive from home — distinct forms prove both branches ran.
    expect(out).toContain("~/c/c/src"); // fish: leaf full, ancestors to leading char
    expect(out).toContain("~/code/cc-candybar/src"); // directoryFull: unabbreviated
    // metrics segment (line 2) — all six flags render from the cost/transcript.
    expect(out).toContain("◆ 8");
    expect(out).toContain("+ 512");
    // [LAW:one-source-of-truth] The theme trigger reads the daemon-resolved
    // `theme.effective` var — checkConfig threads effectiveThemeName(null,
    // globals.palette) into the payload exactly as the daemon does, so the
    // label below is single-sourced from legacy-parity's globals.palette.
    expect(out).toContain("🎨 catppuccin-mocha");
    // session/today cost + block/weekly quota + version.
    expect(out).toContain("§ $0.39");
    expect(out).toContain("v1.15.0");
    expect(out).toContain("63%"); // block utilization
  });
});
