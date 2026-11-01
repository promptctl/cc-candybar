// brandon-menu-ia-q30.jl1: the two template arguments the `◀ label ▶` picker
// is built from — a carousel whose label fires an action of the author's, and a
// picker that is a row of a disclosure body and so draws no ✕ of its own.
import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame } from "../src/render/frame";
import { linksOf } from "../src/click/read";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { DISCLOSURE_GLYPH_CLOSE } from "../src/config/disclosure";
import { effectsOf } from "./helpers/click";
import { cellWidth as cellLength } from "../src/render/picker";
import { instantOf } from "../src/utils/instant";
import { ColorSpec, contrastRatio } from "@promptctl/rich-js";
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
): Frame {
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
  return drawPayload(config, compiled, store, registry, PAYLOAD, instantOf(new Date()), {
    ...OPTS,
    width,
  }).frame;
}

describe("{{ carousel }} names what it sets", () => {
  test("the arrows step; the label fires the named action and writes nothing of its own", () => {
    const out = renderOf('{{ carousel "pick" "hello" "zoom" }}');
    expect(textOf(out)).toContain("◀ zoom ▶");
    const writes = (text: string) =>
      effectsOf(linksOf(out).find((l) => l.text === text)!.url);
    expect(writes("◀")[0]!.args.slice(1)).toEqual(["zoom", "low"]);
    expect(writes("▶")[0]!.args.slice(1)).toEqual(["zoom", "high"]);
    expect(writes("zoom").some((e) => e.args[1] === "zoom")).toBe(false);
  });

  test("an open action naming nothing declared is refused: at load when spelled, at render when computed", () => {
    expect(() => renderOf('{{ carousel "pick" "nope" "zoom" }}')).toThrow(
      /template references unknown action "nope" \(in a picker, menu, carousel, swatch, swatches or themePreview\)/,
    );
    expect(
      textOf(renderOf('{{ carousel "pick" (printf "no%s" "pe") "zoom" }}')),
    ).toMatch(/open must name a declared action/);
  });

  test("a computed open leaves a spelled label a label, never an action name", () => {
    expect(
      textOf(renderOf('{{ $o := "hello" }}{{ carousel "pick" $o "zoom" }}')),
    ).toContain("zoom");
  });

  test("a computed label that comes up empty is refused: a control needs a name", () => {
    expect(
      textOf(renderOf('{{ carousel "pick" "hello" (printf "") }}')),
    ).toMatch(/label is empty/);
  });

  test("an open action that writes a bound value is refused: the label binds none", () => {
    for (const open of ["pick", "page"]) {
      expect(
        textOf(renderOf(`{{ carousel "pick" "${open}" "zoom" }}`)),
      ).toMatch(/writes a value the template binds/);
    }
  });

  test("an unset key steps from the first option", () => {
    const out = renderOf('{{ carousel "pick" "hello" "zoom" }}', "");
    const next = linksOf(out).find((l) => l.text === "▶")!;
    expect(effectsOf(next.url)[0]!.args.slice(1)).toEqual(["zoom", "mid"]);
  });

  test("a label computed at render is drawn like a spelled one", () => {
    const out = renderOf('{{ carousel "pick" "hello" (printf "%s!" "zoom") }}');
    expect(textOf(out)).toContain("◀ zoom! ▶");
  });
});

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
    const out = drawPayload(
      config,
      compiled,
      store,
      registry,
      PAYLOAD,
      instantOf(new Date()),
      OPTS,
    ).frame;
    expect(textOf(out)).toContain("Claude Code's status line");
    // The ✕'s own run.
    const close = out.rows
      .flatMap(({ runs }) => runs)
      .find(({ text }) => text === DISCLOSURE_GLYPH_CLOSE);
    expect(close).toBeDefined();
    const { fg, bg } = close!;
    expect(fg).toBeDefined();
    expect(bg).toBeDefined();
    expect(
      contrastRatio(
        ColorSpec.parse(fg!).getTruecolor(),
        ColorSpec.parse(bg!).getTruecolor(),
      ),
    ).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
  });
});

describe("{{ picker }} inBody", () => {
  const closes = (out: Frame) =>
    linksOf(out).filter((l) => l.text === DISCLOSURE_GLYPH_CLOSE);

  test("a standalone picker leads with its own ✕", () => {
    expect(closes(renderOf('{{ picker "pick" "page" false true }}'))).toHaveLength(1);
  });

  test("a picker in a body draws no ✕: the body's own ✕ closes it", () => {
    const out = renderOf('{{ picker "pick" "page" false true true }}');
    expect(closes(out)).toHaveLength(0);
    expect(textOf(out)).toMatch(/low mid high/);
  });

  test("closeOnPick in a body is refused: the body's ✕ is not the picker's to fold", () => {
    expect(
      textOf(renderOf('{{ picker "pick" "page" true true true }}')),
    ).toMatch(/sets both closeOnPick and inBody/);
  });

  test("a picker in a body pages at the body row's whole width, wasting no column", () => {
    // In an open body the ✕ is the body's cell, so the narrowest width at
    // which the options stand on one page is the width their row fills.
    const inBody = (width: number): Frame =>
      renderOf(
        '{{ picker "pick" "page" false true true }}',
        "mid",
        width,
        "{ kind: 'group', name: 'g', label: 'G', open: true, children: ['s'] }",
      );
    let width = 1;
    while (textOf(inBody(width)).includes("→")) width++;
    const row = textOf(inBody(width))
      .split("\n")
      .find((line) => line.includes("low"))!;
    expect(cellLength(row)).toBe(width);
  });
});
