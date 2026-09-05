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

import { checkConfig } from "../src/check";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { presetNames } from "../src/config/presets";
import { checkText, expectClean, withTempConfig } from "./helpers/check-config";

const examplesDir = path.join(__dirname, "..", "examples");

const exampleFiles = fs
  .readdirSync(examplesDir)
  .filter((f) => f.endsWith(".json5"))
  .sort();

// Run one example through the shipped check pipeline; the rendered line for
// content assertions.
function renderExample(file: string): string {
  return expectClean(file, checkConfig(path.join(examplesDir, file))).rendered;
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
      expectClean(file, checkConfig(path.join(examplesDir, file)));
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
    // `theme.effective` var — checkConfig threads effectiveThemeName(undefined, null,
    // globals.palette) into the payload exactly as the daemon does, so the
    // label below is single-sourced from legacy-parity's globals.palette.
    expect(out).toContain("🎨 catppuccin-mocha");
    // session/today cost + block/weekly quota + version.
    expect(out).toContain("§ $0.39");
    expect(out).toContain("v1.15.0");
    expect(out).toContain("63%"); // block utilization
  });
});

// [LAW:verifiable-goals] brandon-presets-0yk.3's own done-gate: "the examples/
// load test covers the bundled library the way it covers example configs" —
// the same `cc-candybar check` guarantee the suite above gives every shipped
// examples/*.json5 file, given here to every NAME in the bundled `presets`
// library, via the one-line config a real user would write to pick one
// (`globals: { preset: "<name>" }`) — not a hand-built render rig, the actual
// CLI entry point, on a real temp file on disk.
describe("bundled preset library is clean under `cc-candybar check`", () => {
  const withPresetConfig = <T,>(preset: string, fn: (configPath: string) => T): T =>
    withTempConfig(JSON.stringify({ globals: { preset } }), fn);

  // Guard against the domain silently shrinking to just the floor — a preset
  // this suite never iterates would be a preset never `check`-tested.
  test("the bundled library declares more than just the floor", () => {
    expect(presetNames(DEFAULT_DSL_CONFIG.presets).length).toBeGreaterThan(1);
  });

  test.each(presetNames(DEFAULT_DSL_CONFIG.presets))(
    'a config picking preset "%s" is clean under check (exit 0) and renders',
    (preset) => {
      withPresetConfig(preset, (p) => expectClean(`preset "${preset}"`, checkConfig(p)));
    },
  );
});

// [LAW:verifiable-goals] brandon-config-merge-uk3's done-when: a user file
// declaring ONLY one named row merges that row by name over the bundled
// default's rows, so the bundled identity row renders unchanged above it —
// through the same `cc-candybar check` entry as everything above.
describe("a `{ rows }` root merges by name over the bundled default", () => {
  test("declaring only the status row keeps the bundled identity row above it", () => {
    const outcome = checkText(
      "rows-merge",
      `{ root: { rows: { status: { h: ["model", "context"] } } } }`,
    );
    const [identity, status, ...rest] = visible(outcome.rendered).split("\n");
    expect(rest).toEqual([]);
    // The bundled identity row, untouched: the fish-abbreviated directory
    // the check payload's cwd renders to.
    expect(identity).toContain("~/c/c/src");
    // The user's status row: model and context, and none of the bundled
    // status row's other segments (block/weekly quota).
    expect(status).toContain("Opus 4.8");
    expect(status).not.toContain("21%");
  });
});
