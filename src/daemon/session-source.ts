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

import { observable, reaction, runInAction } from "mobx";
import type { EffectiveGlobals } from "../config/effective-globals.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import type { ValidatedConfig } from "../config/dsl-types.js";
import type { ViewSource } from "../dsl/view-source.js";
import type { SourceOf } from "./cache/render.js";
import type { Fact } from "../facts/fact.js";
import type { SessionFacts, UpdateNotice } from "../facts/session-facts.js";
import { instantAt } from "../utils/instant.js";
import { assembleFacts } from "./facts-assembly.js";
import {
  projectPayload,
  readingsOf,
  type PayloadInputs,
  type RenderPayloadDeps,
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
  // The session's facts document (src/facts/session-facts.ts), restamped in
  // the turn an owner's reading moves; the view's source is its one holder.
  readonly facts: () => SessionFacts;
}

export interface SessionSourceDeps {
  // The owners every lane is read from, and the log for those whose owner
  // does not log.
  readonly providers: Omit<RenderPayloadDeps, "lanes">;
  readonly sessionState: SessionStateReader;
  // The daemon's one update fact, stamped by its watch
  // (src/daemon/update-notice.ts): every session's document carries it.
  readonly update: () => Fact<UpdateNotice>;
  // The session's undo/redo depth — SettingsHistory.depth in the daemon.
  readonly history: (sessionId: string) => HistoryDepth;
  // The session's back depth, measured against the gate of the config its
  // view draws with — NavigationHistory.depth in the daemon.
  readonly navigation: (sessionId: string, config: ValidatedConfig) => number;
}

export function sessionSource(
  deps: SessionSourceDeps,
): SourceOf<SessionSource> {
  return ({ sessionId, state, store, declared, onDispose }) => {
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
    const inputs = store.derive(
      "session.inputs",
      "computed",
      (): PayloadInputs => {
        const { facts, lanes } = declared();
        return {
          hookData: facts.hookData,
          cwd: facts.cwd,
          hints: facts.hints,
          neededInputPaths: state.neededInputPaths(effective.read().preset),
          deps: { ...deps.providers, lanes: () => lanes },
        };
      },
    );
    // [LAW:one-source-of-truth] What the session's owners hold now, read once:
    // the payload and the facts document are both folds of this.
    const readings = store.derive("session.readings", "computed", () =>
      readingsOf(inputs.read(), state.sources),
    );
    const payload = store.derive("session.payload", "computed", () => {
      const globals = effective.read();
      return projectPayload(
        inputs.read(),
        {
          effective: globals,
          configFacts: {
            ...settingCounts(state.config, state.fileHeldSettings, pick),
            configPath: state.configPath,
          },
          history: deps.history(sessionId),
          back: deps.navigation(sessionId, state.config),
        },
        readings.read().lanes,
      );
    });
    // [LAW:no-ambient-temporal-coupling] The document is stamped in a
    // reaction's effect, not a derivation: a stamp is the turn's instant, and
    // a computed that read the clock and its own prior answer would answer by
    // when it ran. It is total from its first read, every field pending until
    // an owner answers.
    const clock = deps.providers.clock;
    const document = observable.box<SessionFacts>(
      assembleFacts(
        undefined,
        sessionId,
        readings.read(),
        deps.update(),
        instantAt(clock),
      ),
      { deep: false },
    );
    onDispose(
      reaction(
        () => ({ readings: readings.read(), update: deps.update() }),
        ({ readings: moved, update }) =>
          runInAction(() =>
            document.set(
              assembleFacts(
                document.get(),
                sessionId,
                moved,
                update,
                instantAt(clock),
              ),
            ),
          ),
        {
          // [LAW:no-silent-failure] A throw here reaches only the console
          // MobX prints to, which nobody reads in a detached daemon.
          onError: (e) =>
            deps.providers.log(
              "error",
              `session facts threw sid=${JSON.stringify(sessionId)}: ${String(e)}`,
            ),
        },
      ),
    );
    return {
      payload: () => payload.read(),
      effective: () => effective.read(),
      facts: () => document.get(),
      selections: () => effective.read(),
    };
  };
}
