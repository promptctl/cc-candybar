// brandon-menu-ia-q30.jl1: the two template arguments the `◀ value ▶` picker
// is built from — a carousel whose centre fires an action of the author's, and a
// picker that is a row of a disclosure body and so draws no ✕ of its own.
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

const OPTS = {
  endcaps: "plain" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  charset: "unicode" as const,
  width: 200,
};
const PAYLOAD = { session_id: "s1", workspace: { current_dir: "/tmp/proj" } };

function renderOf(template: string, current = "mid"): string {
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
      root: { rows: { identity: { h: ['s'] }, status: { h: [] } } },
    }`,
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(config, registry, { cwd: "/tmp/proj" });
  return renderDsl(config, compiled, store, registry, PAYLOAD, OPTS);
}

describe("{{ carousel }} with a centre action", () => {
  test("the arrows still step; the centre shows the option and fires the named action", () => {
    const out = renderOf('{{ carousel "pick" 0 "hello" }}');
    expect(stripAnsi(out)).toMatch(/◀ mid ▶/);
    const writes = (text: string) =>
      effectsOf(links(out).find((l) => stripAnsi(l.text) === text)!.url);
    expect(writes("◀")[0]!.args.slice(1)).toEqual(["zoom", "low"]);
    expect(writes("▶")[0]!.args.slice(1)).toEqual(["zoom", "high"]);
    // The centre fires the named action, never a write of `zoom`.
    expect(writes("mid").some((e) => e.args[1] === "zoom")).toBe(false);
  });

  test("a centre naming no declared action is refused", () => {
    expect(stripAnsi(renderOf('{{ carousel "pick" 0 "nope" }}'))).toMatch(
      /centre must name a declared action/,
    );
  });

  test("an unknown current value centres on the first option, still clickable", () => {
    // The value an empty or stale key holds is no option: the centre shows
    // the first, the one ▶ steps from, and its click still fires.
    const out = renderOf('{{ carousel "pick" 0 "hello" }}', "");
    expect(stripAnsi(out)).toMatch(/◀ low ▶/);
    expect(links(out).some((l) => stripAnsi(l.text) === "low")).toBe(true);
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
});
