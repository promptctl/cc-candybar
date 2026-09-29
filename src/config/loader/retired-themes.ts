// [LAW:one-source-of-truth] Theme names the registry no longer installs: old
// name → the theme that replaced it. `dark`/`light` were second names for the
// textual palettes, and a second name put a step in every theme carousel that
// recoloured nothing (brandon-theme-picker-bgw.exj.dw1) — but the settings
// menu's own save could write them, so a file may still hold one. The loader
// refuses it [LAW:no-silent-failure] and names the theme to write instead. A
// future retirement is one row here.
// A Map, not an object literal: an authored name is user data.
const RETIRED_THEMES: ReadonlyMap<string, string> = new Map([
  ["dark", "textual-dark"],
  ["light", "textual-light"],
]);

// The sentence appended to an unknown-theme refusal — empty for a name that
// was never installed, so both refusal sites spell it the same way.
export function retiredThemeNote(name: unknown): string {
  const to = typeof name === "string" ? RETIRED_THEMES.get(name) : undefined;
  return to === undefined
    ? ""
    : ` — "${name as string}" was retired; write "${to}", the same palette`;
}
