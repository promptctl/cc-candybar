// [LAW:dataflow-not-control-flow] buildRenderPayload's provider gating is
// derived from the DslConfig's layout-reachable input paths. This test pins
// the contract by counting provider invocations against two configs that
// differ only in `layout` — same declared variables, different layouts.

import {
  buildRenderPayload,
  buildNeededPrefixes,
} from "../src/daemon/render-payload";
import type { RenderPayloadDeps } from "../src/daemon/render-payload";
import type { DslConfig, LayoutNode } from "../src/config/dsl-types";

// One vertical container, one cells leaf — the canonical root for a single row.
const rootOf = (...segments: string[]): LayoutNode => ({
  kind: "container",
  direction: "vertical",
  children: [{ kind: "cells", segments }],
});

interface CallCounts {
  git: number;
  usage: number;
  today: number;
  context: number;
  metrics: number;
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
    usageStore: {
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
  root: rootOf("directory", "git"),
  widgets: {},
};

const CONFIG_WITH_METRICS: DslConfig = {
  globals: {},
  variables: SHARED_VARIABLES,
  segments: SHARED_SEGMENTS,
  root: rootOf("directory", "git", "metrics", "tmux"),
  widgets: {},
};

describe("buildRenderPayload — layout-driven provider gating", () => {
  test("providers whose payload prefix is not reachable from layout do not fire", async () => {
    const { deps, counts } = buildMockDeps();
    await buildRenderPayload(
      HOOK_DATA,
      deps,
      undefined,
      buildNeededPrefixes(CONFIG_WITHOUT_METRICS),
    );
    expect(counts.git).toBe(1);
    // No segment in layout reads metrics.* / tmux.* / today.* / etc., so
    // those providers are not invoked.
    expect(counts.metrics).toBe(0);
    expect(counts.tmux).toBe(0);
    expect(counts.today).toBe(0);
    expect(counts.context).toBe(0);
    expect(counts.usage).toBe(0);
  });

  test("adding a segment to layout brings its provider online", async () => {
    const { deps, counts } = buildMockDeps();
    await buildRenderPayload(
      HOOK_DATA,
      deps,
      undefined,
      buildNeededPrefixes(CONFIG_WITH_METRICS),
    );
    expect(counts.git).toBe(1);
    expect(counts.metrics).toBe(1);
    expect(counts.tmux).toBe(1);
    // Still no today/context/usage/block — they have no segments in this
    // layout either.
    expect(counts.today).toBe(0);
    expect(counts.context).toBe(0);
    expect(counts.usage).toBe(0);
  });

  test("namespace-only refs (e.g. {{ toJson .git }}) expand to all child paths", async () => {
    // Layout segment references the entire `.git` namespace, not a leaf.
    // The scope proxy treats this as iterating the namespace; the gate
    // must pull in every git.* declared input path, not just the literal
    // `git` ref.
    const config: DslConfig = {
      globals: {},
      variables: SHARED_VARIABLES,
      segments: {
        gitDump: {
          template: " {{ toJson .git }} ",
          bg: "surface",
          fg: "foreground",
        },
      },
      root: rootOf("gitDump"),
      widgets: {},
    };
    const needed = buildNeededPrefixes(config);
    // The only declared `git.*` input is `git.branch`; it must be in
    // the closure even though the template references `.git`, not
    // `.git.branch`.
    expect(needed.has("git.branch")).toBe(true);
  });

  test("a container `when` keeps its referenced input prefix reachable (no segment references it)", () => {
    // The reachability walk seeds from EVERY node's `when`, not just cells/
    // segments. A container gated on `.metrics.sessionDuration` whose only
    // rendered segment is `directory` must still pull metrics into the closure —
    // otherwise the provider gates out and the predicate can never become true.
    const config: DslConfig = {
      globals: {},
      variables: SHARED_VARIABLES,
      segments: SHARED_SEGMENTS,
      root: {
        kind: "container",
        direction: "vertical",
        when: '{{ gt (int .metrics.sessionDuration) 0 }}',
        children: [{ kind: "cells", segments: ["directory"] }],
      },
      widgets: {},
    };
    const needed = buildNeededPrefixes(config);
    expect(needed.has("metrics.sessionDuration")).toBe(true);
    // `directory`'s own input is reachable too (sanity).
    expect(needed.has("workspace.current_dir")).toBe(true);
    // `tmux`/`git` are referenced by neither the container `when` nor the one
    // rendered segment, so they stay gated out.
    expect(needed.has("tmux.session")).toBe(false);
  });
});
