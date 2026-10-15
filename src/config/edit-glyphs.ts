// [LAW:one-source-of-truth] The glyphs edit mode draws on the bar. Edit chrome
// renders them and the help corpus (`src/help-text.ts`) names them, so they live
// below both: a help line that says what a glyph does cannot name a glyph the
// bar no longer draws.
export const REMOVE_GLYPH = "✖";
export const ADD_GLYPH = "✚";
// A default emoji (Emoji_Presentation): two cells with no selector. A
// text-default glyph made two cells by VS16 (the gear, U+2699 U+FE0F) is drawn
// one cell by a terminal that ignores the selector, a column narrower than the
// bar measured it (`test/glyph-width.test.ts`).
export const CONFIGURE_GLYPH = "🔧";
