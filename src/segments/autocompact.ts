// Claude Code's auto-compact window: how full the context gets before Claude
// Code summarizes it. Its only writer is Claude Code's `/autocompact` command,
// which the bar types into the session (a `slash` action) — so the bar reads
// the value back from where that command stores it.
//
// Measured on Claude Code 2.1.285 (brandon-context-ceiling-xta.e3p):
//   - `/autocompact <tokens>` writes `autoCompactWindow` into the USER
//     settings file and applies it to the running session at once;
//     `/autocompact auto` deletes the key, handing the window back to Claude
//     Code's per-model tuning.
//   - It accepts 100,000 to 1,000,000 tokens and refuses the rest; a window
//     above the model's context window is capped to it.
//   - The statusline hook payload carries none of this.

import fs from "node:fs/promises";
import { failed, ok, type Outcome } from "../utils/outcome.js";

// The windows the bar offers: Claude Code's whole accepted range, in the 100K
// steps its controls move by. Each is one declared `slash` action
// (src/config/default-dsl-config.ts), so these are also the only lines a click
// on the control can type.
export const AUTOCOMPACT_WINDOWS: readonly number[] = Array.from(
  { length: 10 },
  (_, i) => (i + 1) * 100_000,
);

// [LAW:types-are-the-program] `auto` is not a number of tokens: under it the
// window is Claude Code's to choose, and nothing it exposes says what it chose.
export type AutoCompactWindow = number | "auto";

// [LAW:no-silent-failure] A missing settings file is Claude Code having
// written nothing yet — `auto`, exactly as Claude Code reads it. A file that
// does not parse, or a value that is not a number, is a refusal naming the
// file: Claude Code is not running with whatever the bar would guess.
export async function readAutoCompactWindow(
  settingsPath: string,
): Promise<Outcome<AutoCompactWindow>> {
  let text: string;
  try {
    text = await fs.readFile(settingsPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok("auto");
    return failed(`cannot read ${settingsPath}: ${String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return failed(`cannot read ${settingsPath}: ${String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failed(`cannot read ${settingsPath}: not a JSON object`);
  }
  const window = (parsed as Record<string, unknown>).autoCompactWindow;
  if (window === undefined) return ok("auto");
  return typeof window === "number"
    ? ok(window)
    : failed(
        `${settingsPath}: autoCompactWindow is ${JSON.stringify(window)}, not a number of tokens`,
      );
}
