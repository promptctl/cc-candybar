// [LAW:verifiable-goals] brandon-unfiled-3248.ryf: a layout node's own `when`
// whose template throws costs that node, visibly, never the whole bar. A
// container — a row, the root — hides what it gates and reports a `when`
// warning naming the placements it holds; a placement's gate (`{ seg, when }`)
// draws the ⚠ cell its segment's own failing `when` draws.
//
// [LAW:single-enforcer] Drives the real spine — parse/merge/validate, then
// registerDslConfig + renderDsl.

import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { stripAnsi } from "./helpers/ansi";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import {
  registerDslConfig,
  renderDsl,
  type RenderWarning,
} from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { THEME_FLOOR } from "../src/themes";
import { instantOf } from "../src/utils/instant";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};

const FAIL = '{{ fail "the gate broke" }}';
// Fails only while the payload says it is hot, so one config shows both.
const HOT =
  '{{ if ge (int .ctx.pct) 50 }}{{ fail "hot" }}{{ else }}true{{ end }}';

const src = (root: string, extra = ""): string => `{
  variables: {
    'ctx.pct': { kind: 'input', path: 'ctx.pct', type: 'number', default: 0 },
  },
  segments: {
    ay: { template: 'AYE' },
    bee: { template: 'BEE' },
    sea: { template: 'SEA' },
    ${extra}
  },
  root: ${root},
}`;

function runtime(source: string) {
  const config = parseAndValidate(
    "<when-throws>",
    source,
    new Set([THEME_FLOOR]),
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: process.cwd() });
  const warnings: RenderWarning[] = [];
  const segmentErrors: Array<readonly [string, string]> = [];
  const render = (pct = 0): string =>
    stripAnsi(
      renderDsl(
        config,
        compiled,
        store,
        registry,
        { session_id: "s-when-throws", ctx: { pct } },
        instantOf(new Date()),
        OPTS,
        {
          onRenderWarning: (w) => warnings.push(w),
          onSegmentError: (id, message) => segmentErrors.push([id, message]),
        },
      ),
    );
  return {
    render,
    warnings,
    segmentErrors,
    dispose: () => registry.dispose(),
  };
}

const gateWarning = (where: string, error: string): RenderWarning => ({
  kind: "when",
  where,
  error: expect.stringContaining(error) as unknown as string,
  message: expect.stringMatching(
    new RegExp(`^${where}: .*${error}.* — what it gates is hidden$`),
  ) as unknown as string,
});

describe("a layout node's when that throws costs that node, not the bar", () => {
  test("a row whose when fails hides what it gates; every other row draws", () => {
    const rt = runtime(
      src(`{ v: [ { h: ['ay', 'bee'], when: '${FAIL}' }, 'sea' ] }`),
    );
    try {
      const bar = rt.render();
      expect(bar).toContain("SEA");
      expect(bar).not.toContain("AYE");
      expect(bar).not.toContain("BEE");
      expect(rt.warnings).toEqual([
        gateWarning("when over ay, bee", "the gate broke"),
      ]);
      expect(rt.segmentErrors).toEqual([]);
    } finally {
      rt.dispose();
    }
  });

  test("the root's own when failing leaves the settings door, which no gate holds", () => {
    const rt = runtime(src(`{ h: ['ay'], when: '${FAIL}' }`));
    try {
      const bar = rt.render();
      expect(bar).not.toContain("AYE");
      expect(bar).toContain("🍫");
      expect(rt.warnings).toEqual([
        gateWarning("when over ay", "the gate broke"),
      ]);
    } finally {
      rt.dispose();
    }
  });

  test("a placement's gate failing draws that placement's ⚠, as its segment's own when does", () => {
    const rt = runtime(
      src(
        `{ h: [ { seg: 'ay', when: '${FAIL}' }, 'bee' ] }`,
        `
        own: { template: 'OWN', when: '${FAIL}' },`,
      ),
    );
    try {
      const bar = rt.render();
      expect(bar).toContain("⚠ ay: the gate broke");
      expect(bar).toContain("BEE");
      expect(rt.segmentErrors).toEqual([["ay", "the gate broke"]]);
      // Not a container's: no warning beside the ⚠.
      expect(rt.warnings).toEqual([]);
    } finally {
      rt.dispose();
    }
  });

  test("a gate under a failed one is never asked: one failure, one report", () => {
    const inner = '{{ fail "inner" }}';
    const rt = runtime(
      src(
        `{ v: [ { h: [ { seg: 'ay', when: '${inner}' }, { h: ['bee'], when: '${inner}' } ], when: '${FAIL}' }, 'sea' ] }`,
      ),
    );
    try {
      const bar = rt.render();
      expect(bar).toContain("SEA");
      expect(bar).not.toContain("⚠");
      expect(rt.warnings).toEqual([
        gateWarning("when over ay, bee", "the gate broke"),
      ]);
      expect(rt.segmentErrors).toEqual([]);
    } finally {
      rt.dispose();
    }
  });

  test("the failure is per render: a render the gate decides in draws as it decides", () => {
    const rt = runtime(src(`{ v: [ { h: ['ay'], when: '${HOT}' }, 'sea' ] }`));
    try {
      expect(rt.render(10)).toContain("AYE");
      expect(rt.render(90)).not.toContain("AYE");
      expect(rt.render(10)).toContain("AYE");
      expect(rt.warnings).toEqual([gateWarning("when over ay", "hot")]);
    } finally {
      rt.dispose();
    }
  });

  test("the layout preview draws what the walk draws: a failed row's segments are not in it", () => {
    const rt = runtime(
      src(
        `{ v: [ { h: ['ay'], when: '${FAIL}' }, { h: ['bee', 'preview'] } ] }`,
        `
        preview: { template: '[{{ layoutPreview }}]' },`,
      ),
    );
    try {
      const bar = rt.render();
      expect(bar).not.toContain("⚠");
      expect(bar).not.toContain("ay");
      expect(bar).toMatch(/\[.*bee.*\]/s);
    } finally {
      rt.dispose();
    }
  });
});
