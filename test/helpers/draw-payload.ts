// One frame of a fixed payload: bound and drawn in one call, the seam a
// session's view reads, given a constant. A test draws by this; the daemon and
// check bind a view of their own and call `drawDsl`.
import type { ValidatedConfig } from "../../src/config/dsl-types";
import {
  bindPayload,
  drawDsl,
  type CompiledConfig,
  type DrawnFrame,
  type RenderObservers,
  type RenderSelection,
} from "../../src/dsl/render";
import type { BuildLineOptions } from "../../src/render/strip";
import type { Instant } from "../../src/utils/instant";
import type { SourceRegistry } from "../../src/var-system/sources";
import type { VariableStore } from "../../src/var-system/store";
import { globalsFor } from "./selection";

export function drawPayload(
  config: ValidatedConfig,
  compiled: CompiledConfig,
  store: VariableStore,
  registry: SourceRegistry,
  payload: unknown,
  at: Instant,
  opts: BuildLineOptions,
  observers?: RenderObservers,
  // [LAW:one-source-of-truth] A caller naming no selection renders as a session that has
  // never clicked: the daemon's own resolution with no picks, so a config
  // declaring globals.preset or globals.style draws the preset, theme and look
  // the bar does.
  selection: RenderSelection = globalsFor(config),
): DrawnFrame {
  const drawn = bindPayload(compiled, store, registry, payload, opts, selection);
  return drawDsl(config, compiled, store, registry, drawn, at, opts, observers, selection);
}
