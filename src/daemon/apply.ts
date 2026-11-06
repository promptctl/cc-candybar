// [LAW:dataflow-not-control-flow][LAW:types-are-the-program] Apply: every
// source of change reaches the daemon's state as one arm of a closed Event
// union, and one table of arms is the only consumer. The table is keyed by
// every kind the union has, so adding a source of change is a compile error
// here until its arm exists, and no arm is a default. Every arm writes in a
// journal turn (src/daemon/journal-turns.ts), which is synchronous: the
// request records what its client said there and draws once the turn is
// over, so a frame never reads the request's hints beside a click's writes
// half landed.
//
// [LAW:effects-at-boundaries] An arm answers its source and describes the
// effects its turn asked for (src/daemon/effect.ts). The performer below runs
// them once the arm has answered, in the order described, and applies each
// outcome as an effect-done event, whose arm is the one writer of what the
// effect leaves: a doctor's report, or a failure on the bar. So a click's
// reply never waits on a child process, no turn waits on one either, and no
// write of the click path happens outside a turn.
//
// An arm joins the union when its source is routed through Apply, and not
// before: an arm with no producer is a handler nothing can reach.

import { inspect } from "node:util";
import { typeSlash } from "../claude-input/edge.js";
import type { ClickArrival } from "../doctor/sightings.js";
import { failureText, type Launcher } from "../proc/launch.js";
import type { Monotonic } from "../time.js";
import type { Instant } from "../utils/instant.js";
import type { LogLevel } from "../utils/logger.js";
import {
  answeredClickError,
  holdClickError,
  type ClickErrorRecord,
} from "./click-error.js";
import type { DaemonParts } from "./daemon-parts.js";
import type { RequestAnswer } from "./draw-bar.js";
import {
  describeEffect,
  type Effect,
  type EffectDone,
  type LaunchSpec,
  type OutcomeOf,
} from "./effect.js";
import { failed, PERFORMED, type EffectOutcome } from "./effect-outcome.js";
import {
  SESSION_CLIENT_HINTS_KEY,
  SESSION_RENDER_ORIGIN_KEY,
} from "./foundations/session-keys.js";
import { eventLine, noteFacts, type RequestFacts } from "./request-event.js";
import type { CheckedRenderRequest } from "./render-checkpoint.js";
import type { SessionStateRW } from "./session-state.js";
import { BadVerbArgs, DaemonClosing } from "./verb-error.js";
import {
  CLICK_PROGRAM_TIMEOUT_MS,
  closeIdleMenus,
  gatherDoctor,
  landDoctor,
  type ClickVerb,
  type IdleClose,
} from "./verbs/index.js";

// Whose effects these are: the verb that described them, and the session
// whose bar a failure reaches (none for a click that names no session).
export interface EffectOrigin {
  readonly verb: string;
  readonly session: string | null;
}

export type Event =
  | {
      readonly kind: "request";
      readonly req: CheckedRenderRequest;
      readonly at: Instant;
      // When the request's wait ends (src/daemon/request-deadline.ts).
      readonly waitEndsAt: Monotonic;
      readonly facts: RequestFacts;
    }
  | {
      readonly kind: "click";
      readonly verb: ClickVerb;
      readonly value: string;
      readonly arrival: ClickArrival;
      // The session the click names, once it passed the session-id
      // checkpoint.
      readonly session: string | null;
      // Whether its client has left: told TIMEOUT, or hung up, while the click
      // sat behind the loop.
      readonly gone: () => boolean;
    }
  | {
      readonly kind: "menu-idle";
      readonly session: string;
      readonly idle: IdleClose;
    }
  | {
      readonly kind: "effect-done";
      readonly of: EffectOrigin;
      readonly done: EffectDone;
    }
  // A request's answer carrying `errors`, click errors the session held,
  // reached its client (src/daemon/reply.ts).
  | {
      readonly kind: "answered";
      readonly session: string;
      readonly errors: readonly ClickErrorRecord[];
    };

// [LAW:effects-at-boundaries] A click's refusal, as its answer: the failure
// of a step, answered as data beside the effects its landed steps described,
// so the performer runs those while the source tells the client. Its class is
// what the wire reads (src/daemon/reply.ts `clickRan`).
export interface ClickRefusal {
  readonly error: unknown;
}

// What applying each kind answers its source with.
interface Answers {
  readonly request: void;
  readonly click: ClickRefusal | null;
  readonly "menu-idle": void;
  // How the effect went, as it landed.
  readonly "effect-done": EffectOutcome;
  readonly answered: void;
}

// [LAW:types-are-the-program] What each arm reads of the daemon: every arm
// writes through the verb context and says what it did through the log. A
// test applies an event over exactly those and nothing more.
export type ApplyParts = Pick<DaemonParts, "verbCtx" | "log">;
interface ArmParts {
  readonly request: ApplyParts;
  readonly click: ApplyParts;
  readonly "menu-idle": ApplyParts;
  readonly "effect-done": ApplyParts;
  readonly answered: ApplyParts;
}

// [LAW:types-are-the-program] The answers and the parts name exactly the
// union's kinds: a kind without either, or either without a kind, fails to
// build here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const answered: Same<Event["kind"], keyof Answers> = true;
const parted: Same<Event["kind"], keyof ArmParts> = true;
void [answered, parted];

// What applying an event produced: its source's answer, the effects its turn
// described, and the facts its apply line carries beside them.
export interface Applied<K extends keyof Answers> {
  readonly answer: Answers[K];
  readonly effects: readonly Effect[];
  readonly facts: RequestFacts;
}

// [LAW:types-are-the-program] One arm per kind of `E`, none missing and none
// extra: a union widened by an arm fails to build an `ApplyArms` until the arm
// is written.
export type ApplyArms<E extends { readonly kind: string }> = {
  readonly [K in E["kind"]]: (
    event: Extract<E, { readonly kind: K }>,
    parts: ArmParts[K & keyof ArmParts],
  ) => Promise<Applied<K & keyof Answers>>;
};

const NO_EFFECTS: readonly Effect[] = [];

export const ARMS: ApplyArms<Event> = {
  // [LAW:single-enforcer] The request's writes take their turn as a click's
  // do: what it said of its client and the config inputs it named land in one
  // batch in a journal turn, with what its arrival settles (the lane setups
  // its session's clicks owed, described as the turn's effects), and its draw
  // begins once the turn is over (`applyRequest`). A turn is synchronous
  // (src/daemon/journal-turns.ts), so the request waits behind no other
  // session's work, and no draw, this one or a feed's, can read a click half
  // landed. The revision its turn left and the effects it described go on the
  // request's line, the render event, which is its record and opens with the
  // session the edge noted.
  request: async ({ req, facts }, { verbCtx }) => {
    const turn = verbCtx.journalTurns.take("request", () => {
      recordRequest(verbCtx.sessionState, req);
      return {
        effects: verbCtx.lanes.arrived(req),
        revision: verbCtx.sessionState.revision(req.sessionId),
      };
    });
    noteFacts(facts, {
      revision: String(turn.revision),
      effects: turn.effects.map((e) => describeEffect(e)).join(",") || "-",
    });
    return { answer: undefined, effects: turn.effects, facts: [] };
  },
  // The turn hands its effects over once it has committed (`described`), and
  // a refused step is answered beside them; a click whose client has left is
  // refused by the verb, where it would land (src/daemon/verbs/index.ts). A
  // turn is synchronous, so no idle timer can close a menu under one.
  click: async ({ verb, value, arrival, gone }, { verbCtx }) => {
    const effects: Effect[] = [];
    let answer: ClickRefusal | null = null;
    try {
      verb.run(value, {
        ...verbCtx,
        arrival,
        gone,
        described: (described) => void effects.push(...described),
      });
    } catch (error) {
      answer = { error };
    }
    return { answer, effects, facts: [] };
  },
  "menu-idle": async ({ session, idle }, { verbCtx }) => {
    const effects: Effect[] = [];
    closeIdleMenus(session, idle, {
      ...verbCtx,
      described: (described) => void effects.push(...described),
    });
    return { answer: undefined, effects, facts: [] };
  },
  // [LAW:single-enforcer] The one writer of what an effect's outcome leaves:
  // its landing, in a turn of its own as every write is, answers how it went
  // (`LANDINGS`), and a failure is held as the session's click error, shown as
  // a failed dispatch's is (src/daemon/click-error.ts). A click that names no
  // session has no bar; its apply line is the record.
  "effect-done": async ({ of, done }, parts) => {
    const { verbCtx } = parts;
    const outcome = verbCtx.journalTurns.take("effect-done", () => {
      const landed = land(done, parts);
      if (landed.kind === "failed" && of.session !== null) {
        holdClickError(
          verbCtx.sessionState,
          of.session,
          landed.said,
          verbCtx.now(),
        );
      }
      return landed;
    });
    return { answer: outcome, effects: NO_EFFECTS, facts: [] };
  },
  // [LAW:single-enforcer] The one write after a request's answer went out: the
  // click errors it carried are marked answered (src/daemon/click-error.ts), in
  // a turn as every write is, so no frame reads the mark beside a click's
  // writes half landed.
  answered: async ({ session, errors }, { verbCtx }) => {
    verbCtx.journalTurns.take("answered", () =>
      answeredClickError(verbCtx.sessionState, session, errors),
    );
    return { answer: undefined, effects: NO_EFFECTS, facts: [] };
  },
};

// [LAW:types-are-the-program] What each kind of effect's outcome becomes as
// it lands, in the outcome's turn, none missing: an act's outcome is how it
// went, and a doctor's gathered facts are its step's to answer.
type Landings = {
  readonly [K in Effect["kind"]]: (
    done: Extract<EffectDone, { readonly effect: { readonly kind: K } }>,
    verbCtx: ApplyParts["verbCtx"],
  ) => EffectOutcome;
};
const asIs = ({
  outcome,
}: {
  readonly outcome: EffectOutcome;
}): EffectOutcome => outcome;
const LANDINGS: Landings = {
  launch: asIs,
  "type-slash": asIs,
  "apply-update": asIs,
  run: asIs,
  "lane-setup": asIs,
  doctor: ({ effect, outcome }, verbCtx) => {
    if (outcome.kind === "failed") return outcome;
    landDoctor(verbCtx, effect, outcome.gathered);
    return PERFORMED;
  },
};

// A landing's refusal (an input moved, nothing to fix) failed the effect.
function land<K extends Effect["kind"]>(
  done: Extract<EffectDone, { readonly effect: { readonly kind: K } }>,
  parts: ApplyParts,
): EffectOutcome {
  const landing: Landings[K] = LANDINGS[done.effect.kind];
  try {
    return landing(done, parts.verbCtx);
  } catch (e) {
    return thrown(done.effect, e, parts.log);
  }
}

// [LAW:single-enforcer][LAW:no-silent-failure] The one place a throw from a
// performer or a landing becomes an outcome: the effect failed, in the
// thrower's own words, which the bar shows. A refusal (BadVerbArgs) or the
// daemon's close is said whole by those words; anything else is a fault of
// the daemon's, whose words alone cannot locate it, so the log has it in
// full, stack and all, at error.
function thrown(
  effect: Effect,
  e: unknown,
  log: ApplyParts["log"],
): Extract<EffectOutcome, { readonly kind: "failed" }> {
  if (!(e instanceof BadVerbArgs || e instanceof DaemonClosing)) {
    log("error", `apply: ${describeEffect(effect)} threw: ${inspect(e)}`);
  }
  return failed(e instanceof Error ? e.message : String(e));
}

// [LAW:effects-at-boundaries][LAW:one-source-of-truth] What a render request
// said, recorded in its turn and never by a frame, which only draws. The STAMPED hints: a click arrives
// with no hints of its own, so the doctor (verbs/index.ts) reads the facts of
// this session's last request from here, re-parsed through the same
// checkpoint. The client itself is not recorded: which client drew a
// session's bar is RenderSightings' fact (src/daemon/render-sightings.ts),
// held in memory, and two clients drawing one session would otherwise
// rewrite this persisted record on every request. Nor is the config the
// client's environment named: the origin is the one record of the config a
// request named, home-relative when it lies in the home, which a copy in the
// hints would spell absolute. The config inputs the
// request named, so a durable click on this session resolves the same chain
// (verbs/index.ts sessionOrigin) and writes the file the next reload reads,
// never a path re-derived from the daemon's own cwd. Compared before writing:
// every write persists and fires the session's MobX atom, so an unchanged
// request writes nothing and invalidates no state-driven computed.
function recordRequest(state: SessionStateRW, req: CheckedRenderRequest): void {
  const { client: _client, configEnv: _configEnv, ...recorded } = req.hints;
  const said = [
    { key: SESSION_CLIENT_HINTS_KEY, value: JSON.stringify(recorded) },
    {
      key: SESSION_RENDER_ORIGIN_KEY,
      value: req.originRecord,
    },
  ];
  state.setBatch(
    req.sessionId,
    said.filter(({ key, value }) => state.get(req.sessionId, key) !== value),
  );
}

// [LAW:types-are-the-program] Generic over the kind, so the arm `ARMS[kind]`
// picks, the parts it reads and the answer it gives are the ones `ApplyArms`
// pairs with it. Answers once the arm has: the effects run after, and
// `performed` settles when the last has reported. `performed` never rejects,
// so a source may drop it, and a test awaits it; `apply` itself rejects as
// its arm does (a turn the close refused, a commit that threw), which a
// source answers as it answers the arm.
export async function apply<K extends Event["kind"]>(
  event: Extract<Event, { readonly kind: K }>,
  parts: ArmParts[K],
): Promise<{ readonly answer: Answers[K]; readonly performed: Promise<void> }> {
  const arm: ApplyArms<Event>[K] = ARMS[event.kind];
  const applied: Applied<K> = await arm(event, parts);
  const of = originOf(event);
  const line: (typeof LINE)[K] = LINE[event.kind];
  const said = line(event, applied);
  if (said !== null) {
    parts.log(
      said.level,
      eventLine("apply", [
        ["kind", event.kind],
        ["verb", of.verb],
        ["sid", of.session ?? "-"],
        ...said.facts,
        ...applied.facts,
        [
          "effects",
          applied.effects.map((e) => describeEffect(e)).join(",") || "-",
        ],
        [
          "revision",
          of.session === null
            ? "-"
            : String(parts.verbCtx.sessionState.revision(of.session)),
        ],
      ]),
    );
  }
  return {
    answer: applied.answer,
    // An event that described nothing performs nothing, and takes no place in
    // the session's order: the effect-done events of that order are applied
    // from inside it, and a place they took there would settle only after the
    // work they report on.
    performed:
      applied.effects.length === 0
        ? NOTHING_PERFORMED
        : performAll(parts, of, applied.effects),
  };
}

const NOTHING_PERFORMED: Promise<void> = Promise.resolve();

// [LAW:no-ambient-temporal-coupling] A request applied, then drawn: the draw
// begins once its turn is over and the effects the turn described have joined
// the session's order, so a click made during the draw's wait is performed
// after them, a draw that fails loses none, and a request its turn refused is
// never drawn.
export async function applyRequest(
  event: Extract<Event, { readonly kind: "request" }>,
  parts: ApplyParts & Pick<DaemonParts, "draw">,
): Promise<RequestAnswer> {
  await apply(event, parts);
  return parts.draw(event.req, event.at, event.waitEndsAt, event.facts);
}

// [LAW:nothing-unseen] One `apply` line per applied event, from the layer
// every event passes through: the kind, the verb, the session, the effects
// described, the revision the session's state stands at once the turn is
// over, and on effect-done the effect and how it went. What each kind adds
// of its own is here, and at what level: its outcome first, since a click
// the turn refused is applied too, with its refusal for an outcome.
// [LAW:one-source-of-truth] The request's one line is the render event its
// edge writes (four of five lines in a live log), which its arm puts the
// turn's wait and revision on; a second line per request would be a second
// record of one unit of work.
interface ApplyLine {
  readonly level: LogLevel;
  readonly facts: RequestFacts;
}
const APPLIED: ApplyLine = { level: "info", facts: [["outcome", "ok"]] };
const refused = ({ error }: ClickRefusal): ApplyLine => ({
  level: "info",
  facts: [
    ["outcome", "refused"],
    ["said", error instanceof Error ? error.message : String(error)],
  ],
});
// [LAW:no-silent-failure] A failed effect is a warning in the log, whether or
// not a bar shows it: for a click that names no session, the line is the one
// record.
const OUTCOME_LEVEL: Record<EffectOutcome["kind"], LogLevel> = {
  ok: "info",
  failed: "warn",
};
const LINE: {
  readonly [K in Event["kind"]]: (
    event: Extract<Event, { readonly kind: K }>,
    applied: Applied<K & keyof Answers>,
  ) => ApplyLine | null;
} = {
  request: () => null,
  click: (_event, { answer }) => (answer === null ? APPLIED : refused(answer)),
  "menu-idle": () => APPLIED,
  answered: () => APPLIED,
  "effect-done": ({ done }, { answer }) => ({
    level: OUTCOME_LEVEL[answer.kind],
    facts: [
      ["effect", describeEffect(done.effect)],
      ["outcome", answer.kind],
      ["said", answer.said || "-"],
    ],
  }),
};

// Whose effects an event's are.
const ORIGIN: {
  readonly [K in Event["kind"]]: (
    event: Extract<Event, { readonly kind: K }>,
  ) => EffectOrigin;
} = {
  request: ({ req }) => ({ verb: "request", session: req.sessionId }),
  click: ({ verb, session }) => ({ verb: verb.name, session }),
  "menu-idle": ({ session }) => ({ verb: "menu-idle", session }),
  "effect-done": ({ of }) => of,
  answered: ({ session }) => ({ verb: "answered", session }),
};

// [LAW:no-silent-failure][LAW:single-enforcer] What a source with no reply
// to carry a rejection says of one: the delivery edge, the performer, the
// menus' idle timer. At info when it is the daemon's close, since the bar it
// would have reached is gone with the turns.
export function sayUnapplied(
  log: DaemonParts["log"],
  kind: Event["kind"],
  said: string,
  error: unknown,
): void {
  log(
    error instanceof DaemonClosing ? "info" : "error",
    `apply: ${kind} not applied (${said}): ${inspect(error)}`,
  );
}

// An event whose source has no reply to carry a rejection, applied, and a
// refusal said in the log.
export function applyUnanswered<K extends Event["kind"]>(
  event: Extract<Event, { readonly kind: K }>,
  parts: ArmParts[K],
  said: string,
): Promise<void> {
  return apply(event, parts).then(
    () => undefined,
    (e: unknown) => sayUnapplied(parts.log, event.kind, said, e),
  );
}

function originOf<K extends Event["kind"]>(
  event: Extract<Event, { readonly kind: K }>,
): EffectOrigin {
  const origin: (typeof ORIGIN)[K] = ORIGIN[event.kind];
  return origin(event);
}

// ─── The performer ──────────────────────────────────────────────────────────

// [LAW:types-are-the-program] One performer per kind of effect, none missing:
// an effect added to the union fails to build until it has one.
type Performers = {
  readonly [K in Effect["kind"]]: (
    effect: Extract<Effect, { readonly kind: K }>,
    parts: ApplyParts,
  ) => Promise<OutcomeOf<K>>;
};

const PERFORM: Performers = {
  launch: ({ spec, what }, { verbCtx }) =>
    clickLaunch(verbCtx.launcher, spec, what),
  "type-slash": async ({ pane, line }, { verbCtx }) => {
    const typed = await typeSlash(verbCtx.claudeInput, pane, line);
    return typed.kind === "typed"
      ? { kind: "ok", said: `typed into ${typed.pane}` }
      : failed(`${line} was not typed: ${typed.reason}`);
  },
  "apply-update": async (_effect, { verbCtx }) => {
    await verbCtx.applyUpdate();
    return PERFORMED;
  },
  run: ({ id, run }, { verbCtx }) => verbCtx.runs.run(id, run),
  "lane-setup": (effect, { verbCtx }) => verbCtx.lanes.setup(effect),
  // The doctor's probes, gathered after the click's turn, in no turn: its
  // step lands with the facts (`LANDINGS`).
  doctor: async (effect, { verbCtx }) => ({
    kind: "gathered",
    gathered: await gatherDoctor(verbCtx, effect),
  }),
};

// [LAW:one-type-per-behavior] A click's launch of a program it waits out,
// the clipboard or an editor, each of which hands off and exits.
// [LAW:no-ambient-temporal-coupling] The bound is what every click launch
// has, and it is the performer's, not the click's: a hung program ends with
// its outcome said and `performed` settled, where it once held the turn.
export async function clickLaunch(
  launcher: Launcher,
  spec: LaunchSpec,
  what: string,
): Promise<EffectOutcome> {
  const result = await launcher.launch({
    ...spec,
    timeoutMs: CLICK_PROGRAM_TIMEOUT_MS,
  });
  return result.ok
    ? PERFORMED
    : failed(`${what} failed (${failureText(result)})`);
}

// An edge that throws (tmux itself failing, the act refused) failed the
// effect.
async function perform<K extends Effect["kind"]>(
  effect: Extract<Effect, { readonly kind: K }>,
  parts: ApplyParts,
): Promise<EffectDone> {
  const performer: Performers[K] = PERFORM[effect.kind];
  let outcome: OutcomeOf<K> | ReturnType<typeof thrown>;
  try {
    outcome = await performer(effect, parts);
  } catch (e) {
    outcome = thrown(effect, e, parts.log);
  }
  // [LAW:types-are-the-program] exception: every kind's outcome admits a
  // failure, and the performer is the one its kind picked, so the pair is
  // that kind's; the checker cannot close that over a kind left open.
  return { effect, outcome } as EffectDone;
}

// [LAW:effects-at-boundaries] After the turn, each effect in the order it was
// described, behind the session's earlier effects (`performing`), and each
// outcome back through Apply. Never rejects: an outcome is data.
function performAll(
  parts: ApplyParts,
  of: EffectOrigin,
  effects: readonly Effect[],
): Promise<void> {
  return parts.verbCtx.journalTurns.performing(of.session, async () => {
    for (const effect of effects) {
      const done = await perform(effect, parts);
      await applyUnanswered(
        { kind: "effect-done", of, done },
        parts,
        `${describeEffect(effect)} ${done.outcome.kind}${"said" in done.outcome ? `: ${done.outcome.said}` : ""}`,
      );
    }
  });
}
