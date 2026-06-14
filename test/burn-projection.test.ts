// Burn-rate + cap-projection segment (brandon-usage-4be). Three layers:
//   1. the pure projection math (projectEtaMinutes / projectCostPerHour),
//   2. buildRenderPayload folding it into the payload under the closure gate,
//   3. the burnrate segment formatting it — including the "—" absence path.
//
// [LAW:no-silent-failure] The headline assertion across all three: a window or
// session too young to project yields ABSENCE (a missing field → the -1 default
// → "—"), never a fabricated number.

import {
  buildRenderPayload,
  projectCostPerHour,
  projectEtaMinutes,
  type RenderPayloadDeps,
} from "../src/daemon/render-payload";
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

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const NOW_MS = 1_700_000_000_000; // fixed instant; NOW_MS / 1000 is whole seconds
const NOW_SEC = NOW_MS / 1000;

describe("projectEtaMinutes (pure)", () => {
  test("linear extrapolation: 20% used, 1h elapsed of a 5h window → 4h to cap", () => {
    // Resets in 4h ⇒ 1h elapsed ⇒ 20%/h ⇒ 80% headroom ⇒ 240 minutes.
    const resetsAt = NOW_SEC + 4 * 3600;
    expect(projectEtaMinutes(20, resetsAt, FIVE_HOUR_MS, NOW_MS)).toBe(240);
  });

  test("too young to project (under the 5-minute floor) → undefined", () => {
    const resetsAt = NOW_SEC + (5 * 3600 - 120); // 2 minutes elapsed
    expect(projectEtaMinutes(5, resetsAt, FIVE_HOUR_MS, NOW_MS)).toBeUndefined();
  });

  test("no usage yet (0%) → undefined (cannot divide by a zero rate)", () => {
    const resetsAt = NOW_SEC + 1 * 3600; // 4h elapsed, plenty of time
    expect(projectEtaMinutes(0, resetsAt, FIVE_HOUR_MS, NOW_MS)).toBeUndefined();
  });

  test("already at the cap (100%) → clamped to 0, never negative", () => {
    const resetsAt = NOW_SEC + 4 * 3600;
    expect(projectEtaMinutes(100, resetsAt, FIVE_HOUR_MS, NOW_MS)).toBe(0);
  });
});

describe("projectCostPerHour (pure)", () => {
  test("$6 over half an hour → $12/hr", () => {
    expect(projectCostPerHour(6, 1800)).toBe(12);
  });

  test("under the wall-clock floor → undefined (single-turn artifact)", () => {
    expect(projectCostPerHour(6, 30)).toBeUndefined();
  });

  test("real $0 over enough time → a true 0/hr, not absence", () => {
    expect(projectCostPerHour(0, 3600)).toBe(0);
  });
});

// ─── buildRenderPayload integration ────────────────────────────────────────────

function depsWith(
  overrides: Partial<RenderPayloadDeps> = {},
): RenderPayloadDeps {
  return {
    gitProvider: { getGitInfo: async () => ABSENT },
    usageStore: {
      getUsageInfo: async () => ok({ session: { cost: 6, tokens: 1000 } }),
      getTodayInfo: async () => ABSENT,
    },
    contextProvider: { getContextInfo: async () => ABSENT },
    metricsProvider: {
      getMetricsInfo: async () =>
        ok({
          responseTime: 0,
          lastResponseTime: null,
          sessionDuration: 1800,
          messageCount: 0,
          linesAdded: 0,
          linesRemoved: 0,
        }),
    },
    tmuxService: { getSessionId: async () => ABSENT },
    sessionState: { get: () => undefined },
    log: () => {},
    clock: () => new Date(NOW_MS),
    ...overrides,
  } as unknown as RenderPayloadDeps;
}

function hookWithWindows() {
  return {
    hook_event_name: "Status",
    session_id: "burn-test",
    transcript_path: "/no/such/transcript.jsonl",
    cwd: "/tmp",
    model: { id: "claude-opus-4-7", display_name: "Opus" },
    workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
    rate_limits: {
      five_hour: { used_percentage: 20, resets_at: NOW_SEC + 4 * 3600 },
      seven_day: { used_percentage: 14, resets_at: NOW_SEC + 6 * 86400 },
    },
  };
}

const BURN_PATHS = new Set([
  "burn",
  "burn.costPerHour",
  "block.nativeUtilization",
  "block.resetsAt",
  "block.etaMinutes",
  "weekly.percentage",
  "weekly.resetsAt",
  "weekly.etaMinutes",
]);

describe("buildRenderPayload — burn projection lane", () => {
  test("projectable: burn rate + block & weekly ETAs land in the payload", async () => {
    const payload = await buildRenderPayload(
      hookWithWindows(),
      depsWith(),
      undefined,
      BURN_PATHS,
    );
    expect(payload.burn?.costPerHour).toBe(12);
    expect(payload.block?.etaMinutes).toBe(240);
    expect(payload.weekly?.etaMinutes).toBeGreaterThan(0);
  });

  test("young window: block keeps its util/reset but ETA is ABSENT, not 0", async () => {
    const hook = hookWithWindows();
    // 2 minutes into the 5h window — under the projection floor.
    hook.rate_limits.five_hour.resets_at = NOW_SEC + (5 * 3600 - 120);
    const payload = await buildRenderPayload(
      hook,
      depsWith(),
      undefined,
      BURN_PATHS,
    );
    expect(payload.block?.nativeUtilization).toBe(20);
    expect(payload.block?.etaMinutes).toBeUndefined();
  });

  test("gating: burn omitted from the closure ⇒ no burn key (lanes not pulled)", async () => {
    const payload = await buildRenderPayload(
      hookWithWindows(),
      depsWith(),
      undefined,
      new Set(["block.resetsAt", "weekly.resetsAt"]),
    );
    expect(payload.burn).toBeUndefined();
  });
});

// ─── burnrate segment render ────────────────────────────────────────────────────

const ALLOWED = new Set(listResolvablePaletteNames());

function renderBurnrate(payload: Record<string, unknown>): string {
  const raw = parseDslConfig(
    "<test>",
    `{ root: { h: ["burnrate"] } }`,
    ALLOWED,
  );
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

describe("burnrate segment render", () => {
  test("projectable values format as '$/hr · Nm to cap'", () => {
    const line = renderBurnrate({
      ...SEG_BASE,
      burn: { costPerHour: 12 },
      block: { nativeUtilization: 20, resetsAt: NOW_SEC + 4 * 3600, etaMinutes: 240 },
      weekly: { percentage: 14, resetsAt: NOW_SEC + 6 * 86400, etaMinutes: 8846 },
    });
    expect(line).toContain("$12.00/hr");
    expect(line).toContain("4h to 5h");
    expect(line).toContain("to wk");
    expect(line).not.toContain("—");
  });

  test("absent projections render '—' (the -1 default), never a fake number", () => {
    // Window active (so the segment shows) but nothing projectable: burn,
    // block.eta and weekly.eta fall to their -1 default.
    const line = renderBurnrate({
      ...SEG_BASE,
      block: { nativeUtilization: 2, resetsAt: NOW_SEC + 4 * 3600 },
      weekly: { percentage: 1, resetsAt: NOW_SEC + 6 * 86400 },
    });
    expect(line).toContain("—/hr");
    expect(line).toContain("—");
    expect(line).not.toMatch(/\$\d/); // no dollar figure
  });

  test("hidden when no rate-limit window is active", () => {
    const line = renderBurnrate({ ...SEG_BASE });
    expect(line.trim()).toBe("");
  });
});
