// A config fixture uses the same loader, compiler, collector and DSL renderer as the statusline.
import type { ConfigSnapshot } from "../../src/config/config-snapshot";
import { locations } from "../../src/daemon/paths";
import { createGates, deriveActionGates } from "../../src/daemon/foundations/gates";
import { diskFiles } from "../../src/daemon/config-discovery/discovery-files";
import {
  installedRoots,
  layerOf,
  readLayer,
  sessionPlugins,
  snapshotOf,
} from "../../src/daemon/config-discovery/discover";
import {
  loadSnapshot,
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
import { samplePayload } from "./sample-payload";
import { bindSample } from "./draw-payload";
import { collectedRuns, type CollectedRuns } from "./held-runs";

// How long a prepare waits for its sources' first runs.
const SETTLE_MS = 5000;

export interface PreparedConfig {
  readonly layers: readonly string[];
  // Plugins the config lists that did not load.
  readonly droppedPlugins: readonly DroppedPlugin[];
  readonly droppedPlacements: readonly string[];
  readonly config: ValidatedConfig;
  readonly compiled: CompiledConfig;
  readonly store: VariableStore;
  readonly registry: SourceRegistry;
  readonly runs: CollectedRuns;
  // The one teardown of what a prepare opened.
  [Symbol.dispose](): void;
}

// A chain named outright, discovered as the daemon discovers one — each file
// read, the installed plugins and the checkout of `cwd` — loaded, registered,
// bound to a fresh session's payload, and settled on its sources' first runs.
// Discovery's notices and the load's advisories land in `warnings`.
export async function prepareConfig(
  world: World,
  chain: readonly ConfigLayer[],
  cwd: string,
  warnings: string[],
  at: Instant,
): Promise<PreparedConfig> {
  const locs = locations(world.host);
  const snapshot = snapshotOf(
    sessionPlugins(installedRoots(locs), diskFiles.checkout(cwd)),
    chain.map((l) => layerOf(l.role, l.path, readLayer(l.path), locs.home)),
  );
  const prepared = prepareSnapshot(world, snapshot, cwd, warnings);
  try {
    await renderEffective(
      prepared,
      resolveEffectiveGlobals(
        prepared.config,
        () => null,
        () => false,
      ),
      200,
      at,
    );
    return prepared;
  } catch (error) {
    prepared[Symbol.dispose]();
    throw error;
  }
}

export function prepareSnapshot(
  world: World,
  snapshot: ConfigSnapshot,
  cwd: string,
  warnings: string[],
): PreparedConfig {
  warnings.push(...snapshot.notices);
  const layers = snapshot.chain
    .filter((l) => l.content.kind === "text")
    .map((l) => l.path);
  const loaded = loadSnapshot(snapshot, world.host.home, DEFAULT_DSL_CONFIG, {
    warned: (w) => warnings.push(...w),
  });
  const { config } = loaded;
  deriveActionGates(createGates(), config);
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
    });
    warnings.push(...compiled.loadWarnings);
    return {
      layers,
      droppedPlacements: loaded.dropped.map((issue) => issue.message),
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
  } catch (e) {
    dispose();
    throw e;
  }
}

// Draw after the source wait, retaining both the renderer's diagnostics and
// the names of any sources the collector is still waiting for.
export async function renderEffective(
  prepared: PreparedConfig,
  effective: EffectiveGlobals,
  width: number,
  at: Instant,
): Promise<{ rendered: Frame; failures: readonly string[]; pending: readonly string[] }> {
  const { config, compiled, store, registry, runs, layers } = prepared;
  const payload = samplePayload(config, effective, layers.at(-1) ?? null, at);
  const opts = renderOptionsOf(effective, width);
  // Binding tells the collector which runs this sample needs before it waits.
  const draw = bindSample(
    config,
    compiled,
    store,
    registry,
    payload,
    opts,
    effective,
    runs.readings,
  );
  const pending = await runs.settled(timeoutSignal(store.clock, "test settle deadline", SETTLE_MS));
  const { frame, warnings } = draw(at);
  return {
    rendered: frame,
    failures: [...prepared.droppedPlacements, ...warnings.map((warning) => warning.message)],
    pending,
  };
}
