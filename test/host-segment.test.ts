// The host/SSH segment (candybar-segments-e7u).
//
// The contract under test is a provenance split, and every assertion here
// defends one half of it [LAW:one-source-of-truth]:
//
//   • hostname/username are MACHINE facts. Client and daemon are the same
//     machine by construction (UID-derived socket), so the daemon reads them
//     directly and they are always present.
//   • SSH-ness is a SESSION fact. One detached daemon serves a local session
//     and an SSH session simultaneously, so it can ONLY arrive as a client
//     hint — and a hint that never arrived must stay distinguishable from a
//     hint that said "local" [LAW:no-silent-failure].
//
// [LAW:behavior-not-structure] Everything below asserts observable behavior:
// what lands in the payload, and whether the bundled segment renders.

import os from "node:os";

import {
  buildRenderPayload,
  shortHostname,
} from "../src/daemon/render-payload";
import type {
  EffectiveGlobals,
  RenderPayloadDeps,
} from "../src/daemon/render-payload";
import type { ClientHints } from "../src/daemon/protocol";
import { ABSENT } from "../src/utils/outcome";
import { RAW_DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { registerDslConfig, renderDsl } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { paletteForThemeName } from "../src/themes/palette-resolvers";

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
  separator: undefined,
};

const DEPS = {
  gitProvider: { getGitInfo: async () => ABSENT },
  usageStore: {
    getUsageInfo: async () => ABSENT,
    getTodayInfo: async () => ABSENT,
  },
  contextProvider: { getContextInfo: async () => ABSENT },
  metricsProvider: { getMetricsInfo: async () => ABSENT },
  tmuxService: { getSessionId: async () => ABSENT },
  log: () => {},
} as unknown as RenderPayloadDeps;

const HOOK = {
  hook_event_name: "Status",
  session_id: "host-seg-test",
  cwd: "/tmp",
  model: { id: "m", display_name: "M" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
} as never;

const payloadWith = (hints: ClientHints) =>
  buildRenderPayload(HOOK, DEPS, "/tmp", new Set(), EFFECTIVE_GLOBALS, hints);

describe("shortHostname", () => {
  test("takes everything before the first dot — zsh's %m, not %M", () => {
    expect(shortHostname("web1.prod.example.com")).toBe("web1");
    expect(shortHostname("mymachine.local")).toBe("mymachine");
  });

  test("passes a already-short hostname through untouched", () => {
    expect(shortHostname("myserver")).toBe("myserver");
  });

  test("is total on degenerate input rather than throwing or yielding null", () => {
    expect(shortHostname("")).toBe("");
    expect(shortHostname(".leading")).toBe("");
  });
});

describe("host identity in the render payload", () => {
  test("machine facts come from the daemon itself, no hint required", async () => {
    const payload = await payloadWith({});
    expect(payload.host.name).toBe(shortHostname(os.hostname()));
    expect(payload.host.user).toBe(os.userInfo().username);
  });

  test("a reported SSH session lands as ssh:true", async () => {
    expect((await payloadWith({ ssh: true })).host.ssh).toBe(true);
  });

  test("a reported local session lands as ssh:false — present, not absent", async () => {
    const { host } = await payloadWith({ ssh: false });
    expect(host.ssh).toBe(false);
    expect("ssh" in host).toBe(true);
  });

  // The heart of it: an unreported session must NOT be laundered into a
  // confident "local". It stays absent, which routes it through the DSL input
  // fallback chain — declared default AND a recorded last_error.
  test("an unreported session leaves ssh ABSENT, never false", async () => {
    const { host } = await payloadWith({});
    expect("ssh" in host).toBe(false);
    expect(host.ssh).toBeUndefined();
  });

  // The daemon's own SSH_* env belongs to whichever shell spawned it, which is
  // very often NOT the session being rendered. Consulting it as a "helpful"
  // fallback would mislabel every session that daemon serves.
  test("the daemon ignores its OWN SSH_* env — only the hint decides", async () => {
    const saved = process.env.SSH_CONNECTION;
    process.env.SSH_CONNECTION = "10.0.0.1 51000 10.0.0.2 22";
    try {
      expect((await payloadWith({})).host.ssh).toBeUndefined();
      expect((await payloadWith({ ssh: false })).host.ssh).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SSH_CONNECTION;
      else process.env.SSH_CONNECTION = saved;
    }
  });
});

describe("the bundled host segment", () => {
  // Through the real load pipeline, so the segment under test is the one a
  // user actually gets — parse + merge + validate, not a hand-built object.
  const CONFIG = parseAndValidate(
    "<default>",
    JSON.stringify(RAW_DEFAULT_DSL_CONFIG, null, 2),
  );

  function render(host: Record<string, unknown>): string {
    const store = new VariableStore();
    const registry = new SourceRegistry(store, "", undefined, new SessionState());
    try {
      const compiled = registerDslConfig(CONFIG, registry, {
        cwd: "/tmp",
      });
      return renderDsl(
        CONFIG,
        compiled,
        store,
        registry,
        { ...(HOOK as object), host } as never,
        paletteForThemeName(EFFECTIVE_GLOBALS.theme),
        {
          style: "powerline" as const,
          colorCompatibility: "none" as const,
          wrap: true,
          padding: 1,
          charset: "unicode" as const,
          width: Number.POSITIVE_INFINITY,
        },
      );
    } finally {
      registry.dispose();
    }
  }

  test("renders user@host when the session came in over SSH", () => {
    expect(render({ name: "bigbox", user: "brandon", ssh: true })).toContain(
      "⇄ brandon@bigbox",
    );
  });

  // [LAW:dataflow-not-control-flow] Presence IS the signal — no mode, no flag.
  test("is entirely absent on a local session", () => {
    expect(render({ name: "bigbox", user: "brandon", ssh: false })).not.toContain(
      "bigbox",
    );
  });

  test("is absent when the client never reported, matching pre-feature output", () => {
    expect(render({ name: "bigbox", user: "brandon" })).not.toContain("bigbox");
  });

  // A failed hostname/username read must still say "you are remote" rather than
  // rendering a blank that reads as a rendering bug [LAW:no-silent-failure].
  test("still marks the session remote when the identity could not be read", () => {
    expect(render({ ssh: true })).toContain("⇄ ?@?");
  });
});
