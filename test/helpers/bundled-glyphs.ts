// The private-use glyphs the bundled bar draws, in the order the doctor
// gathers them: the powerline joiner's arrow, then the effort gauge's chevrons
// and the caps of max's bubble. Literal, not derived: the doctor's gathering
// is what the suites holding this test.
export const BUNDLED_GLYPHS =
  "\u{E0B0}\u{F0143}\u{F013F}\u{F0DBC}\u{E0B6}\u{E0B4}";

const codePoints = [...BUNDLED_GLYPHS].map((g) =>
  g.codePointAt(0)!.toString(16),
);

// As the doctor's event spells them: `glyphs=e0b0,f0143,…`.
export const BUNDLED_GLYPHS_LOGGED = codePoints.join(",");

// As a sighting and a verdict spell them: `U+E0B0 U+F0143 …`.
export const BUNDLED_GLYPHS_NAMED = codePoints
  .map((c) => `U+${c.toUpperCase()}`)
  .join(" ");
