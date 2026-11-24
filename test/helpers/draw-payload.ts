// Draw a sample through the same view binding and draw as a session.
import type { ValidatedConfig } from "../../src/config/dsl-types";
import {
  drawDsl,
  type CompiledConfig,
  type DrawnFrame,
  type RenderWarning,
} from "../../src/dsl/render";
import { bindView } from "../../src/dsl/parts";
import type { BuildLineOptions } from "../../src/render/strip";
import type { Instant } from "../../src/utils/instant";
import type { SourceRegistry } from "../../src/var-system/sources";
import type { VariableStore } from "../../src/var-system/store";
import type { FrameRecord } from "../../src/render/frame-memory";
import type { RenderedLine } from "../../src/dsl/node-registry";
import { globalsFor, type RenderSelection } from "./selection";
import { sessionOfPayload } from "./payload-session";
import {
  fixedSource,
  NOTHING_READ,
  type HostReadings,
} from "../../src/dsl/view-source";

// The view drawing from `store` bound to a fixed `payload` and `selection`.
// [LAW:one-source-of-truth] A sample's `opts` are its source: the payload is
// made to agree with them, at the width it is drawn at, `term.cols`, and the
// depth they name, so the writer and every contrast floor read one depth. A
// sample is drawn at its payload's width, so it never takes the daemon's
// resize path. [LAW:no-ambient-temporal-coupling] A source keyed on an input
// starts its run inside this bind, so a caller that waits on that run before
// drawing draws the payload its key read.
export function bindSample(
  config: ValidatedConfig,
  compiled: CompiledConfig,
  store: VariableStore,
  registry: SourceRegistry,
  payload: unknown,
  opts: BuildLineOptions,
  selection: RenderSelection,
  readings: HostReadings,
): (at: Instant) => DrawnFrame {
  const projected = {
    ...(payload as object),
    term: { cols: opts.width },
    colorCompatibility: { effective: opts.colorCompatibility },
  };
  const source = fixedSource(
    projected,
    selection,
    sessionOfPayload(payload),
    readings,
  );
  bindView(compiled, store, registry, source);
  return (at) => {
    const frame = drawDsl(config, compiled, store, registry, projected, at, opts, {
      ...selection,
      record: selection.record ?? records.get(store),
    });
    records.set(store, frame.memory.record);
    selection.effects?.keep(frame.memory.motion);
    return frame;
  };
}

export function drawPayload(
  config: ValidatedConfig,
  compiled: CompiledConfig,
  store: VariableStore,
  registry: SourceRegistry,
  payload: unknown,
  at: Instant,
  opts: BuildLineOptions,
  // [LAW:one-source-of-truth] With no picks, fixtures use the defaults the
  // daemon resolves for a new session.
  selection: RenderSelection = globalsFor(config),
  readings: HostReadings = NOTHING_READ,
): DrawnFrame {
  const draw = bindSample(
    config,
    compiled,
    store,
    registry,
    payload,
    opts,
    selection,
    readings,
  );
  return draw(at);
}

// The record of the last frame drawn over each store, as a view keeps its
// surface's.
const records = new WeakMap<VariableStore, FrameRecord<RenderedLine>>();

// Each placement that drew its ⚠ cell, by the message that names it.
export const segmentErrorsOf = (
  warnings: readonly RenderWarning[],
): string[] =>
  warnings.flatMap((w) =>
    w.kind === "segment" ? [w.message] : [],
  );
