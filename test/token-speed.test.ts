// Token-speed segment (brandon-usage-cob). Four layers, same shape as the
// burn-rate ticket it builds on:
//   1. the pure projection math (projectTokensPerSecond),
//   2. the SessionUsageStore retaining the prior (counts, time) sample — the
//      single owner of per-session totals, no parallel counter,
//   3. buildRenderPayload folding the prev+cur pair into speed.{in,out,total}
//      under the closure gate,
//   4. the speed segment formatting it — including the "—" absence path.
//
// [LAW:no-silent-failure] The headline assertion across all layers: idle /
// between-turns / a too-stale baseline yields ABSENCE (missing field → -1
// default → "—"), never a stale or divide-by-zero number.

import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRenderPayload,
  projectTokensPerSecond,
  type RenderPayloadDeps,
} from "../src/daemon/render-payload";
import { SessionUsageStore } from "../src/daemon/cache/session-usage-store";
import { clearParseCache } from "../src/utils/claude";
import type { ClaudeHookData } from "../src/utils/claude";
import { ABSENT, ok } from "../src/utils/outcome";
import {
  mergeWithDefault,
  parseDslConfig,
  validateConfig,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { PaletteResolver, getThemePalette } from "@promptctl/rich-js";

// ─── projectTokensPerSecond (pure) ───────────────────────────────────────────

describe("projectTokensPerSecond (pure)", () => {
  test("500 tokens over 1s → 500 tok/s", () => {
    expect(projectTokensPerSecond(1000, 0, 1500, 1000)).toBe(500);
  });

  test("idle: count did not advance → undefined (not 0)", () => {
    expect(projectTokensPerSecond(1000, 0, 1000, 1000)).toBeUndefined();
  });

  test("count went backwards (impossible cumulative) → undefined", () => {
    expect(projectTokensPerSecond(1000, 0, 900, 1000)).toBeUndefined();
  });

  test("window under the floor (clock barely moved) → undefined", () => {
    expect(projectTokensPerSecond(1000, 0, 1500, 10)).toBeUndefined();
  });

  test("window over the ceiling (prior sample predates idle gap) → undefined", () => {
    expect(projectTokensPerSecond(1000, 0, 1500, 30_000)).toBeUndefined();
  });
});

// ─── SessionUsageStore.observeSpeed (the prior-sample owner) ──────────────────

function usageLine(
  tag: string,
  input: number,
  output: number,
): string {
  return (
    JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: `req-${tag}`,
      costUSD: 0.01,
      message: {
        id: `msg-${tag}`,
        model: "claude-opus-4-8",
        usage: { input_tokens: input, output_tokens: output },
      },
    }) + "\n"
  );
}

describe("SessionUsageStore.observeSpeed — prior-sample retention", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-speed-"));
    clearParseCache();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("first observation has no prior sample; the second sees the first", async () => {
    const t = join(dir, "S.jsonl");
    writeFileSync(t, usageLine("a", 10, 5));
    utimesSync(t, new Date(1000), new Date(1000));
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      const first = await store.observeSpeed("S", t, 1_000);
      expect(first.kind).toBe("ok");
      if (first.kind !== "ok") return;
      expect(first.value.prev).toBeUndefined();
      // input folds the cache lanes (here zero) onto raw input; total = in + out.
      expect(first.value.cur).toMatchObject({ input: 10, output: 5, total: 15 });

      // Transcript grows by one more turn; bump mtime so the store re-parses.
      writeFileSync(t, usageLine("a", 10, 5) + usageLine("b", 10, 5));
      utimesSync(t, new Date(2000), new Date(2000));
      const second = await store.observeSpeed("S", t, 2_000);
      expect(second.kind).toBe("ok");
      if (second.kind !== "ok") return;
      expect(second.value.prev).toMatchObject({ input: 10, output: 5, atMs: 1_000 });
      expect(second.value.cur).toMatchObject({ input: 20, output: 10, atMs: 2_000 });
      // Δoutput = 5 over Δt = 1s ⇒ 5 tok/s when projected at the boundary.
      const rate = projectTokensPerSecond(
        second.value.prev!.output,
        second.value.prev!.atMs,
        second.value.cur.output,
        second.value.cur.atMs,
      );
      expect(rate).toBe(5);
    } finally {
      store.close();
    }
  });

  test("concurrent same-state observations coalesce to ONE baseline transition", async () => {
    const t = join(dir, "C.jsonl");
    writeFileSync(t, usageLine("a", 10, 5));
    utimesSync(t, new Date(1000), new Date(1000));
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      // Establish a baseline (output 5) at the first transcript state.
      await store.observeSpeed("C", t, 1_000);

      // Output grows to 25; bump mtime to the new state.
      writeFileSync(t, usageLine("a", 10, 5) + usageLine("b", 10, 20));
      utimesSync(t, new Date(2000), new Date(2000));

      // Two renders observe the SAME new state concurrently. Without the
      // single-flight, the second would see the first's just-committed sample
      // (output 25) as its prev and degrade to a zero delta. Coalesced, both
      // share ONE observation: prev = the baseline (5), cur = the new state (25).
      const [a, b] = await Promise.all([
        store.observeSpeed("C", t, 2_000),
        store.observeSpeed("C", t, 2_000),
      ]);
      expect(a.kind).toBe("ok");
      expect(b.kind).toBe("ok");
      if (a.kind !== "ok" || b.kind !== "ok") return;
      expect(a.value.prev?.output).toBe(5);
      expect(b.value.prev?.output).toBe(5);
      expect(a.value.cur.output).toBe(25);
      expect(b.value.cur.output).toBe(25);
      // Neither render lost its delta to a clobber (prev never the new state).
      expect(a.value.prev?.output).not.toBe(25);
      expect(b.value.prev?.output).not.toBe(25);
    } finally {
      store.close();
    }
  });

  test("the ring accumulates recent samples oldest→newest; prev is its last", async () => {
    const t = join(dir, "R.jsonl");
    const store = new SessionUsageStore({ sweepIntervalMs: 0 });
    try {
      // Three growing transcript states, each a distinct mtime ⇒ a new sample.
      let lines = "";
      const outputs = [5, 12, 30];
      const results = [];
      for (let i = 0; i < outputs.length; i++) {
        lines += usageLine(`t${i}`, 10, outputs[i]! - (outputs[i - 1] ?? 0));
        const ms = (i + 1) * 1000;
        writeFileSync(t, lines);
        utimesSync(t, new Date(ms), new Date(ms));
        const r = await store.observeSpeed("R", t, ms);
        expect(r.kind).toBe("ok");
        if (r.kind !== "ok") return;
        results.push(r.value);
      }
      // The ring grows by one each observation, ordered oldest→newest.
      expect(results.map((r) => r.samples.length)).toEqual([1, 2, 3]);
      const last = results[2]!;
      expect(last.samples.map((s) => s.atMs)).toEqual([1000, 2000, 3000]);
      // [LAW:one-source-of-truth] prev is exactly the ring's penultimate sample —
      // the tok/s baseline and the history fold read the same owned ring.
      expect(last.prev).toBe(last.samples[last.samples.length - 2]);
    } finally {
      store.close();
    }
  });
});

// ─── buildRenderPayload — speed lane ──────────────────────────────────────────

function depsWith(
  overrides: Partial<RenderPayloadDeps> = {},
): RenderPayloadDeps {
  return {
    gitProvider: { getGitInfo: async () => ABSENT },
    usageStore: {
      getUsageInfo: async () => ok({ session: { cost: 1, tokens: 1500 } }),
      getTodayInfo: async () => ABSENT,
      observeSpeed: async () => {
        const prev = { input: 1000, output: 1000, total: 2000, atMs: 0 };
        const cur = { input: 1000, output: 1500, total: 2500, atMs: 1000 };
        return ok({ prev, cur, samples: [prev, cur] });
      },
    },
    contextProvider: { getContextInfo: async () => ABSENT },
    metricsProvider: { getMetricsInfo: async () => ABSENT },
    tmuxService: { getSessionId: async () => ABSENT },
    sessionState: { get: () => undefined },
    log: () => {},
    clock: () => new Date(1000),
    ...overrides,
  } as unknown as RenderPayloadDeps;
}

const SPEED_PATHS = new Set([
  "speed.input",
  "speed.output",
  "speed.total",
  "session.tokens",
]);

function hook(): ClaudeHookData {
  return {
    hook_event_name: "Status",
    session_id: "speed-test",
    transcript_path: "/no/such/transcript.jsonl",
    cwd: "/tmp",
    model: { id: "x", display_name: "x" },
    workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
  } as unknown as ClaudeHookData;
}

describe("buildRenderPayload — speed lane", () => {
  test("projectable: output/total rates land; idle input lane is absent", async () => {
    const payload = await buildRenderPayload(
      hook(),
      depsWith(),
      undefined,
      SPEED_PATHS,
    );
    // Δoutput 500 / 1s = 500; Δtotal 500 / 1s = 500; Δinput 0 ⇒ absent.
    expect(payload.speed?.output).toBe(500);
    expect(payload.speed?.total).toBe(500);
    expect(payload.speed?.input).toBeUndefined();
  });

  test("first render (no prior sample) ⇒ no speed key, never a fabricated rate", async () => {
    const payload = await buildRenderPayload(
      hook(),
      depsWith({
        usageStore: {
          getUsageInfo: async () => ok({ session: { cost: 1, tokens: 1500 } }),
          getTodayInfo: async () => ABSENT,
          observeSpeed: async () => {
            const cur = { input: 10, output: 5, total: 15, atMs: 1000 };
            return ok({ cur, samples: [cur] });
          },
        } as unknown as RenderPayloadDeps["usageStore"],
      }),
      undefined,
      SPEED_PATHS,
    );
    expect(payload.speed).toBeUndefined();
  });

  test("burn-rate history projects each adjacent total-lane pair; idle gaps are 0", async () => {
    const payload = await buildRenderPayload(
      hook(),
      depsWith({
        usageStore: {
          getUsageInfo: async () => ok({ session: { cost: 1, tokens: 1500 } }),
          getTodayInfo: async () => ABSENT,
          observeSpeed: async () => {
            // total/atMs: 0@0, 100@1s (+100/s), 100@2s (idle ⇒ 0), 400@3s (+300/s).
            const samples = [
              { input: 0, output: 0, total: 0, atMs: 0 },
              { input: 0, output: 100, total: 100, atMs: 1000 },
              { input: 0, output: 100, total: 100, atMs: 2000 },
              { input: 0, output: 400, total: 400, atMs: 3000 },
            ];
            return ok({
              prev: samples[2],
              cur: samples[3]!,
              samples,
            });
          },
        } as unknown as RenderPayloadDeps["usageStore"],
      }),
      undefined,
      new Set(["speed.history"]),
    );
    expect(payload.speed?.history).toBe("100,0,300");
  });

  test("a single-sample ring yields no history (needs two samples for one bar)", async () => {
    const payload = await buildRenderPayload(
      hook(),
      depsWith({
        usageStore: {
          getUsageInfo: async () => ok({ session: { cost: 1, tokens: 1500 } }),
          getTodayInfo: async () => ABSENT,
          observeSpeed: async () => {
            const cur = { input: 10, output: 5, total: 15, atMs: 1000 };
            return ok({ cur, samples: [cur] });
          },
        } as unknown as RenderPayloadDeps["usageStore"],
      }),
      undefined,
      new Set(["speed.history"]),
    );
    expect(payload.speed).toBeUndefined();
  });

  test("gating: speed omitted from the closure ⇒ no speed key (lane not pulled)", async () => {
    const payload = await buildRenderPayload(
      hook(),
      depsWith(),
      undefined,
      new Set(["session.tokens"]),
    );
    expect(payload.speed).toBeUndefined();
  });
});

// ─── speed segment render ─────────────────────────────────────────────────────

const ALLOWED = new Set(listResolvablePaletteNames());

function renderSpeed(payload: Record<string, unknown>): string {
  const raw = parseDslConfig("<test>", `{ root: { h: ["speed"] } }`, ALLOWED);
  const cfg = validateConfig(
    mergeWithDefault(raw, DEFAULT_DSL_CONFIG),
    "<test>",
    "{}",
    ALLOWED,
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(store);
  try {
    const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp" });
    const bp = new PaletteResolver(
      getThemePalette(cfg.globals.palette ?? "catppuccin-latte")!,
    );
    return renderDsl(cfg, compiled, store, registry, payload, bp, {
      style: "powerline",
      colorCompatibility: "none",
      width: Number.POSITIVE_INFINITY,
    });
  } finally {
    registry.dispose();
  }
}

const SEG_BASE = {
  hook_event_name: "Status",
  session_id: "seg-test",
  cwd: "/tmp",
  model: { id: "x", display_name: "x" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
};

describe("speed segment render", () => {
  test("live lanes format as 'N/s' (K-scaled); idle lane reads '—'", () => {
    const line = renderSpeed({
      ...SEG_BASE,
      session: { tokens: 1500 },
      speed: { output: 1500, total: 1500 }, // input absent ⇒ -1 ⇒ "—"
    });
    expect(line).toContain("1.5K/s"); // formatTokenCount K-scaling
    expect(line).toContain("out");
    expect(line).toContain("in —");
    expect(line).toContain("tot");
  });

  test("all lanes absent render '—' (the -1 default), never a fake number", () => {
    const line = renderSpeed({ ...SEG_BASE, session: { tokens: 1500 } });
    expect(line).toContain("—");
    expect(line).not.toMatch(/\d\/s/); // no tok/s figure anywhere
  });

  test("hidden when the session has done no work (tokens 0)", () => {
    const line = renderSpeed({ ...SEG_BASE });
    expect(line.trim()).toBe("");
  });
});
