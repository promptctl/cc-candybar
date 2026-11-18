// One frame of a fixed payload: bound, drawn and kept in one call, the seam a
// session's view reads, given a constant. A test draws by this as a turn
// draws: what the frame leaves is kept — its record by the store it was drawn
// over, the motion in the selection's effects when it hands some — so the
// next call draws on from it. The daemon and check bind a view of their own
// and call `drawDsl`.
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
import type { FrameRecord } from "../../src/render/frame-memory";
import type { RenderedLine } from "../../src/dsl/node-registry";
import { globalsFor } from "./selection";
import { sessionOfPayload } from "./payload-session";
import { NOTHING_READ, type HostReadings } from "../../src/dsl/view-source";

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
  readings: HostReadings = NOTHING_READ,
): DrawnFrame {
  const drawn = bindPayload(
    compiled,
    store,
    registry,
    payload,
    opts,
    selection,
    sessionOfPayload(payload),
    readings,
  );
  const frame = drawDsl(
    config,
    compiled,
    store,
    registry,
    drawn,
    at,
    opts,
    observers,
    { ...selection, record: selection.record ?? records.get(store) },
  );
  records.set(store, frame.memory.record);
  selection.effects?.keep(frame.memory.motion);
  return frame;
}

// The record of the last frame drawn over each store, as a view keeps its
// surface's.
const records = new WeakMap<VariableStore, FrameRecord<RenderedLine>>();
