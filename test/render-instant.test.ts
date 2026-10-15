// [LAW:verifiable-goals] brandon-effects-2gka.m0t: a render is drawn at ONE
// instant, the one its caller hands renderDsl, and every time read inside it —
// a segment template's `now`, a template variable's `now`, a `time` variable —
// reads that instant and nothing else.

import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { instantOf, type Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { stripAnsi } from "./helpers/ansi";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 1,
  charset: "unicode" as const,
  width: Number.POSITIVE_INFINITY,
};

// Two segments read the time three ways each; a third reads none.
const CONFIG = parseAndValidate(
  "<test>",
  `{
    variables: {
      "epoch.var": { kind: "template", template: "{{ unixEpoch now }}" },
      "clock.var": { kind: "time", layout: "15:04:05" },
    },
    segments: {
      stamp: { template: '[{{ unixEpoch now }}|{{ unixEpoch now }}|{{ .epoch.var }}]' },
      clock: { template: '<{{ date "15:04:05" now }}|{{ .clock.var }}>' },
      still: { template: "unchanging" },
    },
    root: { h: ["stamp", "clock", "still"] },
  }`,
);

// Built from local fields: `date` and a `time` variable format in local time,
// so the clock text is the same wherever the suite runs.
const A = new Date(2026, 5, 4, 12, 34, 56);
const B = new Date(2026, 5, 4, 12, 34, 57);
const epochOf = (d: Date): string => String(Math.floor(d.getTime() / 1000));

function renderer(): {
  readonly render: (at: Instant) => string;
  readonly dispose: () => void;
} {
  const store = new VariableStore();
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  const compiled = registerDslConfig(CONFIG, registry, { cwd: "/tmp" });
  return {
    render: (at) =>
      renderDsl(CONFIG, compiled, store, registry, {}, at, OPTS),
    dispose: () => registry.dispose(),
  };
}

describe("a render is drawn at the instant its caller hands it", () => {
  test("{{ unixEpoch now }} is the injected instant", () => {
    const { render, dispose } = renderer();
    try {
      expect(stripAnsi(render(instantOf(A)))).toContain(`[${epochOf(A)}|`);
    } finally {
      dispose();
    }
  });

  test("every time read in one render reads the one instant — segment and variable alike", () => {
    const { render, dispose } = renderer();
    try {
      const text = stripAnsi(render(instantOf(A)));
      expect(text).toContain(`[${epochOf(A)}|${epochOf(A)}|${epochOf(A)}]`);
      expect(text).toContain("<12:34:56|12:34:56>");
    } finally {
      dispose();
    }
  });

  test("two renders at different instants differ only where a template reads the time", () => {
    const { render, dispose } = renderer();
    try {
      const atA = render(instantOf(A));
      const atB = render(instantOf(B));
      expect(atB).not.toBe(atA);
      expect(atB).toBe(
        atA.replaceAll(epochOf(A), epochOf(B)).replaceAll("12:34:56", "12:34:57"),
      );
      // And back: nothing the first render computed is kept past its instant.
      expect(render(instantOf(A))).toBe(atA);
    } finally {
      dispose();
    }
  });
});
