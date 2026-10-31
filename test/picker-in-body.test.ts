// brandon-menu-ia-q30.jl1: the two template arguments the `◀ label ▶` picker
// is built from — a carousel whose label fires an action of the author's, and a
// picker that is a row of a disclosure body and so draws no ✕ of its own.
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { DISCLOSURE_GLYPH_CLOSE } from "../src/config/disclosure";
import { effectsOf } from "./helpers/click";
import { links, stripAnsi } from "./helpers/ansi";
import { cellWidth as cellLength } from "../src/render/picker";
import { instantOf } from "../src/utils/instant";
import { ColorRgba, contrastRatio } from "@promptctl/rich-js";
import { TEXT_MIN_CONTRAST } from "../src/themes/decor";

const OPTS = {
  endcaps: "plain" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: 200,
};
const PAYLOAD = { session_id: "s1", workspace: { current_dir: "/tmp/proj" } };

function renderOf(
  template: string,
  current = "mid",
  width = 200,
  host = "'s'",
): string {
  const config = parseAndValidate(
    "<user>",
    `{
      variables: { zoom: { kind: 'state', key: 'zoom', default: '${current}' } },
      actions: {
        pick: { set: 'zoom', from: ['low', 'mid', 'high'] },
        page: { set: 'zoom.page', int: true },
        hello: { copy: 'hi' },
      },
      segments: { s: { template: ${JSON.stringify(template)} } },
      root: { rows: { identity: { h: [${host}] }, status: { h: [] } } },
    }`,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp/proj" });
  return renderDsl(config, compiled, store, registry, PAYLOAD, instantOf(new Date()), {
    ...OPTS,
    width,
  });
}

describe("{{ carousel }} names what it sets", () => {
  test("the arrows step; the label fires the named action and writes nothing of its own", () => {
    const out = renderOf('{{ carousel "pick" "hello" "zoom" }}');
    expect(stripAnsi(out)).toContain("◀ zoom ▶");
    const writes = (text: string) =>
      effectsOf(links(out).find((l) => stripAnsi(l.text) === text)!.url);
    expect(writes("◀")[0]!.args.slice(1)).toEqual(["zoom", "low"]);
    expect(writes("▶")[0]!.args.slice(1)).toEqual(["zoom", "high"]);
    expect(writes("zoom").some((e) => e.args[1] === "zoom")).toBe(false);
  });

  test("an open action naming nothing declared is refused: at load when spelled, at render when computed", () => {
    expect(() => renderOf('{{ carousel "pick" "nope" "zoom" }}')).toThrow(
      /template references unknown action "nope" \(in a picker, menu, carousel, swatch, swatches or themePreview\)/,
    );
    expect(
      stripAnsi(renderOf('{{ carousel "pick" (printf "no%s" "pe") "zoom" }}')),
    ).toMatch(/open must name a declared action/);
  });

  test("a computed open leaves a spelled label a label, never an action name", () => {
    expect(
      stripAnsi(renderOf('{{ $o := "hello" }}{{ carousel "pick" $o "zoom" }}')),
    ).toContain("zoom");
  });

  test("a computed label that comes up empty is refused: a control needs a name", () => {
    expect(
      stripAnsi(renderOf('{{ carousel "pick" "hello" (printf "") }}')),
    ).toMatch(/label is empty/);
  });

  test("an open action that writes a bound value is refused: the label binds none", () => {
    for (const open of ["pick", "page"]) {
      expect(
        stripAnsi(renderOf(`{{ carousel "pick" "${open}" "zoom" }}`)),
      ).toMatch(/writes a value the template binds/);
    }
  });

  test("an unset key steps from the first option", () => {
    const out = renderOf('{{ carousel "pick" "hello" "zoom" }}', "");
    const next = links(out).find((l) => stripAnsi(l.text) === "▶")!;
    expect(effectsOf(next.url)[0]!.args.slice(1)).toEqual(["zoom", "mid"]);
  });

  test("a label computed at render is drawn like a spelled one", () => {
    const out = renderOf('{{ carousel "pick" "hello" (printf "%s!" "zoom") }}');
    expect(stripAnsi(out)).toContain("◀ zoom! ▶");
  });
});

// The text and background colours an SGR run sets, truecolor.
const sgrColours = (
  sgr: string,
): { fg: ColorRgba | null; bg: ColorRgba | null } => {
  const at = (code: "38" | "48"): ColorRgba | null => {
    const m = new RegExp(`${code};2;(\\d+);(\\d+);(\\d+)`).exec(sgr);
    return m === null ? null : new ColorRgba(+m[1]!, +m[2]!, +m[3]!);
  };
  return { fg: at("38"), bg: at("48") };
};

describe("{{ picker }} over a catalogue", () => {
  // [LAW:one-source-of-truth] A catalogue's drops open the segment's band, so
  // its first row is drawn on the band's state colour: the ✕ there is chosen
  // for that ground, not for the segment's closed one.
  test("its ✕ is legible on the colour its row is drawn on", () => {
    const config = parseAndValidate(
      "<user>",
      `{
        variables: { r: { kind: 'state', key: 'r', default: 'claude' } },
        actions: {
          pickR: { set: 'r', from: 'renderers' },
          pageR: { set: 'r.page', int: true },
        },
        segments: { s: { template: '{{ picker "pickR" "pageR" false true }}' } },
        root: { rows: { identity: { h: ['s'] }, status: { h: [] } } },
      }`,
      new Set(listResolvablePaletteNames()),
      DEFAULT_DSL_CONFIG,
    );
    const store = new VariableStore();
    const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
    const compiled = registerDslConfig(config, registry, {
      signer: TEST_SIGNER,
      cwd: "/tmp/proj",
    });
    const out = renderDsl(
      config,
      compiled,
      store,
      registry,
      PAYLOAD,
      instantOf(new Date()),
      OPTS,
    );
    expect(stripAnsi(out)).toContain("Claude Code's status line");
    // The ✕'s own SGR run: the escape sequence right before the glyph.
    const runs = [...out.matchAll(/\x1b\[([0-9;]*)m([^\x1b]*)/gu)];
    const close = runs.find(([, , text]) => text === DISCLOSURE_GLYPH_CLOSE);
    expect(close).toBeDefined();
    const { fg, bg } = sgrColours(close![1]!);
    expect(fg).not.toBeNull();
    expect(bg).not.toBeNull();
    expect(contrastRatio(fg!, bg!)).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
  });
});

describe("{{ picker }} inBody", () => {
  const closes = (out: string) =>
    links(out).filter((l) => stripAnsi(l.text) === DISCLOSURE_GLYPH_CLOSE);

  test("a standalone picker leads with its own ✕", () => {
    expect(closes(renderOf('{{ picker "pick" "page" false true }}'))).toHaveLength(1);
  });

  test("a picker in a body draws no ✕: the body's own ✕ closes it", () => {
    const out = renderOf('{{ picker "pick" "page" false true true }}');
    expect(closes(out)).toHaveLength(0);
    expect(stripAnsi(out)).toMatch(/low mid high/);
  });

  test("closeOnPick in a body is refused: the body's ✕ is not the picker's to fold", () => {
    expect(
      stripAnsi(renderOf('{{ picker "pick" "page" true true true }}')),
    ).toMatch(/sets both closeOnPick and inBody/);
  });

  test("a picker in a body pages at the body row's whole width, wasting no column", () => {
    // In an open body the ✕ is the body's cell, so the narrowest width at
    // which the options stand on one page is the width their row fills.
    const inBody = (width: number): string =>
      renderOf(
        '{{ picker "pick" "page" false true true }}',
        "mid",
        width,
        "{ kind: 'group', name: 'g', label: 'G', open: true, children: ['s'] }",
      );
    let width = 1;
    while (stripAnsi(inBody(width)).includes("→")) width++;
    const row = stripAnsi(inBody(width))
      .split("\n")
      .find((line) => line.includes("low"))!;
    expect(cellLength(row)).toBe(width);
  });
});
