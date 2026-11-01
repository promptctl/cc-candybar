// [LAW:verifiable-goals] brandon-effects-2gka.m0t: a render is drawn at ONE
// instant, the one its caller hands drawDsl, and every time read inside it —
// a segment template's `now`, a template variable's `now`, a `time` variable —
// reads that instant and nothing else.

import { drawPayload } from "./helpers/draw-payload";
import { textOf } from "../src/render/frame";
import type { Frame, Run } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { SessionState } from "../src/daemon/session-state";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { instantOf, type Instant } from "../src/utils/instant";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 1,
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
  readonly render: (at: Instant) => Frame;
  readonly dispose: () => void;
} {
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  const compiled = registerDslConfig(CONFIG, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
  return {
    render: (at) =>
      drawPayload(CONFIG, compiled, store, registry, {}, at, OPTS).frame,
    dispose: () => registry.dispose(),
  };
}

describe("a render is drawn at the instant its caller hands it", () => {
  test("{{ unixEpoch now }} is the injected instant", () => {
    const { render, dispose } = renderer();
    try {
      expect(textOf(render(instantOf(A)))).toContain(`[${epochOf(A)}|`);
    } finally {
      dispose();
    }
  });

  test("every time read in one render reads the one instant — segment and variable alike", () => {
    const { render, dispose } = renderer();
    try {
      const text = textOf(render(instantOf(A)));
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
      const movedOn = (run: Run): Run => ({
        ...run,
        text: run.text.replaceAll(epochOf(A), epochOf(B)).replaceAll("12:34:56", "12:34:57"),
      });
      expect(atB.rows).not.toEqual(atA.rows);
      expect(atB.rows).toEqual(
        atA.rows.map((row) => ({ ...row, runs: row.runs.map(movedOn) })),
      );
      // And back: nothing the first render computed is kept past its instant.
      expect(render(instantOf(A)).rows).toEqual(atA.rows);
    } finally {
      dispose();
    }
  });
});

// brandon-unfiled-3248.8ro6 step 3: the payload stores instants, and what they
// say relative to now is the draw's — so a frame drawn after the read that
// stored them shows the age and the ETA it is drawn at.
describe("a stored instant is read against the frame's instant", () => {
  const BUNDLED = parseAndValidate(
    "<test>",
    `{
      segments: {
        ages: { template: "{{ .git.timeSinceCommit }}s {{ .block.etaMinutes }}m" },
      },
      root: { h: ["ages"] },
    }`,
    undefined,
    DEFAULT_DSL_CONFIG,
  );
  const AT = 1_700_000_000;
  // Committed a minute before AT; 20% of a 5 h window used in its first hour.
  const PAYLOAD = {
    session_id: "s",
    git: { committedAt: AT - 60 },
    block: { nativeUtilization: 20, resetsAt: AT + 4 * 3600 },
  };

  test("one payload, two frames: each draws its own age and ETA", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(
      processLauncher,
      store,
      "",
      new SessionState(),
    );
    try {
      const compiled = registerDslConfig(BUNDLED, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
      const draw = (sec: number): string =>
        textOf(
          drawPayload(
            BUNDLED,
            compiled,
            store,
            registry,
            PAYLOAD,
            instantOf(new Date(sec * 1000)),
            OPTS,
          ).frame,
        );
      expect(draw(AT)).toContain("60s 240m");
      // An hour on, nothing re-read: an hour older, and the same use over two
      // hours reaches the cap later.
      expect(draw(AT + 3600)).toContain("3660s 480m");
    } finally {
      registry.dispose();
    }
  });

  test("no commit date reads as no age, and an unused window as no ETA", () => {
    const store = new VariableStore();
    const registry = new SourceRegistry(
      processLauncher,
      store,
      "",
      new SessionState(),
    );
    try {
      const compiled = registerDslConfig(BUNDLED, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
      expect(
        textOf(
          drawPayload(
            BUNDLED,
            compiled,
            store,
            registry,
            { session_id: "s" },
            instantOf(new Date(AT * 1000)),
            OPTS,
          ).frame,
        ),
      ).toContain("0s -1m");
    } finally {
      registry.dispose();
    }
  });
});
