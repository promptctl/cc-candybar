// [LAW:dataflow-not-control-flow] buildRenderPayload's provider gating is
// derived from the DslConfig's layout-reachable input paths. This test pins
// the contract by counting provider invocations against two configs that
// differ only in `layout` — same declared variables, different layouts.

import { buildRenderPayload } from "../src/daemon/render-payload";
import type { RenderPayloadDeps } from "../src/daemon/render-payload";
import type { DslConfig } from "../src/config/dsl-types";

interface CallCounts {
  git: number;
  usage: number;
  today: number;
  context: number;
  metrics: number;
  block: number;
  tmux: number;
  theme: number;
}

function buildMockDeps(): { deps: RenderPayloadDeps; counts: CallCounts } {
  const counts: CallCounts = {
    git: 0,
    usage: 0,
    today: 0,
    context: 0,
    metrics: 0,
    block: 0,
    tmux: 0,
    theme: 0,
  };
  const deps = {
    gitProvider: {
      getGitInfo: async () => {
        counts.git++;
        return null;
      },
    },
    usageProvider: {
      getUsageInfo: async () => {
        counts.usage++;
        return {
          session: {
            cost: 0,
            calculatedCost: 0,
            officialCost: 0,
            tokens: 0,
            tokenBreakdown: null,
          },
        };
      },
    },
    todayProvider: {
      getTodayInfo: async () => {
        counts.today++;
        return { cost: 0, tokens: 0, tokenBreakdown: null, date: "" };
      },
    },
    contextProvider: {
      getContextInfo: async () => {
        counts.context++;
        return null;
      },
    },
    metricsProvider: {
      getMetricsInfo: async () => {
        counts.metrics++;
        return {
          responseTime: null,
          lastResponseTime: null,
          sessionDuration: null,
          messageCount: null,
          linesAdded: null,
          linesRemoved: null,
        };
      },
    },
    blockProvider: {
      getActiveBlockInfo: async () => {
        counts.block++;
        return null;
      },
    },
    tmuxService: {
      getSessionId: async () => {
        counts.tmux++;
        return null;
      },
    },
    sessionState: {
      get: (_sid: string, _key: string) => {
        counts.theme++;
        return undefined;
      },
    },
  } as unknown as RenderPayloadDeps;
  return { deps, counts };
}

const HOOK_DATA = {
  hook_event_name: "Status",
  session_id: "test-session",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/tmp",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
};

// Two configs sharing the same variable declarations; only `layout` differs.
const SHARED_VARIABLES: DslConfig["variables"] = {
  current_dir: { kind: "input", path: "workspace.current_dir", default: "" },
  "git.branch": { kind: "input", path: "git.branch", default: "" },
  "metrics.sessionDuration": {
    kind: "input",
    path: "metrics.sessionDuration",
    type: "number",
    default: 0,
  },
  "tmux.session": { kind: "input", path: "tmux.session", default: "" },
};

const SHARED_SEGMENTS: DslConfig["segments"] = {
  directory: { template: " {{ .current_dir }} ", bg: "surface", fg: "foreground" },
  git: {
    template: " {{ .git.branch }} ",
    bg: "panel",
    fg: "foreground",
    when: '{{ ne .git.branch "" }}',
  },
  metrics: {
    template: " {{ .metrics.sessionDuration }} ",
    bg: "panel",
    fg: "foreground",
  },
  tmux: {
    template: " {{ .tmux.session }} ",
    bg: "surface",
    fg: "foreground",
  },
};

const CONFIG_WITHOUT_METRICS: DslConfig = {
  globals: {},
  variables: SHARED_VARIABLES,
  segments: SHARED_SEGMENTS,
  layout: ["directory", "git"],
};

const CONFIG_WITH_METRICS: DslConfig = {
  globals: {},
  variables: SHARED_VARIABLES,
  segments: SHARED_SEGMENTS,
  layout: ["directory", "git", "metrics", "tmux"],
};

describe("buildRenderPayload — layout-driven provider gating", () => {
  test("providers whose payload prefix is not reachable from layout do not fire", async () => {
    const { deps, counts } = buildMockDeps();
    await buildRenderPayload(HOOK_DATA, deps, undefined, CONFIG_WITHOUT_METRICS);
    expect(counts.git).toBe(1);
    // No segment in layout reads metrics.* / tmux.* / today.* / etc., so
    // those providers are not invoked.
    expect(counts.metrics).toBe(0);
    expect(counts.tmux).toBe(0);
    expect(counts.today).toBe(0);
    expect(counts.context).toBe(0);
    expect(counts.usage).toBe(0);
    expect(counts.block).toBe(0);
  });

  test("adding a segment to layout brings its provider online", async () => {
    const { deps, counts } = buildMockDeps();
    await buildRenderPayload(HOOK_DATA, deps, undefined, CONFIG_WITH_METRICS);
    expect(counts.git).toBe(1);
    expect(counts.metrics).toBe(1);
    expect(counts.tmux).toBe(1);
    // Still no today/context/usage/block — they have no segments in this
    // layout either.
    expect(counts.today).toBe(0);
    expect(counts.context).toBe(0);
    expect(counts.usage).toBe(0);
    expect(counts.block).toBe(0);
  });
});
