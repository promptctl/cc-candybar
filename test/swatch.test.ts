// [LAW:verifiable-goals] brandon-theme-swatch-8v9r — the swatch that stands
// beside a theme name, and the template functions built on it, measured on
// what they draw:
//
//   1. a swatch is one cell per decorative role, the role over the theme's own
//      background, as the palette names them;
//   2. `{{ swatch }}` draws the option in force, or the one named;
//   3. a swatch of a domain that names no palette is refused, naming why;
//   4. `{{ themePreview "applyAction" }}` is two rows of the selected option's
//      palette;
//   5. a link drawn in several colour runs reads as one link.
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { getThemePalette, type RichText } from "@promptctl/rich-js";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { DECOR_HUES } from "../src/themes/decor";
import { resolvedStyle } from "../src/render/rich-theme";
import { swatch, SWATCH_GLYPH } from "../src/render/swatch";
import { links, stripAnsi } from "./helpers/ansi";
import { instantOf } from "../src/utils/instant";

const OPTS = {
  endcaps: "plain" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: 200,
};
const PAYLOAD = { session_id: "s1", workspace: { current_dir: "/tmp/proj" } };

function rig(template: string) {
  const config = parseAndValidate(
    "<user>",
    `{
      globals: { palette: 'nord' },
      actions: {
        applyTheme: { set: 'theme', from: 'themes' },
        applyWord: { set: 'word', from: ['a', 'b'] },
        page: { set: 'page', int: true },
      },
      variables: {
        word: { kind: 'state', key: 'word', default: 'a' },
        page: { kind: 'state', key: 'page', default: '0' },
      },
      segments: { s: { template: ${JSON.stringify(template)} } },
      root: { rows: { identity: { h: ['s'] }, status: { h: [] } } },
    }`,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp/proj" });
  const sink = new Map<string, readonly RichText[]>();
  const rendered = renderDsl(
    config,
    compiled,
    store,
    registry,
    PAYLOAD,
    instantOf(new Date()),
    OPTS,
    { perSegmentSink: sink },
  );
  registry.dispose();
  return { rendered, cells: sink.get("s") ?? [] };
}

// Each swatch glyph's (foreground, background), in drawing order.
const swatchColours = (cells: readonly RichText[]) =>
  cells.flatMap((cell) =>
    cell.spans
      .filter((s) => cell.plain.slice(s.start, s.end) === SWATCH_GLYPH)
      .map((s) => {
        const style = resolvedStyle(s.style);
        return [style.color?.value?.hex, style.bgcolor?.value?.hex];
      }),
  );
const ofTheme = (name: string) => {
  const palette = getThemePalette(name)!;
  return DECOR_HUES.map((role) => [
    palette.get(role).hex,
    palette.get("background").hex,
  ]);
};

describe("a theme's swatch", () => {
  test.each(listResolvablePaletteNames())(
    "%s: one cell per decorative role, the role over the theme's background",
    (name) => {
      const drawn = swatch(getThemePalette(name)!);
      expect(drawn.plain).toBe(SWATCH_GLYPH.repeat(DECOR_HUES.length));
      expect(swatchColours([drawn])).toEqual(ofTheme(name));
    },
  );
});

describe("{{ swatch }}", () => {
  test("draws the option the action's key holds, or the one named", () => {
    expect(swatchColours(rig('{{ swatch "applyTheme" }}').cells)).toEqual(
      ofTheme("nord"),
    );
    expect(
      swatchColours(rig('{{ swatch "applyTheme" "dracula" }}').cells),
    ).toEqual(ofTheme("dracula"));
  });

  test("over a domain that names no palette it is refused, naming why", () => {
    expect(stripAnsi(rig('{{ swatch "applyWord" }}').rendered)).toMatch(
      /swatch references action "applyWord", whose options are not colour-valued/,
    );
  });

  test("an option outside the domain is refused, naming it, before any palette is asked for it", () => {
    expect(stripAnsi(rig('{{ swatch "applyTheme" "no-such-theme" }}').rendered)).toMatch(
      /swatch "applyTheme": "no-such-theme" is not one of its options/,
    );
  });
});

describe('{{ themePreview "applyAction" }}', () => {
  test("is two rows drawn in the palette of the option the key holds", () => {
    const text = stripAnsi(rig('{{ themePreview "applyTheme" }}').rendered);
    const lines = text.split("\n");
    const bar = lines.findIndex((l) => l.includes("~/code"));
    expect(bar).toBeGreaterThanOrEqual(0);
    expect(lines[bar + 1]).toContain("▾ open");
  });
});

describe("links()", () => {
  test("a link drawn in several colour runs reads as one link", () => {
    // A theme option in a bare picker is its name and its swatch: several
    // runs of colour, every one carrying the option's click.
    const { rendered } = rig('{{ picker "applyTheme" "page" false false }}');
    const nord = links(rendered).filter((l) =>
      stripAnsi(l.text).startsWith("nord "),
    );
    expect(nord.map((l) => stripAnsi(l.text))).toEqual(["nord ▀▀▀"]);
    expect(nord[0]!.url).toContain("theme%2Fnord");
  });
});
