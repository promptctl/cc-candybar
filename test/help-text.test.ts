import { HELP_TEXT } from "../src/help-text";

describe("HELP_TEXT", () => {
  test("mentions the settings drawer and theme/look picker on the default bar", () => {
    expect(HELP_TEXT).toMatch(/theme\/look picker/i);
    expect(HELP_TEXT).toContain("⚙ settings");
  });
});
