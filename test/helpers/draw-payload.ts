// One frame of a fixed payload: bound, drawn and kept in one call, the seam a
// session's view reads, given a constant. A test draws by this as a turn
// draws: what the frame leaves — its record and its motion — is kept in the
// selection's effects, or the store's own when it hands none, so the next
// call draws on from it. The daemon and check bind a view of their own and
// call `drawDsl`.
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
import { SessionEffects } from "../../src/render/effect";
import type { RenderedLine } from "../../src/dsl/node-registry";
import type { Instant } from "../../src/utils/instant";
import type { SourceRegistry } from "../../src/var-system/sources";
import type { VariableStore } from "../../src/var-system/store";
import { globalsFor } from "./selection";
import { sessionOfPayload } from "./payload-session";
import { UNREAD_RUN, type RunFact } from "../../src/facts/world-state";

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
  run: (digest: string) => RunFact = () => UNREAD_RUN,
): DrawnFrame {
  const effects = selection.effects ?? effectsOf(store);
  const drawn = bindPayload(
    compiled,
    store,
    registry,
    payload,
    opts,
    selection,
    sessionOfPayload(payload),
    run,
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
    { ...selection, effects },
  );
  effects.keep(frame.memory);
  return frame;
}

// A store's own memory, for a caller whose selection hands none: a view
// drawn again draws on from its last frame, as a session's does.
const storeEffects = new WeakMap<VariableStore, SessionEffects<RenderedLine>>();
const effectsOf = (store: VariableStore): SessionEffects<RenderedLine> => {
  const held = storeEffects.get(store);
  if (held !== undefined) return held;
  const made = new SessionEffects<RenderedLine>("");
  storeEffects.set(store, made);
  return made;
};
