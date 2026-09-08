// [LAW:no-silent-failure] A window too young to project yields ABSENCE (a
// missing field → the -1 default → "—"), never a fabricated number.

import {
  buildRenderPayload,
  projectCostPerHour,
  projectEtaMinutes,
  type EffectiveGlobals,

  type RenderPayloadDeps,
} from "../src/daemon/render-payload";
import type { ClientHints } from "../src/daemon/protocol";
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
import { SessionState } from "../src/daemon/session-state";
import { getThemePalette } from "@promptctl/rich-js";

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

describe("projectEtaMinutes (pure)", () => {
  test("linear extrapolation: 20% used, 1h elapsed of a 5h window → 4h to cap", () => {
    const resetsAt = NOW_SEC + 4 * 3600;
    expect(projectEtaMinutes(20, resetsAt, FIVE_HOUR_MS, NOW_MS)).toBe(240);
  });

  test("too young to project (under the 5-minute floor) → undefined", () => {
    const resetsAt = NOW_SEC + (5 * 3600 - 120);
    expect(projectEtaMinutes(5, resetsAt, FIVE_HOUR_MS, NOW_MS)).toBeUndefined();
  });

  test("no usage yet (0%) → undefined (cannot divide by a zero rate)", () => {
    const resetsAt = NOW_SEC + 1 * 3600;
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

// No client hints: an empty object is the honest "this render carried none".
const NO_HINTS: ClientHints = {};

const EFFECTIVE_GLOBALS: EffectiveGlobals = {
  theme: "textual-dark",
  look: "none",
  preset: "default",
  presetCustomized: false,
  style: "powerline",
  charset: "unicode",
  colorCompatibility: "truecolor",
  autoWrap: true,
  padding: 1,
  updateNotice: true,
  separator: undefined,
};

describe("buildRenderPayload — burn projection lane", () => {
  test("projectable: burn rate + block & weekly ETAs land in the payload", async () => {
    const payload = await buildRenderPayload(
      hookWithWindows(),
      depsWith(),
      undefined,
      BURN_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
    );
    expect(payload.burn?.costPerHour).toBe(12);
    expect(payload.block?.etaMinutes).toBe(240);
    expect(payload.weekly?.etaMinutes).toBeGreaterThan(0);
  });

  test("young window: block keeps its util/reset but ETA is ABSENT, not 0", async () => {
    const hook = hookWithWindows();
    hook.rate_limits.five_hour.resets_at = NOW_SEC + (5 * 3600 - 120);
    const payload = await buildRenderPayload(
      hook,
      depsWith(),
      undefined,
      BURN_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
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
      EFFECTIVE_GLOBALS,
      NO_HINTS,
    );
    expect(payload.burn).toBeUndefined();
  });
});

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
  // A SessionState is required to declare `edit.mode`, or `when` renders ⚠.
  const registry = new SourceRegistry(store, "", undefined, new SessionState());
  try {
    const compiled = registerDslConfig(cfg, registry, { cwd: "/tmp" });
    const bp = getThemePalette(cfg.globals.palette ?? "catppuccin-latte")!;
    return renderDsl(cfg, compiled, store, registry, payload, bp, {
      style: "powerline",
      colorCompatibility: "none", wrap: true, padding: 0, charset: "unicode" as const,
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
    const line = renderBurnrate({
      ...SEG_BASE,
      block: { nativeUtilization: 2, resetsAt: NOW_SEC + 4 * 3600 },
      weekly: { percentage: 1, resetsAt: NOW_SEC + 6 * 86400 },
    });
    expect(line).toContain("—/hr");
    expect(line).toContain("—");
    expect(line).not.toMatch(/\$\d/);
  });

  test("hidden when no rate-limit window is active", () => {
    const line = renderBurnrate({ ...SEG_BASE });
    // Every bar carries the settings menu, so hidden is "no own content".
    expect(line).not.toContain("/hr");
    expect(line).not.toMatch(/\$\d/);
  });
});
