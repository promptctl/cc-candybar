// [LAW:effects-at-boundaries] The renderer opens no file: a config, its
// plugins and its repository's standing reach it as the snapshot the host's
// discovery hands in. Every path here names nothing on disk, and the unit
// tier refuses every read, so a load that opened a config, a plugin or a
// `.git` fails its test.

import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import { parseSessionId } from "../../src/daemon/foundations/session-id";
import {
  RenderCache,
  SOURCES_NOTHING,
  type LoadCause,
} from "../../src/renderer/render-cache";
import { SessionState } from "../../src/renderer/session-state";
import { bareGates } from "../helpers/gates";
import { heldClock } from "../helpers/held-clock";
import { TEST_SIGNER } from "../helpers/link-signer";
import { NO_PLUGIN_STORAGE } from "../helpers/plugin-storage";
import { textSnapshot } from "../helpers/text-snapshot";

const PROJECT = "/nowhere/project";
const CONFIG = "/nowhere/home/.claude/cc-candybar/config.json5";
const LISTED = "/nowhere/home/.claude/cc-candybar/listed/plugin.json5";
const INSTALLED = "/nowhere/home/.claude/cc-candybar/plugins/installed/plugin.json5";

const parsed = parseSessionId("a".repeat(64));
if (!parsed.ok) throw new Error(parsed.problem);
const SESSION = parsed.id;

const definition = (segment: string, dir: string) => ({
  kind: "text" as const,
  text: `{ segments: { ${segment}: { template: "${segment}" } } }`,
  dir,
});

// The user's config listing one plugin, with one installed beside it, in a
// repository whose config awaits the user's answer.
function snapshot(text: string): ConfigSnapshot {
  const base = textSnapshot([[CONFIG, text]], PROJECT);
  return {
    ...base,
    chain: base.chain.map((layer) => ({
      ...layer,
      listed: {
        "./listed/plugin.json5": {
          scope: "plugins",
          path: LISTED,
          definition: definition("mine", "/nowhere/home/.claude/cc-candybar/listed"),
        },
      },
    })),
    plugins: [
      {
        scope: "plugins",
        path: INSTALLED,
        definition: definition("theirs", "/nowhere/home/.claude/cc-candybar/plugins/installed"),
      },
    ],
    repo: { dir: PROJECT, standing: "awaiting", unproven: null },
    checkout: { root: PROJECT, git: true },
  };
}

const CONFIG_TEXT = `{ plugins: ["./listed/plugin.json5"], segments: { hi: { template: "hi" } }, root: { h: ["hi", "plugins.listed.mine", "plugins.installed.theirs"] } }`;

function rig() {
  const loads: Array<{ cause: LoadCause["kind"]; settled: string }> = [];
  const cache = new RenderCache(
    {
      clock: heldClock(new Date("2026-01-01T00:00:00Z")),
      home: "/nowhere/home",
      env: {},
      storage: NO_PLUGIN_STORAGE,
      signer: TEST_SIGNER,
      gates: bareGates(),
      sessionState: new SessionState(),
      source: SOURCES_NOTHING,
    },
    {
      budgetBytes: () => Number.MAX_SAFE_INTEGER,
      observers: {
        onReload: (_entry, _sessions, cause, settled) => loads.push({ cause: cause.kind, settled }),
      },
    },
  );
  const configure = (text: string) => cache.configure(SESSION, PROJECT, PROJECT, undefined, snapshot(text));
  const entry = () => cache.getOrCreate(PROJECT, PROJECT, undefined);
  return { cache, configure, entry, loads };
}

describe("the renderer loads its config from the snapshot handed in", () => {
  test("a config listing a plugin, beside an installed one, in an awaiting repository loads from the snapshot alone", () => {
    const { cache, configure, entry } = rig();
    configure(CONFIG_TEXT);
    const loaded = entry();
    expect(loaded.lastError).toBeNull();
    expect(Object.keys(loaded.state.config.segments)).toEqual(
      expect.arrayContaining(["hi", "plugins.listed.mine", "plugins.installed.theirs"]),
    );
    expect(loaded.configLayers).toEqual([CONFIG]);
    cache.close();
  });

  test("a config that fails its first load draws the bundled bar, with its error", () => {
    const { cache, configure, entry } = rig();
    configure("{ segments: ");
    const loaded = entry();
    expect(loaded.lastError).toContain(CONFIG);
    expect(Object.keys(loaded.state.config.segments).length).toBeGreaterThan(0);
    cache.close();
  });

  test("an equal snapshot handed in again loads nothing", () => {
    const { cache, configure, entry, loads } = rig();
    configure(CONFIG_TEXT);
    entry();
    configure(CONFIG_TEXT);
    expect(loads).toEqual([{ cause: "open", settled: "built" }]);
    cache.close();
  });

  test("an edit to a comment alone keeps the state served", () => {
    const { cache, configure, entry, loads } = rig();
    configure(CONFIG_TEXT);
    const before = entry().state;
    configure(`// a note\n${CONFIG_TEXT}`);
    expect(loads).toEqual([
      { cause: "open", settled: "built" },
      { cause: "config", settled: "kept" },
    ]);
    expect(entry().state).toBe(before);
    cache.close();
  });
});
