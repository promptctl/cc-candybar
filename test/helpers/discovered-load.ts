// A load from files, as the daemon makes one: discovery reads each text and
// the definitions it lists, and the loader is handed what it read. The loader
// opens no file of its own.

import { locs as testLocs } from "./host";
import {
  loadConfigSource,
  loadSnapshot,
  mergeWithDefault,
  type ChainTrace,
  type ConfigLayer,
  type LoadContext,
  type LoadedChain,
} from "../../src/config/dsl-loader";
import {
  installedRoots,
  layerOf,
  readLayer,
  sessionPlugins,
  snapshotOf,
} from "../../src/daemon/config-discovery/discover";
import type { Layer } from "../../src/config/config-snapshot";
import type { DslConfig } from "../../src/config/dsl-types";
import type { Locations } from "../../src/config/loader/chain-places";

// One file as the user layer, over `ctx`'s beneath; null is no file — the
// bundled default, under nothing.
export function loadFile(
  file: string | null,
  dflt: DslConfig,
  ctx: LoadContext,
  allowedPalettes?: ReadonlySet<string>,
) {
  if (file === null) {
    return {
      raw: {},
      source: "",
      warnings: [] as readonly string[],
      config: mergeWithDefault({}, dflt),
    };
  }
  const layer = layerOf("user", file, readLayer(file), ctx.home);
  if (layer.content.kind !== "text") throw new Error(layer.content.kind);
  return loadConfigSource(
    file,
    layer.content.text,
    dflt,
    { ...ctx, listed: layer.listed },
    allowedPalettes,
  );
}

// A chain whose texts are in hand (`texts`), or read from disk where none is
// given, over the installed plugins of `locs` and no project.
export function loadChain(
  chain: readonly ConfigLayer[],
  dflt: DslConfig,
  trace: ChainTrace,
  {
    locs = testLocs(),
    cwd,
    texts,
  }: {
    readonly locs?: Locations;
    readonly cwd?: string;
    readonly texts?: (path: string) => string;
  } = {},
): LoadedChain {
  const content = (path: string): Layer["content"] =>
    texts === undefined ? readLayer(path) : { kind: "text", text: texts(path) };
  const snapshot = snapshotOf(
    sessionPlugins(locs, installedRoots(locs), null, cwd ?? locs.home),
    chain.map((l) => layerOf(l.role, l.path, content(l.path), locs.home)),
  );
  return loadSnapshot(snapshot, locs.home, dflt, trace);
}
