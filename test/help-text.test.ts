import { DISCLOSURE_GLYPH_CLOSED } from "../src/config/disclosure";
import { HELP_TEXT } from "../src/help-text";

describe("HELP_TEXT", () => {
  // [LAW:one-source-of-truth] --help points a user at the surface the controls
  // actually live on. candybar-settings-ui-aok.3 moved every setting with a
  // session half out of the bundled drawer and into the settings menu, so text
  // naming the drawer as the theme picker's home was a lie the moment that
  // landed. The glyph is read from the synthesis that renders it, not spelled
  // again here — a renamed anchor must break this loudly.
  test("points at the settings menu, with the glyph the bar actually renders", () => {
    expect(HELP_TEXT).toMatch(/theme\/look\/style\/wrap\/padding controls/i);
    expect(HELP_TEXT).toContain(`☰ ${DISCLOSURE_GLYPH_CLOSED}`);
    expect(HELP_TEXT).toMatch(/persist\?/);
  });
});
