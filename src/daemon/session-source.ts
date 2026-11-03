// [LAW:single-enforcer] The one builder of what a session's view draws from
// (brandon-unfiled-3248.8ro6, step 4e): its payload, composed from the facts
// document, the hook's fields, the client's hints, the session's picks and the
// depths of its histories — and the globals those picks resolve to. The daemon
// and the demo both build their views' sources here, so a view is drawn from
// one derivation wherever it is drawn.
//
// [LAW:one-source-of-truth] A view draws from one turn: the document, what the
// payload is composed from beside it and the globals the draw's options are
// built from are stamped together, in one reaction, and the payload, the
// globals and the document are all read off that one value. A draw reads the
// last turn that completed, whole.
//
// [LAW:effects-at-boundaries] No instant is read here but the turn's own:
// what moves with the clock (`today`, `feeds`, `drawing`) is a projection each
// draw hands its binding (DRAW_PROJECTIONS, src/config/payload-inputs.ts), so a
// key policy over the payload re-runs in the turn a fact it reads moves — a
// request's arrival, a lane's landing, a click — and never inside a draw.

import { observable, reaction, runInAction } from "mobx";
import type { EffectiveGlobals } from "../config/effective-globals.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import type { ValidatedConfig } from "../config/dsl-types.js";
import type { ViewSource } from "../dsl/view-source.js";
import type { SourceOf } from "./cache/render.js";
import type { Fact } from "../facts/fact.js";
import type { SessionFacts, UpdateNotice } from "../facts/session-facts.js";
import { instantAt, type Instant } from "../utils/instant.js";
import { assembleFacts } from "./facts-assembly.js";
import {
  composePayload,
  readingsOf,
  type ComposeInputs,
  type DrawInputs,
  type PayloadInputs,
  type Readings,
  type RenderPayloadDeps,
  type ViewPayload,
} from "./render-payload.js";
import type { SessionId } from "./session-id.js";
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
  // Why the turn after the one every read above is of could not be stamped, or
  // null when the latest turn completed: while it is set the bar is drawn from
  // the last turn that did, and says so.
  readonly failure: () => string | null;
}

// [LAW:types-are-the-program] One turn: the document and everything the
// payload is composed from beside it, stamped together.
interface Turn {
  readonly document: SessionFacts;
  readonly compose: ComposeInputs;
  readonly draw: DrawInputs;
  readonly failure: string | null;
}

// What a turn reads, or what stopped it reading: a derivation that throws is a
// turn that did not complete, not a reaction that never ran.
type TurnInputs =
  | {
      readonly kind: "read";
      readonly readings: Readings;
      readonly update: Fact<UpdateNotice>;
      readonly compose: ComposeInputs;
      readonly draw: DrawInputs;
    }
  | { readonly kind: "failed"; readonly reason: string };

// [LAW:single-enforcer] The one stamp of a turn, against the turn it replaces.
// The prior turn itself is returned when nothing it holds moved (the document's
// identity is `restamp`'s verdict), so nothing holding it is touched; a turn
// that cannot be stamped keeps the prior one and says why.
//
// [LAW:no-silent-failure] A failed stamp is a value the draw reads
// (`failure`), not only a line in the daemon's log.
function stamped(
  prior: Turn,
  moved: TurnInputs,
  at: Instant,
  session: SessionId,
): Turn {
  if (moved.kind === "failed") return { ...prior, failure: moved.reason };
  try {
    const document = assembleFacts(
      prior.document,
      session,
      moved.readings,
      moved.update,
      at,
    );
    return prior.failure === null &&
      document === prior.document &&
      moved.compose === prior.compose &&
      moved.draw === prior.draw
      ? prior
      : {
          document,
          compose: moved.compose,
          draw: moved.draw,
          failure: null,
        };
  } catch (e) {
    return { ...prior, failure: `stamping the facts document: ${String(e)}` };
  }
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
    // [LAW:one-source-of-truth] What the owners are read by: the request, and
    // the closure and lanes of ONE declaration. The closure is the preset the
    // declaration was taken for, never a second resolution through the picks:
    // the redeclaration that follows a preset pick is its own reaction, so a
    // closure read from the picks could pair a new preset's closure with the
    // old preset's lanes.
    const inputs = store.derive(
      "session.inputs",
      "computed",
      (): PayloadInputs => {
        const { facts, lanes, preset } = declared();
        return {
          hookData: facts.hookData,
          cwd: facts.cwd,
          hints: facts.hints,
          neededInputPaths: state.neededInputPaths(preset),
          deps: { ...deps.providers, lanes: () => lanes },
        };
      },
    );
    // [LAW:one-source-of-truth] What the session's owners hold now, read once.
    const readings = store.derive("session.readings", "computed", () =>
      readingsOf(inputs.read(), state.sources),
    );
    // Derivations, so each keeps its identity until an input of it moves, and
    // a turn that moved nothing of them is the turn before.
    const compose = store.derive(
      "session.compose",
      "computed",
      (): ComposeInputs => {
        const { hookData, hints, neededInputPaths } = inputs.read();
        return {
          hookData,
          hints,
          neededInputPaths,
          home: deps.providers.home,
        };
      },
    );
    const draw = store.derive(
      "session.draw",
      "computed",
      (): DrawInputs => ({
        effective: effective.read(),
        configFacts: {
          ...settingCounts(state.config, state.fileHeldSettings, pick),
          configPath: state.configPath,
        },
        history: deps.history(sessionId),
        back: deps.navigation(sessionId, state.config),
      }),
    );
    // [LAW:no-ambient-temporal-coupling] The turn is stamped in a reaction's
    // effect, not a derivation: a stamp is the turn's instant, and a computed
    // that read the clock and its own prior answer would answer by when it ran.
    // The first turn is stamped here, with no prior, so the box is total from
    // its first read and every field is pending until an owner answers; a
    // throw in it is a failed open, which the view's opening releases.
    const clock = deps.providers.clock;
    const turn = observable.box<Turn>(
      {
        document: assembleFacts(
          undefined,
          sessionId,
          readings.read(),
          deps.update(),
          instantAt(clock),
        ),
        compose: compose.read(),
        draw: draw.read(),
        failure: null,
      },
      { deep: false },
    );
    onDispose(
      reaction(
        (): TurnInputs => {
          try {
            return {
              kind: "read",
              readings: readings.read(),
              update: deps.update(),
              compose: compose.read(),
              draw: draw.read(),
            };
          } catch (e) {
            return {
              kind: "failed",
              reason: `reading the owners: ${String(e)}`,
            };
          }
        },
        (moved) =>
          runInAction(() => {
            const next = stamped(
              turn.get(),
              moved,
              instantAt(clock),
              sessionId,
            );
            if (next.failure !== null) {
              // [LAW:no-silent-failure] Told to the log as well as to the bar.
              deps.providers.log(
                "error",
                `session facts sid=${JSON.stringify(sessionId)}: ${next.failure}`,
              );
            }
            turn.set(next);
          }),
        {
          // The expression above cannot throw; the effect's catch is `stamped`.
          onError: (e) =>
            deps.providers.log(
              "error",
              `session turn threw sid=${JSON.stringify(sessionId)}: ${String(e)}`,
            ),
        },
      ),
    );
    // [LAW:dataflow-not-control-flow] The payload is derived from the turn on
    // every read: composition is pure, so a throw reaches the draw.
    const payload = store.derive("session.payload", "computed", () => {
      const { document, compose: composed, draw: drawn } = turn.get();
      return composePayload(document, composed, drawn);
    });
    return {
      payload: () => payload.read(),
      effective: () => turn.get().draw.effective,
      facts: () => turn.get().document,
      failure: () => turn.get().failure,
      selections: () => turn.get().draw.effective,
    };
  };
}
