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

import { textOf } from "../src/render/frame";
import { drawPayload } from "./helpers/draw-payload";
import type { Frame } from "../src/render/frame";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import os from "node:os";

import { HostService, shortHostname, HOST_PERIOD_MS } from "../src/segments/host";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import { Holds } from "../src/utils/holds";
import type { RenderPayloadDeps } from "../src/daemon/render-payload";
import { type EffectiveGlobals } from "../src/config/effective-globals";
import { globalsFor } from "./helpers/selection";
import type { ClientHints } from "../src/daemon/protocol";
import { ABSENT } from "../src/utils/outcome";
import {
  RAW_DEFAULT_DSL_CONFIG,
  DEFAULT_DSL_CONFIG,
} from "../src/config/default-dsl-config";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { registerDslConfig } from "../src/dsl/render";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { SessionState } from "../src/daemon/session-state";
import { NO_CONFIG_FILE } from "./helpers/config-file-facts";
import { instantOf } from "../src/utils/instant";
import {
  absentOwners,
  fakeActivity,
  fakeContext,
  fakeGit,
  fakeMetrics,
  fakeTmux,
  fakeUsage,
  requestPayload,
} from "./helpers/payload-owners";

const EFFECTIVE_GLOBALS: EffectiveGlobals = globalsFor(DEFAULT_DSL_CONFIG);

const DEPS = {
  ...absentOwners(),
  gitProvider: fakeGit(async () => ABSENT),
  usageStore: fakeUsage({
    usage: async () => ABSENT,
    today: () => ABSENT,
  }),
  contextProvider: fakeContext(async () => ABSENT),
  metricsProvider: fakeMetrics(async () => ABSENT),
  activityProvider: fakeActivity(async () => ABSENT),
  tmuxService: fakeTmux(async () => ABSENT),
  log: () => {},
  history: () => EMPTY_HISTORY_DEPTH,
  navigation: () => 0,
  feeds: () => UNFOLLOWED_FEEDS,
} as unknown as RenderPayloadDeps;

const HOOK = {
  hook_event_name: "Status",
  session_id: "host-seg-test",
  cwd: "/tmp",
  model: { id: "m", display_name: "M" },
  workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
} as never;

// The host segment's reads: its name and user are sources, `ssh` the hint.
const HOST_PATHS = new Set(["host.name", "host.user", "host.ssh"]);

const payloadWith = (hints: ClientHints) =>
  requestPayload(
    HOOK,
    instantOf(new Date()),
    DEPS,
    "/tmp",
    HOST_PATHS,
    EFFECTIVE_GLOBALS,
    hints,
    NO_CONFIG_FILE,
  );

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

describe("the host's sources", () => {
  // [LAW:effects-at-boundaries] A process that only imports the daemon (a CLI
  // subcommand) builds the providers and renders nothing: it reads neither.
  test("nothing is read until a view declares it", async () => {
    const ledger = new RefreshLedger();
    const host = new HostService({ ledger });
    const counts = () =>
      ledger.snapshot().map((r) => [r.name, r.refreshes.first]);
    expect(counts()).toEqual([
      ["host.name", 0],
      ["host.user", 0],
    ]);
    const holds = new Holds();
    host.declareName(holds);
    host.declareUser(holds);
    await new Promise((r) => setImmediate(r));
    expect(counts()).toEqual([
      ["host.name", 1],
      ["host.user", 1],
    ]);
    expect(host.held()).toBe(2);
    holds.close();
    host.close();
  });

  // The name follows the network, so a daemon that lives for days shows the
  // name it has now; a user lookup that failed is tried again.
  test("a held name and user are asked again on their period", async () => {
    jest.useFakeTimers();
    const hostname = jest.spyOn(os, "hostname").mockReturnValue("before.lan");
    const ledger = new RefreshLedger();
    const host = new HostService({ ledger });
    const holds = new Holds();
    try {
      const name = host.declareName(holds);
      host.declareUser(holds);
      await jest.advanceTimersByTimeAsync(0);
      expect(name.current()).toEqual({ kind: "ok", value: "before" });

      hostname.mockReturnValue("after.vpn");
      await jest.advanceTimersByTimeAsync(HOST_PERIOD_MS);
      expect(name.current()).toEqual({ kind: "ok", value: "after" });
      expect(
        ledger.snapshot().map((r) => [r.name, r.refreshes]),
      ).toEqual([
        ["host.name", { first: 1, period: 1, change: 0, supersede: 0 }],
        ["host.user", { first: 1, period: 1, change: 0, supersede: 0 }],
      ]);
    } finally {
      holds.close();
      host.close();
      hostname.mockRestore();
      jest.useRealTimers();
    }
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

  function render(host: Record<string, unknown>): Frame {
    const store = new VariableStore();
    const registry = new SourceRegistry(
      processLauncher,
      store,
      "",
      new SessionState(),
    );
    try {
      const compiled = registerDslConfig(CONFIG, registry, {
        signer: TEST_SIGNER,
        cwd: "/tmp",
      });
      return drawPayload(
        CONFIG,
        compiled,
        store,
        registry,
        { ...(HOOK as object), host } as never,
        instantOf(new Date()),
        {
          endcaps: "powerline" as const,
          colorCompatibility: "none" as const,
          wrap: true,
          padding: 1,
          width: Number.POSITIVE_INFINITY,
        },
      ).frame;
    } finally {
      registry.dispose();
    }
  }

  test("renders user@host when the session came in over SSH", () => {
    expect(textOf(render({ name: "bigbox", user: "brandon", ssh: true }))).toContain(
      "⇄ brandon@bigbox",
    );
  });

  // [LAW:dataflow-not-control-flow] Presence IS the signal — no mode, no flag.
  test("is entirely absent on a local session", () => {
    expect(
      textOf(render({ name: "bigbox", user: "brandon", ssh: false })),
    ).not.toContain("bigbox");
  });

  test("is absent when the client never reported, matching pre-feature output", () => {
    expect(textOf(render({ name: "bigbox", user: "brandon" }))).not.toContain("bigbox");
  });

  // A failed hostname/username read must still say "you are remote" rather than
  // rendering a blank that reads as a rendering bug [LAW:no-silent-failure].
  test("still marks the session remote when the identity could not be read", () => {
    expect(textOf(render({ ssh: true }))).toContain("⇄ ?@?");
  });
});
