// [LAW:single-enforcer] The one builder of what a session's view draws from
// (brandon-unfiled-3248.8ro6, step 4e): its payload, composed from the
// session's world state, the hook's fields, the client's hints, the session's
// picks and the depths of its histories — and the globals those picks resolve
// to. The daemon and the demo both build their views' sources here, so a view
// is drawn from one derivation wherever it is drawn.
//
// [LAW:one-source-of-truth] The world state is the host's, stamped by its
// collector (src/daemon/collector.ts) and handed in; a view reads its
// session's document from the renderer's store and stamps nothing. A request
// and the document read at its keys are taken in one action
// (src/daemon/draw-bar.ts), so the payload, the globals and the document a
// draw reads are of one request.
//
// [LAW:effects-at-boundaries] No instant is read here: what moves with the
// clock (`today`, `feeds`, `drawing`) is a projection each draw hands its
// binding (DRAW_PROJECTIONS, src/config/payload-inputs.ts), so a key policy
// over the payload re-runs in the turn a fact it reads moves — a request's
// arrival, a world state's landing, a click — and never inside a draw.

import type { SessionId } from "./session-id.js";
import type { EffectiveGlobals } from "../config/effective-globals.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import type { ValidatedConfig } from "../config/dsl-types.js";
import type { ViewSource } from "../dsl/view-source.js";
import type { WorldState } from "../facts/world-state.js";
import type { WorldStates } from "../renderer/world-states.js";
import type { SourceOf } from "./cache/render.js";
import { stampFailureOf } from "./facts-assembly.js";
import {
  composePayload,
  type ComposeInputs,
  type DrawInputs,
  type ViewPayload,
} from "./render-payload.js";
import type { SessionStateReader } from "./session-state.js";
import type { HistoryDepth } from "./settings-history.js";
import { settingCounts } from "./setting-drafts.js";

// What a session's view draws from: the selections its slots settle and the
// payload its inputs read, as ViewSource names them, the globals the session's
// picks resolve to (what the draw's options are built from, beside the
// payload's `.effective` fields).
export interface SessionSource extends ViewSource {
  readonly payload: () => ViewPayload;
  readonly effective: () => EffectiveGlobals;
  // The session's world state (src/facts/world-state.ts), as the host last
  // handed it in.
  readonly facts: () => WorldState;
  // The client's hints the payload is composed from: what a draw takes of the
  // client beside the payload, so it never pairs a payload with a request it
  // was not composed from.
  readonly hints: () => ComposeInputs["hints"];
  // Why the host's last stamp of the session failed, or null when it held:
  // while it is set the bar is drawn from the last document that stamped,
  // and says so.
  readonly failure: () => string | null;
}

export interface SessionSourceDeps {
  readonly sessionState: SessionStateReader;
  // The world states the host handed in, which every view reads its
  // session's from.
  readonly worldStates: Pick<WorldStates, "of">;
  // The user's home, which the payload's `home` reads.
  readonly home: string;
  // The session's undo/redo depth — SettingsHistory.depth in the daemon.
  readonly history: (sessionId: SessionId) => HistoryDepth;
  // The session's back depth, measured against the gate of the config its
  // view draws with — NavigationHistory.depth in the daemon.
  readonly navigation: (
    sessionId: SessionId,
    config: ValidatedConfig,
  ) => number;
}

export function sessionSource(
  deps: SessionSourceDeps,
): SourceOf<SessionSource> {
  return ({ sessionId, state, store, requested }) => {
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
    // Derivations, so each keeps its identity until an input of it moves.
    const compose = store.derive(
      "session.compose",
      "computed",
      (): ComposeInputs => {
        const { hookData, hints } = requested();
        return { hookData, hints, home: deps.home };
      },
    );
    const draw = store.derive(
      "session.draw",
      "computed",
      (): DrawInputs => ({
        sources: [...state.sources.keys()],
        effective: effective.read(),
        configFacts: {
          ...settingCounts(state.config, state.fileHeldSettings, pick),
          configPath: state.configPath,
        },
        history: deps.history(sessionId),
        back: deps.navigation(sessionId, state.config),
      }),
    );
    const document = (): WorldState => deps.worldStates.of(sessionId);
    // [LAW:dataflow-not-control-flow] The payload is derived on every read:
    // composition is pure, so a throw reaches the draw.
    const payload = store.derive("session.payload", "computed", () =>
      composePayload(document(), compose.read(), draw.read()),
    );
    return {
      payload: () => payload.read(),
      effective: () => draw.read().effective,
      facts: document,
      hints: () => compose.read().hints,
      failure: () => stampFailureOf(document()),
      selections: () => draw.read().effective,
    };
  };
}
