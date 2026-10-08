import { RichText, StyleSyntaxError } from "@promptctl/rich-js";
import { renderStripCells } from "../src/render/strip";

// A style name the render's theme does not define is a broken config. rich-js
// would draw it as no style at all; the one draw path refuses it instead, so an
// inner span fails as loudly as a fragment's own style does in the splitter.
describe("strip draw: an unresolvable style is loud", () => {
  it("throws on a span styled with a name the theme lacks", () => {
    const cell = new RichText("ab");
    cell.stylize("no-such-theme-style", 0, 1);
    expect(() =>
      renderStripCells([cell], {
        endcaps: "plain",
        colorCompatibility: "truecolor",
        wrap: false,
        padding: 1,
        charset: "unicode",
        width: 80,
      }),
    ).toThrow(StyleSyntaxError);
  });
});
