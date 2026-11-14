// The windows the bar offers: Claude Code's whole accepted range, in the 100K
// steps its controls move by. Each is one declared `slash` action per
// instance of the control (src/config/autocompact-control.ts), so these are
// also the only lines a click on it can type.
export const AUTOCOMPACT_WINDOWS: readonly number[] = Array.from(
  { length: 10 },
  (_, i) => (i + 1) * 100_000,
);
export const LEAST = AUTOCOMPACT_WINDOWS[0]!;
export const MOST = AUTOCOMPACT_WINDOWS[AUTOCOMPACT_WINDOWS.length - 1]!;

// [LAW:types-are-the-program] `auto` is not a number of tokens: under it the
// window is Claude Code's to choose, and nothing it exposes says what it chose.
export type AutoCompactWindow = number | "auto";

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
