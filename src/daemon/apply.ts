// [LAW:dataflow-not-control-flow][LAW:types-are-the-program] Apply: every
// source of change reaches the daemon's state as one arm of a closed Event
// union, and one table of arms is the only consumer. The table is keyed by
// every kind the union has, so adding a source of change is a compile error
// here until its arm exists, and no arm is a default. The journal's turn
// (src/daemon/journal-turns.ts) is the queue its click, menu-idle and
// effect-done arms write in.
//
// [LAW:effects-at-boundaries] An arm answers its source and describes the
// effects its turn asked for (src/daemon/effect.ts). The performer below runs
// them once the arm has answered, in the order described, and puts each
// outcome back on the queue as an effect-done event, whose arm is the one
// writer of what a failed effect leaves on the bar. So a click's reply never
// waits on a child process, and no write of the click path happens outside a
// turn.
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
import { holdClickError } from "./click-error.js";
import type { DaemonParts } from "./daemon-parts.js";
import { answerRequest, type RequestAnswer } from "./draw-bar.js";
import {
  describeEffect,
  failed,
  PERFORMED,
  type Effect,
  type EffectOutcome,
  type LaunchSpec,
} from "./effect.js";
import type { ClickAsker } from "./journal-turns.js";
import type { MenuIdle } from "./menu-idle.js";
import { eventLine, type RequestFacts } from "./request-event.js";
import type { CheckedRenderRequest } from "./render-checkpoint.js";
import { DaemonClosing } from "./verb-error.js";
import {
  CLICK_PROGRAM_TIMEOUT_MS,
  closeIdleMenus,
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
      // checkpoint: pending on its menus' idle clock until the click settles.
      readonly pending: string | null;
      // Where the click's waits are reported, and whether its client left.
      readonly asker: ClickAsker;
    }
  | {
      readonly kind: "menu-idle";
      readonly session: string;
      readonly idle: IdleClose;
    }
  | {
      readonly kind: "effect-done";
      readonly of: EffectOrigin;
      readonly effect: Effect;
      readonly outcome: EffectOutcome;
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
  readonly request: RequestAnswer;
  readonly click: ClickRefusal | null;
  readonly "menu-idle": void;
  readonly "effect-done": void;
}

// [LAW:types-are-the-program] What each arm reads of the daemon: the request
// draws with the whole of it; the others write through the verb context and
// say what they did through the log, and the click brackets its session on
// the idle clock. A test applies a click over exactly those and nothing more.
export type ApplyParts = Pick<DaemonParts, "verbCtx" | "log">;
interface ArmParts {
  readonly request: DaemonParts;
  readonly click: ApplyParts & {
    readonly menuIdle: Pick<MenuIdle, "clickArrived" | "clickSettled">;
  };
  readonly "menu-idle": ApplyParts;
  readonly "effect-done": ApplyParts;
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
  // [LAW:single-enforcer] exception: the request takes no turn yet, so its
  // writes (the session's render origin and client hints) still land outside
  // one. They join the turn with the request's own (the next story of this
  // lane), now that a click's launches no longer hold it.
  request: async ({ req, at, waitEndsAt, facts }, parts) => ({
    answer: await answerRequest(parts, req, at, waitEndsAt, facts),
    effects: NO_EFFECTS,
    facts: [],
  }),
  // [LAW:single-enforcer] The click's whole bracket on its menus' idle clock
  // is here, so the timer cannot close a menu under any click Apply carries.
  // The turn hands its effects over once it has committed (`described`), and
  // a refused step is answered beside them.
  click: async (
    { verb, value, arrival, pending, asker },
    { verbCtx, menuIdle },
  ) => {
    if (pending !== null) menuIdle.clickArrived(pending);
    const effects: Effect[] = [];
    let answer: ClickRefusal | null = null;
    try {
      await verb.run(value, {
        ...verbCtx,
        arrival,
        asker,
        described: (described) => void effects.push(...described),
      });
    } catch (error) {
      answer = { error };
    } finally {
      if (pending !== null) menuIdle.clickSettled(pending);
    }
    return { answer, effects, facts: [] };
  },
  "menu-idle": async ({ session, idle }, { verbCtx }) => {
    const effects: Effect[] = [];
    await closeIdleMenus(session, idle, {
      ...verbCtx,
      described: (described) => void effects.push(...described),
    });
    return { answer: undefined, effects, facts: [] };
  },
  // [LAW:single-enforcer] The one writer of what a failed effect leaves: the
  // session's click error, held in a turn of its own as every write is, and
  // shown as a failed dispatch's is (src/daemon/click-error.ts). A click that
  // names no session has no bar; its apply line is the record.
  "effect-done": async ({ of, outcome }, { verbCtx }) => {
    const facts: RequestFacts = [];
    await verbCtx.journalTurns.take(
      "effect-done",
      {
        waited: (ms) => facts.push(["turnWait", `${ms}ms`]),
        gone: () => false,
      },
      async () => {
        if (outcome.kind === "failed" && of.session !== null) {
          holdClickError(
            verbCtx.sessionState,
            of.session,
            outcome.said,
            verbCtx.now(),
          );
        }
      },
    );
    return { answer: undefined, effects: NO_EFFECTS, facts };
  },
};

// [LAW:types-are-the-program] Generic over the kind, so the arm `ARMS[kind]`
// picks, the parts it reads and the answer it gives are the ones `ApplyArms`
// pairs with it. Answers once the arm has: the effects run after, and
// `performed` settles when the last has reported. It never rejects, so a
// source may drop it; a test awaits it.
export async function apply<K extends Event["kind"]>(
  event: Extract<Event, { readonly kind: K }>,
  parts: ArmParts[K],
): Promise<{ readonly answer: Answers[K]; readonly performed: Promise<void> }> {
  const arm: ApplyArms<Event>[K] = ARMS[event.kind];
  const applied: Applied<K> = await arm(event, parts);
  const of = originOf(event);
  const line: (typeof LINE)[K] = LINE[event.kind];
  const said = line(event);
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
    performed: performAll(parts, of, applied.effects),
  };
}

// [LAW:nothing-unseen] One `apply` line per applied event, from the layer
// every event passes through: the kind, the verb, the session, the effects
// described, the revision the session's state stands at once the turn is
// over, and on effect-done the effect and how it went. What each kind adds
// of its own is here, and at what level; the request's line is the render
// line its edge writes (four of five lines in a live log), until its turn
// gives it a revision.
interface ApplyLine {
  readonly level: LogLevel;
  readonly facts: RequestFacts;
}
const APPLIED: ApplyLine = { level: "info", facts: [] };
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
  ) => ApplyLine | null;
} = {
  request: () => null,
  click: () => APPLIED,
  "menu-idle": () => APPLIED,
  "effect-done": ({ effect, outcome }) => ({
    level: OUTCOME_LEVEL[outcome.kind],
    facts: [
      ["effect", describeEffect(effect)],
      ["outcome", outcome.kind],
      ["said", outcome.said || "-"],
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
  click: ({ verb, pending }) => ({ verb: verb.name, session: pending }),
  "menu-idle": ({ session }) => ({ verb: "menu-idle", session }),
  "effect-done": ({ of }) => of,
};

function originOf<K extends Event["kind"]>(
  event: Extract<Event, { readonly kind: K }>,
): EffectOrigin {
  const origin: (typeof ORIGIN)[K] = ORIGIN[event.kind];
  return origin(event);
}

// ─── The performer ──────────────────────────────────────────────────────────

// [LAW:types-are-the-program] One performer per kind of effect, none missing:
// an effect added to the union fails to build until it has one.
type Performers<E extends { readonly kind: string }> = {
  readonly [K in E["kind"]]: (
    effect: Extract<E, { readonly kind: K }>,
    parts: ApplyParts,
  ) => Promise<EffectOutcome>;
};

const PERFORM: Performers<Effect> = {
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

// [LAW:single-enforcer] The one place a performer's throw becomes an outcome:
// an edge that throws (tmux itself failing, the act refused) failed the
// effect, in its own words.
async function perform<K extends Effect["kind"]>(
  effect: Extract<Effect, { readonly kind: K }>,
  parts: ApplyParts,
): Promise<EffectOutcome> {
  const performer: Performers<Effect>[K] = PERFORM[effect.kind];
  try {
    return await performer(effect, parts);
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}

// [LAW:effects-at-boundaries] After the turn, each effect in the order it was
// described, and each outcome back through Apply. Never rejects: an outcome
// is data, and an effect-done the daemon's close refused is said here, since
// the bar it would have reached is gone with the turns.
async function performAll(
  parts: ApplyParts,
  of: EffectOrigin,
  effects: readonly Effect[],
): Promise<void> {
  for (const effect of effects) {
    const outcome = await perform(effect, parts);
    try {
      await apply({ kind: "effect-done", of, effect, outcome }, parts);
    } catch (e) {
      parts.log(
        e instanceof DaemonClosing ? "info" : "error",
        `apply: effect-done not applied (${describeEffect(effect)} ${outcome.kind}: ${outcome.said}): ${inspect(e)}`,
      );
    }
  }
}
