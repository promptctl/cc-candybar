import { DISCLOSURE_GLYPH_CLOSED } from "../src/config/disclosure";
import { HELP_TEXT } from "../src/help-text";

describe("HELP_TEXT", () => {
  // [LAW:one-source-of-truth] The glyph is read from the synthesis that renders
  // it, not spelled again here.
  test("points at the settings menu, with the glyph the bar actually renders", () => {
    expect(HELP_TEXT).toMatch(/theme\/look\/style\/wrap\/padding controls/i);
    expect(HELP_TEXT).toContain(`☰ ${DISCLOSURE_GLYPH_CLOSED}`);
    expect(HELP_TEXT).toMatch(/persist\?/);
  });
});
