// A chain loaded and drawn in process, for a test or a bench that reads a
// config's parts (its merged config, the plugins it dropped, its variable
// store) or times its draws without a renderer: discovered as the daemon
// discovers a chain named outright, loaded by the daemon's loader, registered,
// its runs held by a real collector (held-runs.ts), and drawn over `check`'s
// rich payload (check-payload.ts). What `check` itself verdicts is drawn by
// the daemon's own renderer (src/check.ts); this rig is the in-process view a
// case inspects.

import { linkSigner, previewLinkKey } from "../../src/click/link-signer";
import { locations } from "../../src/daemon/paths";
import type { ApprovedRepo } from "../../src/config/loader/repo-gate";
import {
  installedRoots,
  layerOf,
  readLayer,
  sessionPlugins,
  snapshotOf,
} from "../../src/daemon/config-discovery/discover";
import {
  loadSnapshot,
  refuseDrops,
  type ConfigLayer,
  type DroppedPlugin,
} from "../../src/config/dsl-loader";
import type { ValidatedConfig } from "../../src/config/dsl-types";
import { DEFAULT_DSL_CONFIG } from "../../src/config/default-dsl-config";
import {
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "../../src/config/effective-globals";
import { plainEnvironment } from "../../src/daemon/foundations/session-env";
import { SourceRuns } from "../../src/daemon/source-runs";
import {
  bindPayload,
  registerDslConfig,
  type CompiledConfig,
} from "../../src/dsl/render";
import type { World } from "../../src/host";
import type { Frame } from "../../src/render/frame";
import { renderOptionsOf } from "../../src/renderer/render-payload";
import { SessionState } from "../../src/renderer/session-state";
import { timeoutSignal } from "../../src/time";
import type { Instant } from "../../src/utils/instant";
import { SourceRegistry } from "../../src/var-system/sources";
import { VariableStore } from "../../src/var-system/store";
import { checkPayload } from "./check-payload";
import { drawPayload } from "./draw-payload";
import { sessionOfPayload } from "./payload-session";
import { collectedRuns, type CollectedRuns } from "./held-runs";

// How long a prepare waits for its sources' first runs.
const SETTLE_MS = 5000;

// The repository a chain loads with: its approved project.
export interface RepoSession {
  readonly repo: ApprovedRepo | null;
}

// No approved project.
export const NO_REPO: RepoSession = { repo: null };

export interface PreparedConfig {
  readonly layers: readonly string[];
  // Plugins the config lists that did not load.
  readonly droppedPlugins: readonly DroppedPlugin[];
  readonly config: ValidatedConfig;
  readonly compiled: CompiledConfig;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly runs: CollectedRuns;
  // The one teardown of what a prepare opened.
  [Symbol.dispose](): void;
}

// A chain named outright, discovered as the daemon discovers one — each file
// read, the plugins of `repo` and the checkout of `cwd` — loaded, registered,
// bound to a fresh session's payload, and settled on its sources' first runs.
// Discovery's notices and the load's advisories land in `warnings`.
export async function prepareConfig(
  world: World,
  chain: readonly ConfigLayer[],
  { repo }: RepoSession,
  cwd: string,
  warnings: string[],
  at: Instant,
): Promise<PreparedConfig> {
  const locs = locations(world.host);
  const snapshot = snapshotOf(
    sessionPlugins(locs, installedRoots(locs), repo, cwd),
    chain.map((l) => layerOf(l.role, l.path, readLayer(l.path), locs.home)),
  );
  warnings.push(...snapshot.notices);
  const layers = snapshot.chain
    .filter((l) => l.content.kind === "text")
    .map((l) => l.path);
  const loaded = loadSnapshot(snapshot, world.host.home, DEFAULT_DSL_CONFIG, {
    warned: (w) => warnings.push(...w),
  });
  refuseDrops(loaded.dropped);
  const { config } = loaded;
  const store = new VariableStore(world.clock);
  const sourceRuns = new SourceRuns({
    launcher: world.launcher,
    clock: world.clock,
  });
  const registry = new SourceRegistry(
    store,
    config.globals.default_empty_value ?? "",
    new SessionState(),
    null,
  );
  const runs = collectedRuns(
    sourceRuns,
    registry,
    plainEnvironment(world.host.env),
    { cwd },
  );
  const dispose = (): void => {
    registry.dispose();
    runs.close();
    sourceRuns.close();
  };
  try {
    const compiled = registerDslConfig(config, registry, {
      cwd,
      signer: linkSigner(previewLinkKey()),
    });
    warnings.push(...compiled.loadWarnings);
    const prepared: PreparedConfig = {
      layers,
      droppedPlugins: [
        ...loaded.installed.dropped,
        ...loaded.layers.flatMap((l) => l.plugins.dropped),
      ],
      config,
      compiled,
      store,
      registry,
      runs,
      [Symbol.dispose]: dispose,
    };
    // A source keyed on the payload runs once the payload is bound, so the
    // first draw's payload is bound before the wait.
    await renderEffective(
      prepared,
      resolveEffectiveGlobals(
        config,
        () => null,
        () => false,
      ),
      200,
      at,
    );
    return prepared;
  } catch (e) {
    dispose();
    throw e;
  }
}

// One draw of the prepared config under `effective`, `width` wide, once the
// runs its payload started have answered: its frame, and each render error it
// met, by what failed.
export async function renderEffective(
  prepared: PreparedConfig,
  effective: EffectiveGlobals,
  width: number,
  at: Instant,
): Promise<{ rendered: Frame; failures: Map<string, string> }> {
  const { config, compiled, store, registry, runs, layers } = prepared;
  const payload = checkPayload(config, effective, layers.at(-1) ?? null, at);
  const opts = renderOptionsOf(effective, width);
  // A source keyed on an input the payload moved runs once it is bound, so
  // it is bound before the wait.
  bindPayload(
    compiled,
    store,
    registry,
    payload,
    opts,
    effective,
    sessionOfPayload(payload),
    runs.readings,
  );
  await runs.settled(timeoutSignal(store.clock, SETTLE_MS));
  const { frame, warnings } = drawPayload(
    config,
    compiled,
    store,
    registry,
    payload,
    at,
    opts,
    effective,
    runs.readings,
  );
  const failures = new Map<string, string>();
  for (const w of warnings)
    switch (w.kind) {
      case "rule":
        failures.set(`${w.slot} rule`, w.message);
        break;
      case "segment":
        failures.set(`segment "${w.placement}"`, w.message);
        break;
      case "when":
        failures.set(w.where, w.error);
        break;
      case "refresh":
        failures.set(`variable "${w.variable}"`, w.error);
        break;
    }
  return { rendered: frame, failures };
}
