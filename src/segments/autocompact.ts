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

import { readClaudeSettings } from "../claude-settings.js";
import { failed, ok, type Outcome } from "../utils/outcome.js";

// The windows the bar offers: Claude Code's whole accepted range, in the 100K
// steps its controls move by. Each is one declared `slash` action
// (src/config/default-dsl-config.ts), so these are also the only lines a click
// on the control can type.
export const AUTOCOMPACT_WINDOWS: readonly number[] = Array.from(
  { length: 10 },
  (_, i) => (i + 1) * 100_000,
);
const LEAST = AUTOCOMPACT_WINDOWS[0]!;
const MOST = AUTOCOMPACT_WINDOWS[AUTOCOMPACT_WINDOWS.length - 1]!;

// [LAW:types-are-the-program] `auto` is not a number of tokens: under it the
// window is Claude Code's to choose, and nothing it exposes says what it chose.
export type AutoCompactWindow = number | "auto";

// [LAW:no-silent-failure] No key is Claude Code having written nothing —
// `auto`, exactly as Claude Code reads it. A file that does not read as a
// settings document, or a value `/autocompact` could not have written (a
// hand edit), is a refusal naming the file: the bar does not guess what
// Claude Code made of it.
export function readAutoCompactWindow(
  settingsPath: string,
): Outcome<AutoCompactWindow> {
  let settings: Readonly<Record<string, unknown>>;
  try {
    settings = readClaudeSettings(settingsPath);
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
  const window = settings.autoCompactWindow;
  if (window === undefined) return ok("auto");
  return typeof window === "number" &&
    Number.isInteger(window) &&
    window >= LEAST &&
    window <= MOST
    ? ok(window)
    : failed(
        `${settingsPath}: autoCompactWindow is ${JSON.stringify(window)}, not a window /autocompact accepts (${LEAST}–${MOST} tokens)`,
      );
}

// What the control shows and can do, derived from the setting and the model's
// context window. `window` is the setting (0 under `auto` — never a real
// window, since the read refuses anything below LEAST); `applied` is what
// Claude Code compacts at, the setting capped to the context window; `lower`
// and `higher` are the windows − and + type, 0 where there is none.
export interface AutoCompactControls {
  readonly window: number;
  readonly applied: number;
  readonly lower: number;
  readonly higher: number;
}

// [LAW:one-source-of-truth] The stepping is AUTOCOMPACT_WINDOWS itself: − and +
// land only on windows a declared action types, so no template arithmetic can
// name an action that does not exist. They step from the applied window —
// under `auto`, from the most `auto` can be, the cap — and + never passes the
// cap, where a larger window would change nothing Claude Code applies. An
// unknown context window (no context payload yet) caps at MOST, the range's own
// top.
export function autoCompactControls(
  window: AutoCompactWindow,
  contextWindow: number | undefined,
): AutoCompactControls {
  const cap = Math.min(contextWindow ?? MOST, MOST);
  const from = window === "auto" ? cap : Math.min(window, cap);
  return {
    window: window === "auto" ? 0 : window,
    applied: window === "auto" ? 0 : from,
    lower: AUTOCOMPACT_WINDOWS.filter((w) => w < from).at(-1) ?? 0,
    higher: AUTOCOMPACT_WINDOWS.find((w) => w > from && w <= cap) ?? 0,
  };
}
