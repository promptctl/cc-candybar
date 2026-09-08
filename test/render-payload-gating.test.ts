// [LAW:dataflow-not-control-flow] Gating is derived from layout-reachable input paths.

import {
  buildRenderPayload,
  buildNeededPrefixes,
} from "../src/daemon/render-payload";
import type { ClientHints } from "../src/daemon/protocol";
import type {
  EffectiveGlobals,
  RenderPayloadDeps,
} from "../src/daemon/render-payload";
import type { DslConfig, Root } from "../src/config/dsl-types";
import { ABSENT } from "../src/utils/outcome";

const rootOf = (...segments: string[]): Root => ({
  rows: {
    main: {
      kind: "container",
      direction: "horizontal",
      children: segments.map((name) => ({ kind: "segment" as const, name })),
    },
  },
});

interface CallCounts {
  git: number;
  usage: number;
  today: number;
  context: number;
  metrics: number;
  tmux: number;
}

function buildMockDeps(): { deps: RenderPayloadDeps; counts: CallCounts } {
  const counts: CallCounts = {
    git: 0,
    usage: 0,
    today: 0,
    context: 0,
    metrics: 0,
    tmux: 0,
  };
  const deps = {
    gitProvider: {
      getGitInfo: async () => {
        counts.git++;
        return ABSENT;
      },
    },
    usageStore: {
      getUsageInfo: async () => {
        counts.usage++;
        return ABSENT;
      },
      getTodayInfo: async () => {
        counts.today++;
        return ABSENT;
      },
    },
    contextProvider: {
      getContextInfo: async () => {
        counts.context++;
        return ABSENT;
      },
    },
    metricsProvider: {
      getMetricsInfo: async () => {
        counts.metrics++;
        return ABSENT;
      },
    },
    tmuxService: {
      getSessionId: async () => {
        counts.tmux++;
        return ABSENT;
      },
    },
    log: () => {},
  } as unknown as RenderPayloadDeps;
  return { deps, counts };
}

// These tests assert provider CALL COUNTS, not values, so any well-formed struct does.
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

const HOOK_DATA = {
  hook_event_name: "Status",
  session_id: "test-session",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/tmp",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
};

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
  actions: {},
  looks: {},
  presets: {},
  helpers: {},
  editGlobals: {},
};

const CONFIG_WITH_METRICS: DslConfig = {
  globals: {},
  variables: SHARED_VARIABLES,
  segments: SHARED_SEGMENTS,
  root: rootOf("directory", "git", "metrics", "tmux"),
  actions: {},
  looks: {},
  presets: {},
  helpers: {},
  editGlobals: {},
};

describe("buildRenderPayload — layout-driven provider gating", () => {
  test("providers whose payload prefix is not reachable from layout do not fire", async () => {
    const { deps, counts } = buildMockDeps();
    await buildRenderPayload(
      HOOK_DATA,
      deps,
      undefined,
      buildNeededPrefixes(CONFIG_WITHOUT_METRICS),
      EFFECTIVE_GLOBALS,
      NO_HINTS,
    );
    expect(counts.git).toBe(1);
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
      EFFECTIVE_GLOBALS,
      NO_HINTS,
    );
    expect(counts.git).toBe(1);
    expect(counts.metrics).toBe(1);
    expect(counts.tmux).toBe(1);
    expect(counts.today).toBe(0);
    expect(counts.context).toBe(0);
    expect(counts.usage).toBe(0);
  });

  test("namespace-only refs (e.g. {{ toJson .git }}) expand to all child paths", async () => {
    // A namespace ref must pull in every declared git.* path, not just the ref.
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
      actions: {},
      looks: {},
      presets: {},
      helpers: {},
      editGlobals: {},
    };
    const needed = buildNeededPrefixes(config);
    expect(needed.has("git.branch")).toBe(true);
  });

  test("a container `when` keeps its referenced input prefix reachable (no segment references it)", () => {
    // The walk seeds from EVERY node's `when`; otherwise the provider gates out
    // and the predicate can never become true.
    const config: DslConfig = {
      globals: {},
      variables: SHARED_VARIABLES,
      segments: SHARED_SEGMENTS,
      root: {
        rows: { main: { kind: "segment", name: "directory" } },
        when: '{{ gt (int .metrics.sessionDuration) 0 }}',
      },
      actions: {},
      looks: {},
      presets: {},
      helpers: {},
      editGlobals: {},
    };
    const needed = buildNeededPrefixes(config);
    expect(needed.has("metrics.sessionDuration")).toBe(true);
    expect(needed.has("workspace.current_dir")).toBe(true);
    expect(needed.has("tmux.session")).toBe(false);
  });
});
