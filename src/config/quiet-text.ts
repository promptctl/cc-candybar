// Quiet text: a cell's de-emphasised foreground, shared by every bundled cell
// that draws structure rather than facts (gitaculous's quiet tokens, the
// settings menu's inert `◁`).
//
// The blend target is the segment's OWN background (`bgOf`), not the theme's
// `background`. Such cells wear their address's vocabulary tint, so a
// palette `foreground-muted` — which blends toward `background` — would be
// muted toward a color that is not behind them, and would read either too
// loud or too faint depending on how far the tint sits from the base.
//
// The `readableOn` floor is what makes the result theme-independent, and it is
// not decoration: the bare 60% blend measures 1.93–3.10 contrast across the
// bundled themes (catppuccin-latte at 1.93 is genuinely hard to read), because
// a fixed *percentage* of a distance is not a fixed amount of legibility when
// themes disagree about how far apart their own foreground and surface sit.
// Flooring at WCAG's 3:1 large-text threshold lands every theme at 3.00–3.10
// against full-strength foregrounds of 5.8–10.9 — as quiet as each theme can
// afford, and never quieter. Verified across the bundled themes in
// test/default-dsl-config.test.ts rather than eyeballed on one.
// [LAW:verifiable-goals]
const QUIET_PCT = 60;
export const QUIET_MIN_CONTRAST = 3;
// A template expression (no braces), so a caller can spell it as a whole `fg:`
// (`{{ … }}`) or nest it as an argument (`(…)`).
export const QUIET_TEXT =
  `readableOn (mix (color "foreground") (bgOf) ${QUIET_PCT}) (bgOf) ` +
  `${QUIET_MIN_CONTRAST}`;
