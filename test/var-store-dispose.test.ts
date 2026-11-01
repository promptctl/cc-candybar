// A disposed config leaves nothing subscribed to the daemon-wide SessionState
// atom, and keeps the pull-only cache it was built for while it lives
// (brandon-unfiled-3248.t14).
//
// A keepAlive computed never unsubscribes from what it read on its own. Every
// RenderCache entry's store reads session state through one atom that lives as
// long as the daemon, so before this, every reload or eviction left the whole
// disposed store reachable from that atom — 2,500 observers against 12 live
// entries in the breach snapshot of 2026-10-19 — until the RSS backstop fired.
import { drawPayload } from "./helpers/draw-payload";
import { processLauncher } from "../src/proc/launch";
import { TEST_SIGNER } from "./helpers/link-signer";
import { VariableStore } from "../src/var-system/store";
import { SourceRegistry } from "../src/var-system/sources";
import { registerDslConfig } from "../src/dsl/render";
import { SessionState } from "../src/daemon/session-state";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { instantOf } from "../src/utils/instant";
import { configDisposeLine } from "../src/daemon/cache/render";

const SID = "s1";

const OPTS = {
  endcaps: "powerline" as const,
  colorCompatibility: "truecolor" as const,
  wrap: true,
  padding: 0,
  width: Number.POSITIVE_INFINITY,
};

const PAYLOAD = {
  session_id: SID,
  tmux: { pane: "%0" },
  cwd: "/tmp/proj",
  model: { id: "claude-opus-4-7", display_name: "Opus" },
  workspace: {
    current_dir: "/tmp/proj",
    project_dir: "/tmp/proj",
    added_dirs: [],
  },
  theme: { effective: "textual-dark" },
  style: { effective: "none" },
  endcaps: { effective: "powerline" },
  preset: { effective: "default" },
  colorCompatibility: { effective: "truecolor" },
  autoWrap: { effective: true },
  padding: { effective: 1 },
};

// The bundled default, registered into a fresh store against the shared
// SessionState and rendered once — what every RenderCache entry is.
function renderedEntry(
  sessionState: SessionState,
  drawn = true,
): SourceRegistry {
  const config = parseAndValidate(
    "<test>",
    "{}",
    new Set(listResolvablePaletteNames()),
    DEFAULT_DSL_CONFIG,
  );
  const store = new VariableStore();
  const registry = new SourceRegistry(processLauncher, store, "", sessionState);
  const compiled = registerDslConfig(config, registry, { signer: TEST_SIGNER, cwd: "/tmp/proj" });
  if (drawn) {
    drawPayload(
      config,
      compiled,
      store,
      registry,
      PAYLOAD,
      instantOf(new Date()),
      OPTS,
    ).frame;
  }
  return registry;
}

describe("VariableStore.dispose releases every computed's subscriptions", () => {
  it("a disposed registry leaves the SessionState atom with only the live entries' observers", () => {
    const sessionState = new SessionState();
    expect(sessionState.observers()).toBe(0);

    const first = renderedEntry(sessionState);
    const perEntry = sessionState.observers();
    expect(perEntry).toBeGreaterThan(0);

    const second = renderedEntry(sessionState);
    expect(sessionState.observers()).toBe(2 * perEntry);

    // Every computed is released, not only those that read the atom; the
    // count is what the daemon's dispose line carries.
    const released = first.dispose();
    expect(released).toBeGreaterThanOrEqual(perEntry);
    expect(sessionState.observers()).toBe(perEntry);
    expect(configDisposeLine({ reason: "reload", held: 0 }, released)).toBe(
      `config disposed reason=reload released=${released} held=0`,
    );

    second.dispose();
    expect(sessionState.observers()).toBe(0);
  });

  // brandon-unfiled-3248.8ro6 step 6: what a draw keeps of its parts lives in
  // its store, and goes with its variables.
  it("releases the parts a draw kept beside the variables", () => {
    const sessionState = new SessionState();
    const variables = renderedEntry(sessionState, false).dispose();
    expect(renderedEntry(sessionState).dispose()).toBeGreaterThan(variables);
    expect(sessionState.observers()).toBe(0);
  });

  it("refuses a declaration after dispose: it would subscribe with no release to come", () => {
    const sessionState = new SessionState();
    const store = new VariableStore();
    store.defineComputed("a", "string", () => sessionState.get(SID, "a") ?? "");
    expect(store.read("a")).toBe("");
    expect(store.dispose()).toBe(1);
    // A second dispose released nothing, and says so.
    expect(store.dispose()).toBe(0);
    expect(() =>
      store.defineComputed(
        "b",
        "string",
        () => sessionState.get(SID, "b") ?? "",
      ),
    ).toThrow(/cannot declare on a disposed store/);
    expect(() => store.defineBox("c", "string", "")).toThrow(
      /cannot declare on a disposed store/,
    );
    expect(sessionState.observers()).toBe(0);
  });

  it("a never-rendered registry subscribes nothing, and its dispose changes nothing", () => {
    const sessionState = new SessionState();
    const store = new VariableStore();
    const registry = new SourceRegistry(processLauncher, store, "", sessionState);
    registerDslConfig(
      parseAndValidate(
        "<test>",
        "{}",
        new Set(listResolvablePaletteNames()),
        DEFAULT_DSL_CONFIG,
      ),
      registry,
      { signer: TEST_SIGNER, cwd: "/tmp/proj" },
    );
    expect(sessionState.observers()).toBe(0);
    registry.dispose();
    expect(sessionState.observers()).toBe(0);
  });

  it("keeps the pull-only cache while live: two reads with no change evaluate once", () => {
    const sessionState = new SessionState();
    const store = new VariableStore();
    let evaluations = 0;
    store.defineComputed("theme", "string", () => {
      evaluations++;
      return sessionState.get(SID, "theme") ?? "none";
    });

    expect(store.read("theme")).toBe("none");
    expect(store.read("theme")).toBe("none");
    expect(evaluations).toBe(1);
    expect(sessionState.observers()).toBe(1);

    sessionState.set(SID, "theme", "nord");
    expect(store.read("theme")).toBe("nord");
    expect(evaluations).toBe(2);

    store.dispose();
    expect(sessionState.observers()).toBe(0);

    // A late read still answers, uncached, and does not resubscribe the store.
    sessionState.set(SID, "theme", "gruvbox");
    expect(store.read("theme")).toBe("gruvbox");
    expect(sessionState.observers()).toBe(0);
  });
});
