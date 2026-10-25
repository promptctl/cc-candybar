// [LAW:single-enforcer] The one builder of what a session's view draws from
// (brandon-unfiled-3248.8ro6, step 4e): its payload, one computed over the
// request its renders draw by, the lanes its declaration handed it, the
// session's picks and the depths of its histories — and the globals those
// picks resolve to. The daemon and the demo both build their views' sources
// here, so a view is drawn from one derivation wherever it is drawn.
//
// [LAW:effects-at-boundaries] No instant is read here: what moves with the
// clock (`today`, `feeds`, `drawing`) is a projection each draw hands its
// binding (DRAW_PROJECTIONS, src/config/payload-inputs.ts), so a key policy
// over the payload re-runs in the turn a fact it reads moves — a request's
// arrival, a lane's landing, a click — and never inside a draw.

import type { EffectiveGlobals } from "../config/effective-globals.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import type { ValidatedConfig } from "../config/dsl-types.js";
import type { ViewSource } from "../dsl/view-source.js";
import type { SourceOf } from "./cache/render.js";
import {
  payloadOf,
  type RenderPayloadDeps,
  type ViewPayload,
} from "./render-payload.js";
import type { SessionStateReader } from "./session-state.js";
import type { HistoryDepth } from "./settings-history.js";
import { settingCounts } from "./setting-drafts.js";

// What a session's view draws from: the selections its slots settle and the
// payload its inputs read, as ViewSource names them, the globals the session's
// picks resolve to (what the draw's options are built from, beside the
// payload's `.effective` fields), and the failures its payload projected as
// missing fields — logged by the request that draws them.
export interface SessionSource extends ViewSource {
  readonly payload: () => ViewPayload;
  readonly effective: () => EffectiveGlobals;
  readonly failures: () => readonly string[];
}

export interface SessionSourceDeps {
  // The owners every lane is read from, and the log for those whose owner
  // does not log.
  readonly providers: Omit<RenderPayloadDeps, "lanes">;
  readonly sessionState: SessionStateReader;
  // The session's undo/redo depth — SettingsHistory.depth in the daemon.
  readonly history: (sessionId: string) => HistoryDepth;
  // The session's back depth, measured against the gate of the config its
  // view draws with — NavigationHistory.depth in the daemon.
  readonly navigation: (sessionId: string, config: ValidatedConfig) => number;
}

export function sessionSource(
  deps: SessionSourceDeps,
): SourceOf<SessionSource> {
  return ({ sessionId, state, store, declared }) => {
    const pick = (key: string): string | null =>
      deps.sessionState.get(sessionId, key);
    // [LAW:one-source-of-truth] Every globals field resolved once per change
    // of the session's picks, and read by both the payload's `.effective`
    // fields and the draw's options, so a label cannot disagree with the bar.
    // Kept in the view's store, so its subscription to the session-state atom
    // is released with the view (`VariableStore.dispose`).
    const effective = store.derive("session.effective", "computed", () =>
      resolveEffectiveGlobals(state.config, pick, (preset) =>
        state.authoredRoots.has(preset),
      ),
    );
    const payload = store.derive("session.payload", "computed", () => {
      const { facts, lanes } = declared();
      const globals = effective.read();
      return payloadOf(
        {
          hookData: facts.hookData,
          cwd: facts.cwd,
          hints: facts.hints,
          neededInputPaths: state.neededInputPaths(globals.preset),
          deps: { ...deps.providers, lanes: () => lanes },
        },
        {
          effective: globals,
          configFacts: {
            ...settingCounts(state.config, state.fileHeldSettings, pick),
            configPath: state.configPath,
          },
          history: deps.history(sessionId),
          back: deps.navigation(sessionId, state.config),
        },
      );
    });
    return {
      payload: () => payload.read().payload,
      failures: () => payload.read().failures,
      effective: () => effective.read(),
      selections: () => effective.read(),
    };
  };
}
