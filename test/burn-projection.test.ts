// Burn-rate + cap-projection segment (brandon-usage-4be). Three layers:
//   1. the pure projection math (etaMinutes / projectCostPerHour),
//   2. payloadOf folding the burn rate into the payload under the
//      closure gate (the ETAs are the draw's, from the windows' instants),
//   3. the burnrate segment formatting it — including the "—" absence path.
//
// [LAW:no-silent-failure] The headline assertion across all three: a window or
// session too young to project yields ABSENCE (a missing field → the -1 default
// → "—"), never a fabricated number.

import { textOf } from "../src/render/frame";
import { drawPayload } from "./helpers/draw-payload";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import {
  projectCostPerHour,
  type RenderPayloadDeps,
} from "../src/daemon/render-payload";
import { type EffectiveGlobals } from "../src/config/effective-globals";
import { globalsFor } from "./helpers/selection";
import type { ClientHints } from "../src/daemon/protocol";
import { ABSENT, ok } from "../src/utils/outcome";
import { validateConfig } from "./helpers/parse-and-validate";
import {
  mergeWithDefault,
  parseDslConfig,
} from "../src/config/dsl-loader";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { registerDslConfig } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { NO_CONFIG_FILE } from "./helpers/config-file-facts";
import { instantOf } from "../src/utils/instant";
import { etaMinutes } from "../src/template-engine/funcs";
import {
  absentOwners,
  fakeContext,
  fakeGit,
  fakeMetrics,
  fakeTmux,
  fakeUsage,
  requestPayload,
  settled,
} from "./helpers/payload-owners";

const FIVE_HOURS_MIN = 5 * 60;
const NOW_MS = 1_700_000_000_000; // fixed instant; NOW_MS / 1000 is whole seconds
const NOW_SEC = NOW_MS / 1000;

describe("etaMinutes (pure)", () => {
  test("linear extrapolation: 20% used, 1h elapsed of a 5h window → 4h to cap", () => {
    // Resets in 4h ⇒ 1h elapsed ⇒ 20%/h ⇒ 80% headroom ⇒ 240 minutes.
    const resetsAt = NOW_SEC + 4 * 3600;
    expect(etaMinutes(20, resetsAt, FIVE_HOURS_MIN, NOW_MS)).toBe(240);
  });

  test("too young to project (under the 5-minute floor) → -1", () => {
    const resetsAt = NOW_SEC + (5 * 3600 - 120); // 2 minutes elapsed
    expect(etaMinutes(5, resetsAt, FIVE_HOURS_MIN, NOW_MS)).toBe(-1);
  });

  test("no usage yet (0%) → -1 (cannot divide by a zero rate)", () => {
    const resetsAt = NOW_SEC + 1 * 3600; // 4h elapsed, plenty of time
    expect(etaMinutes(0, resetsAt, FIVE_HOURS_MIN, NOW_MS)).toBe(-1);
  });

  test("already at the cap (100%) → clamped to 0, never negative", () => {
    const resetsAt = NOW_SEC + 4 * 3600;
    expect(etaMinutes(100, resetsAt, FIVE_HOURS_MIN, NOW_MS)).toBe(0);
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

// ─── payloadOf integration ────────────────────────────────────────────

function depsWith(
  overrides: Partial<RenderPayloadDeps> = {},
): RenderPayloadDeps {
  return {
    ...absentOwners(),
    gitProvider: fakeGit(async () => ABSENT),
    usageStore: fakeUsage({
      usage: async () => ok({ session: { cost: 6, tokens: 1000 } }),
      today: () => ABSENT,
    }),
    contextProvider: fakeContext(async () => ABSENT),
    metricsProvider: fakeMetrics(async () =>
      ok({
        responseTime: 0,
        lastResponseTime: null,
        sessionDuration: 1800,
        messageCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
      }),
    ),
    tmuxService: fakeTmux(async () => ABSENT),
    log: () => {},
    history: () => EMPTY_HISTORY_DEPTH,
    navigation: () => 0,
    feeds: () => UNFOLLOWED_FEEDS,
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
  "weekly.percentage",
  "weekly.resetsAt",
]);

// The daemon-resolved effective globals; these burn-lane tests don't exercise
// them, so any well-formed struct satisfies the required argument.
// No client hints: these fixtures exercise the daemon-side folds, not the wire
// boundary. An empty object is the honest "this render carried no hints"
// (the shape an old client produces), so `host.ssh` stays absent throughout.
const NO_HINTS: ClientHints = {};

const EFFECTIVE_GLOBALS: EffectiveGlobals = globalsFor(DEFAULT_DSL_CONFIG);

describe("payloadOf — burn projection lane", () => {
  test("projectable: the burn rate and both windows' instants land in the payload", async () => {
    const payload = await requestPayload(
      hookWithWindows(),
      instantOf(new Date(NOW_MS)),
      depsWith(),
      undefined,
      BURN_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );
    expect(settled(payload.burn)?.costPerHour).toBe(12);
    // [LAW:one-source-of-truth] Instants, never the ETA a later frame would
    // read stale: what they say relative to now is the draw's.
    expect(payload.block).toEqual({
      nativeUtilization: 20,
      resetsAt: NOW_SEC + 4 * 3600,
    });
    expect(payload.weekly).toEqual({
      percentage: 14,
      resetsAt: NOW_SEC + 6 * 86400,
    });
  });

  test("gating: burn omitted from the closure ⇒ no burn key (lanes not pulled)", async () => {
    const payload = await requestPayload(
      hookWithWindows(),
      instantOf(new Date(NOW_MS)),
      depsWith(),
      undefined,
      new Set(["block.resetsAt", "weekly.resetsAt"]),
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );
    expect(payload.burn).toBeUndefined();
  });
});

// ─── burnrate segment render ────────────────────────────────────────────────────

const ALLOWED = new Set(listResolvablePaletteNames());

function renderBurnrate(
  payload: Record<string, unknown>,
  atMs: number = NOW_MS,
): Frame {
  const raw = parseDslConfig(
    "<test>",
    `{ root: { h: ["burnrate"] } }`,
    ALLOWED,
  );
  const cfg = validateConfig(
    { config: mergeWithDefault(raw, DEFAULT_DSL_CONFIG), raw, source: "{}" },
    "<test>",
    ALLOWED,
  );
  const store = new VariableStore();
  // The settings menu references `edit.toggle`, so `edit.mode` — a `state` var — is now
  // declared regardless of this file's narrowed `burnrate`-only root; a
  // SessionState is required to declare it (matching every other
  // DEFAULT_DSL_CONFIG-based render helper) or it silently fails to declare
  // and burnrate's own `when` renders an unrelated ⚠ error cell.
  const registry = new SourceRegistry(processLauncher, store, "", new SessionState());
  try {
    const compiled = registerDslConfig(cfg, registry, { signer: TEST_SIGNER, cwd: "/tmp" });
    return drawPayload(
      cfg,
      compiled,
      store,
      registry,
      payload,
      instantOf(new Date(atMs)),
      {
        endcaps: "powerline",
        colorCompatibility: "none",
        wrap: true,
        padding: 0,
        width: Number.POSITIVE_INFINITY,
      },
    ).frame;
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
      block: { nativeUtilization: 20, resetsAt: NOW_SEC + 4 * 3600 },
      weekly: { percentage: 14, resetsAt: NOW_SEC + 6 * 86400 },
    });
    expect(textOf(line)).toContain("$12.00/hr");
    expect(textOf(line)).toContain("4h to 5h");
    expect(textOf(line)).toContain("to wk");
    expect(textOf(line)).not.toContain("—");
  });

  test("absent projections render '—' (the -1 default), never a fake number", () => {
    // Window active (so the segment shows) but nothing projectable: no burn
    // rate, and both windows two minutes old, under the projection floor.
    const line = renderBurnrate({
      ...SEG_BASE,
      block: { nativeUtilization: 2, resetsAt: NOW_SEC + (5 * 3600 - 120) },
      weekly: { percentage: 1, resetsAt: NOW_SEC + (7 * 86400 - 120) },
    });
    expect(textOf(line)).toContain("—/hr");
    expect(textOf(line)).toContain("—");
    expect(textOf(line)).not.toMatch(/\$\d/); // no dollar figure
  });

  test("the ETA is the instant's the frame is drawn at, from one payload", () => {
    // 20% used an hour into the window: 240 minutes to the cap. Drawn an hour
    // later with nothing re-read, the same use over two hours: 480 minutes.
    const payload = {
      ...SEG_BASE,
      block: { nativeUtilization: 20, resetsAt: NOW_SEC + 4 * 3600 },
      weekly: { percentage: 14, resetsAt: NOW_SEC + 6 * 86400 },
    };
    expect(textOf(renderBurnrate(payload))).toContain("4h to 5h");
    expect(textOf(renderBurnrate(payload, NOW_MS + 3600 * 1000))).toContain("8h to 5h");
  });

  test("hidden when no rate-limit window is active", () => {
    const line = renderBurnrate({ ...SEG_BASE });
    // The bar is never empty — every rendered bar carries the global settings
    // menu (candybar-settings-ui-aok.1) — so hidden is asserted as "none of
    // this segment's own content", not as an empty line.
    expect(textOf(line)).not.toContain("/hr");
    expect(textOf(line)).not.toMatch(/\$\d/);
  });
});
