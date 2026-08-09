import { HELP_TEXT } from "../src/help-text";

describe("HELP_TEXT", () => {
  test("mentions the theme/look picker on the default bar", () => {
    expect(HELP_TEXT).toMatch(/theme\/look picker/i);
    expect(HELP_TEXT).toContain("🎨");
    expect(HELP_TEXT).toContain("◐");
  });
});
