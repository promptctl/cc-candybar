// [LAW:single-enforcer] The one builder of what a session's view draws from
// (brandon-unfiled-3248.8ro6, step 4e): its payload, composed from the facts
// document, the hook's fields, the client's hints, the session's picks and the
// depths of its histories — and the globals those picks resolve to. The daemon
// and the demo both build their views' sources here, so a view is drawn from
// one derivation wherever it is drawn.
//
// [LAW:one-source-of-truth] A view draws from one turn: the document, what the
// payload is composed from beside it and the globals the draw's options are
// built from are taken together, in one reaction, and the payload, the
// globals and the document are all read off that one value. A draw reads the
// last turn that completed, whole.
//
// [LAW:locality-or-seam] The document comes through the view's follow
// (src/daemon/facts-source.ts): this source reads it and knows nothing of
// which arm stamped it, so a view drawn over a recording is drawn here too.
//
// [LAW:effects-at-boundaries] No instant is read here: the document's stamps
// are its source's, and what moves with the clock (`today`, `feeds`,
// `drawing`) is a projection each draw hands its binding (DRAW_PROJECTIONS,
// src/config/payload-inputs.ts), so a key policy over the payload re-runs in
// the turn a fact it reads moves — a request's arrival, a lane's landing, a
// click — and never inside a draw.

import { observable, reaction, runInAction } from "mobx";
import type { EffectiveGlobals } from "../config/effective-globals.js";
import { resolveEffectiveGlobals } from "../config/effective-globals.js";
import type { ValidatedConfig } from "../config/dsl-types.js";
import type { ViewSource } from "../dsl/view-source.js";
import type { SourceOf } from "./cache/render.js";
import type { FactsLine } from "../facts/recording.js";
import type { SessionFacts } from "../facts/session-facts.js";
import {
  composePayload,
  type ComposeInputs,
  type DrawInputs,
  type RenderPayloadDeps,
  type ViewPayload,
} from "./render-payload.js";
import type { SessionStateReader } from "./session-state.js";
import type { HistoryDepth } from "./settings-history.js";
import { settingCounts } from "./setting-drafts.js";
import { failedWith } from "../utils/outcome.js";

// What a session's view draws from: the selections its slots settle and the
// payload its inputs read, as ViewSource names them, the globals the session's
// picks resolve to (what the draw's options are built from, beside the
// payload's `.effective` fields).
export interface SessionSource extends ViewSource {
  readonly payload: () => ViewPayload;
  readonly effective: () => EffectiveGlobals;
  // The session's facts document (src/facts/session-facts.ts), as the view's
  // follow holds it.
  readonly facts: () => SessionFacts;
  // The same document with the instant it was stamped at: the line a
  // recording writes for the draw that read it.
  readonly stamped: () => FactsLine;
  // The home every turn's payload is composed against: whose `~` it names.
  readonly home: () => string;
  // The client's hints the turn was composed from: what a draw takes of the
  // client beside the payload, so it never pairs a turn with a request it was
  // not composed from.
  readonly hints: () => ComposeInputs["hints"];
  // Why the turn after the one every read above is of could not be taken, or
  // why the facts source could not stamp the document it holds, or null when
  // the latest turn completed on a stamped document: while it is set the bar
  // is drawn from the last turn that did, and says so.
  readonly failure: () => string | null;
}

// [LAW:types-are-the-program] One turn: the document and everything the
// payload is composed from beside it, taken together.
interface Turn {
  readonly stamped: FactsLine;
  readonly compose: ComposeInputs;
  readonly draw: DrawInputs;
  readonly failure: string | null;
}

// What a turn reads, or what stopped it reading: a derivation that throws is a
// turn that did not complete, not a reaction that never ran.
type TurnInputs =
  | {
      readonly kind: "read";
      readonly stamped: FactsLine;
      readonly facts: string | null;
      readonly compose: ComposeInputs;
      readonly draw: DrawInputs;
    }
  | { readonly kind: "failed"; readonly reason: string };

// [LAW:single-enforcer] The one taking of a turn, against the turn it
// replaces. The prior turn itself is returned when nothing it holds moved, so
// nothing holding it is touched; a turn that cannot be taken keeps the prior
// one and says why, and a turn over a document its source could not restamp
// carries the source's reason.
//
// [LAW:no-silent-failure] A failed turn is a value the draw reads
// (`failure`), not only a line in the daemon's log.
function taken(prior: Turn, moved: TurnInputs): Turn {
  if (moved.kind === "failed") return failedWith(prior, moved.reason);
  return prior.failure === moved.facts &&
    moved.stamped === prior.stamped &&
    moved.compose === prior.compose &&
    moved.draw === prior.draw
    ? prior
    : {
        stamped: moved.stamped,
        compose: moved.compose,
        draw: moved.draw,
        failure: moved.facts,
      };
}

export interface SessionSourceDeps {
  // What the payload is composed with beyond the document, and the log for a
  // turn that fails.
  readonly providers: Pick<RenderPayloadDeps, "home" | "log">;
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
  return ({ sessionId, state, store, declared, followed, onDispose }) => {
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
    // Derivations, so each keeps its identity until an input of it moves, and
    // a turn that moved nothing of them is the turn before.
    const compose = store.derive(
      "session.compose",
      "computed",
      (): ComposeInputs => {
        const { facts } = declared();
        return {
          hookData: facts.hookData,
          hints: facts.hints,
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
    // [LAW:no-ambient-temporal-coupling] The turn is taken in a reaction's
    // effect, so a turn that cannot be taken keeps the prior one as a value:
    // a computed that threw would reach the draw as a throw. The first turn is
    // taken here, with no prior, so the box is total from its first read; a
    // throw in it is a failed open, which the view's opening releases.
    const turn = observable.box<Turn>(
      {
        stamped: followed.stamped(),
        compose: compose.read(),
        draw: draw.read(),
        failure: followed.failure(),
      },
      { deep: false },
    );
    onDispose(
      reaction(
        (): TurnInputs => {
          try {
            return {
              kind: "read",
              stamped: followed.stamped(),
              facts: followed.failure(),
              compose: compose.read(),
              draw: draw.read(),
            };
          } catch (e) {
            return {
              kind: "failed",
              reason: `reading the turn's inputs: ${String(e)}`,
            };
          }
        },
        (moved) =>
          runInAction(() => {
            const prior = turn.get();
            const next = taken(prior, moved);
            // [LAW:single-enforcer] The source's own fault was logged by the
            // source when it was set; a turn logs only a turn that failed.
            if (moved.kind === "failed" && next !== prior) {
              // [LAW:no-silent-failure] Told to the log as well as to the bar.
              deps.providers.log(
                "error",
                `session turn sid=${JSON.stringify(sessionId)}: ${next.failure}`,
              );
            }
            turn.set(next);
          }),
        {
          // The expression above cannot throw; the effect's catch is `taken`.
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
      const { stamped, compose: composed, draw: drawn } = turn.get();
      return composePayload(stamped.facts, composed, drawn);
    });
    return {
      payload: () => payload.read(),
      effective: () => turn.get().draw.effective,
      facts: () => turn.get().stamped.facts,
      stamped: () => turn.get().stamped,
      home: () => deps.providers.home,
      hints: () => turn.get().compose.hints,
      failure: () => turn.get().failure,
      selections: () => turn.get().draw.effective,
    };
  };
}
