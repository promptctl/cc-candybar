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
import type {
  ClickState,
  FactsLine,
  RecordedTurn,
  SessionRequest,
} from "../facts/recording.js";
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

// What a session's view draws from: the selections its slots settle and the
// payload its inputs read, as ViewSource names them, the globals the session's
// picks resolve to (what the draw's options are built from, beside the
// payload's `.effective` fields).
export interface SessionSource extends ViewSource {
  readonly payload: () => ViewPayload;
  readonly effective: () => EffectiveGlobals;
  // The session's facts document (src/facts/session-facts.ts), as the turn
  // holds it.
  readonly facts: () => SessionFacts;
  // The turn the bar is drawn from, as a recording carries it: its document
  // with the instant it was stamped at, the request and the store's state it
  // was taken over, and the histories' depths it read.
  readonly turn: () => RecordedTurn;
  // Whether the bar is held on the last turn taken because the next one's
  // inputs could not be read. A recording marks where this moves, so a replay
  // holds its turn over the same lines.
  readonly held: () => boolean;
  // The home the turn's payload was composed against: whose `~` it names.
  readonly home: () => string;
  // The client's hints the turn was composed from: what a draw takes of the
  // client beside the payload, so it never pairs a turn with a request it was
  // not composed from.
  readonly hints: () => ComposeInputs["hints"];
  // Why the turn after the one every read above is of could not be taken, or
  // why the facts source could not stamp the document it holds, or null when
  // the latest turn completed on a stamped document: while it is set the bar
  // is drawn from the last turn that did, and says which.
  readonly failure: () => TurnFailure | null;
  // What the session's clicks left for a draw now: the store's values and
  // revision for it, which its `state` variables and its frame memory read,
  // and the histories' depths the turn's payload carries. A recording notes it
  // with the draw that read it.
  readonly state: () => ClickState;
}

// [LAW:types-are-the-program] Why the bar is drawn from an older turn: the
// next turn's inputs could not be read, so the turn is held on the last one
// taken; or the facts source could not restamp its document, so the turn is
// taken over the one it kept.
export interface TurnFailure {
  readonly cause: "inputs" | "facts";
  readonly reason: string;
}

// [LAW:types-are-the-program] One turn: the document and everything the
// payload is composed from beside it, taken together, with the request and the
// store's state it was taken over — the picks its globals were resolved from.
interface Turn {
  readonly stamped: FactsLine;
  readonly request: SessionRequest;
  readonly picks: Pick<ClickState, "values" | "revision">;
  readonly compose: ComposeInputs;
  readonly draw: DrawInputs;
  readonly failure: TurnFailure | null;
}

// What a turn reads, or what stopped it reading: a derivation that throws is a
// turn that did not complete, not a reaction that never ran.
type TurnInputs =
  | {
      readonly kind: "read";
      readonly stamped: FactsLine;
      readonly facts: string | null;
      readonly request: SessionRequest;
      readonly compose: ComposeInputs;
      readonly draw: DrawInputs;
    }
  | { readonly kind: "failed"; readonly reason: string };

// The failure a turn carries, compared by value: a fault that persists must
// not mint a new turn per move, which would wake every holder and log again
// for a bar that has not changed.
function sameFailure(a: TurnFailure | null, b: TurnFailure | null): boolean {
  return a === b || (a?.cause === b?.cause && a?.reason === b?.reason);
}

// [LAW:single-enforcer] The one taking of a turn, against the turn it
// replaces. The prior turn itself is returned when nothing it holds moved, so
// nothing holding it is touched; a turn that cannot be taken keeps the prior
// one and says why, and a turn over a document its source could not restamp
// carries the source's reason. `picks` is read only for a turn taken new: the
// store's state then is the one its globals were just resolved from, and a
// copy compared by identity would mint a turn per move.
//
// [LAW:no-silent-failure] A failed turn is a value the draw reads
// (`failure`), not only a line in the daemon's log.
function taken(
  prior: Turn,
  moved: TurnInputs,
  picks: () => Turn["picks"],
): Turn {
  if (moved.kind === "failed") {
    const failure: TurnFailure = { cause: "inputs", reason: moved.reason };
    return sameFailure(prior.failure, failure) ? prior : { ...prior, failure };
  }
  const failure: TurnFailure | null =
    moved.facts === null ? null : { cause: "facts", reason: moved.facts };
  return sameFailure(prior.failure, failure) &&
    moved.stamped === prior.stamped &&
    moved.request === prior.request &&
    moved.compose === prior.compose &&
    moved.draw === prior.draw
    ? prior
    : {
        stamped: moved.stamped,
        request: moved.request,
        picks: picks(),
        compose: moved.compose,
        draw: moved.draw,
        failure,
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

// [LAW:types-are-the-program] Built over a view declared with a session's
// request, so a turn holds the request it was composed from, directory and
// all, as a recording restates it.
export function sessionSource(
  deps: SessionSourceDeps,
): SourceOf<SessionSource, SessionRequest> {
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
    const picks = (): Turn["picks"] => ({
      values: deps.sessionState.values(sessionId),
      revision: deps.sessionState.revision(sessionId),
    });
    const opening = followed.failure();
    const turn = observable.box<Turn>(
      {
        stamped: followed.stamped(),
        request: declared().facts,
        picks: picks(),
        compose: compose.read(),
        draw: draw.read(),
        failure: opening === null ? null : { cause: "facts", reason: opening },
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
              request: declared().facts,
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
            // The effect runs untracked, in the run its inputs were read in.
            const next = taken(prior, moved, picks);
            // [LAW:single-enforcer] The source's own fault was logged by the
            // source when it was set; a turn logs only a turn that failed.
            if (moved.kind === "failed" && next !== prior) {
              // [LAW:no-silent-failure] Told to the log as well as to the bar.
              deps.providers.log(
                "error",
                `session turn sid=${JSON.stringify(sessionId)}: ${moved.reason}`,
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
      turn: () => {
        const { stamped, request, picks: taken, draw: drawn } = turn.get();
        return {
          document: stamped,
          request,
          state: { ...taken, history: drawn.history, back: drawn.back },
        };
      },
      held: () => turn.get().failure?.cause === "inputs",
      home: () => turn.get().compose.home,
      hints: () => turn.get().compose.hints,
      failure: () => turn.get().failure,
      selections: () => turn.get().draw.effective,
      state: () => ({
        values: deps.sessionState.values(sessionId),
        revision: deps.sessionState.revision(sessionId),
        history: turn.get().draw.history,
        back: turn.get().draw.back,
      }),
    };
  };
}
