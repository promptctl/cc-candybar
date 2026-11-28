import {
  historyAfterEdits,
  durableHistory,
  type SessionHistory,
} from "../renderer-interface/history-storage.js";
import { VERB_APPLY_LAYOUT_OP, VERB_COPY_DIAGNOSTIC } from "../click/wire.js";
import { decodeLayoutOp } from "../config/layout-ops.js";
import { isPlainObject } from "../config/loader/validate-core.js";
import type {
  Event,
  EventInput,
  SessionRenderer,
  RendererOutput,
} from "../renderer-interface/interface.js";
import {
  RECORDING_VERSION,
  type RecordedConstruction,
} from "../renderer-interface/recording.js";
import {
  rendererBootFrom,
  sessionCommitOf,
  RENDERER_WIRE_VERSION,
} from "../renderer-interface/wire.js";
import { sha256Text } from "../utils/sha256.js";
import type { CompileInput } from "../dsl/render.js";
import { regionFor } from "../utils/region.js";
import { ownValue } from "../utils/plain.js";
import {
  storedPicksAfter,
  withoutRetiredKeys,
  type SessionPicks,
  type StoredState,
} from "../renderer-interface/stored-state.js";
import type { SessionId } from "../daemon/foundations/session-id.js";
import { validFeedResumes } from "../renderer-interface/feed-history.js";
import { mainRendererOf } from "./main.js";

// [LAW:parse-dont-validate] Admit known event arms with their required
// payload fields. The agreed private wire version still owns nested DTOs.
const EVENT_FIELDS = {
  start: ["viewers", "sessions", "configs"],
  context: ["context", "worldState"],
  config: ["origin", "config"],
  request: ["id", "context"],
  "world-state": ["worldState"],
  retire: ["session"],
  "effect-done": ["session", "of", "outcome"],
  click: ["click", "context"],
  viewers: ["viewers"],
  due: [],
  stats: [],
  debug: ["what"],
  "close-journal": [],
  "close-views": [],
} as const satisfies {
  readonly [K in Event["kind"]]: ReadonlyArray<
    keyof Extract<Event, { kind: K }>
  >;
};

// [LAW:effects-at-boundaries] Only contract field names, array indices and
// key positions appear in a divergence. Data keys can themselves be private.
const REPORTABLE_FIELDS = new Set([
  "kind",
  "failure",
  "message",
  "detail",
  "secondary",
  "stage",
  "diagnostics",
  "line",
  "level",
  "reply",
  "stats",
  "snapshot",
  "what",
  "effects",
  "frames",
  "frame",
  "bar",
  "receipt",
  "record",
  "stored",
  "store",
  "value",
  "subscriptions",
  "sources",
  "lanes",
  "configs",
  "managedFolders",
  "configSelections",
  "wake",
  "text",
  "rows",
  "runs",
  "request",
  "id",
  "target",
  "changes",
  "turnMs",
]);

const ENTRY_FIELDS = {
  boot: ["kind", "version", "wireVersion", "input", "result"],
  turn: ["kind", "input", "output"],
  end: ["kind", "turns"],
} as const;

function requireFields(
  entry: Record<string, unknown>,
  kind: keyof typeof ENTRY_FIELDS,
  line: number,
  extra: readonly string[] = [],
): void {
  const fields = [...ENTRY_FIELDS[kind], ...extra];
  if (
    Object.keys(entry).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(entry, field))
  )
    throw new Error(`recording line ${line} has invalid ${kind} fields`);
}

function lineEntry(raw: string, line: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`recording line ${line} is not JSON`);
  }
  if (!isPlainObject(value))
    throw new Error(`recording line ${line} must be an object`);
  return value;
}

function inputOf(
  recorded: unknown,
  line: number,
  wireVersion: number,
  // The ids of the presents the recording's turns returned so far.
  presents: ReadonlySet<unknown>,
): EventInput {
  if (
    !isPlainObject(recorded) ||
    recorded.kind !== "event" ||
    typeof recorded.at !== "number" ||
    !Number.isFinite(recorded.at) ||
    typeof recorded.tick !== "number" ||
    !Number.isFinite(recorded.tick) ||
    !isPlainObject(recorded.event) ||
    typeof recorded.event.kind !== "string" ||
    Object.keys(recorded).length !==
      4 +
        Number(wireVersion >= 34 && Object.hasOwn(recorded, "presentation")) +
        Number(wireVersion >= 36 && Object.hasOwn(recorded, "feedResumes"))
  ) {
    throw new Error(`recording line ${line} has an invalid renderer input`);
  }
  const value =
    wireVersion < SURFACE_WIRE
      ? surfaceInputOf(recorded, line, presents)
      : recorded;
  const { event } = value;
  if (!isPlainObject(event))
    throw new Error(`recording line ${line} has an invalid renderer event`);
  if (
    Object.hasOwn(value, "presentation") &&
    (!isPlainObject(value.presentation) ||
      !Number.isSafeInteger(value.presentation.order) ||
      Number(value.presentation.order) <= 0 ||
      !Array.isArray(value.presentation.sessions))
  )
    throw new Error(`recording line ${line} has an invalid presentation input`);
  if (
    Object.hasOwn(value, "feedResumes") &&
    ((event.kind !== "start" && event.kind !== "viewers") ||
      !validFeedResumes(value.feedResumes))
  )
    throw new Error(`recording line ${line} has an invalid feed handoff`);
  const fields = ownValue(EVENT_FIELDS, recorded.event.kind);
  if (
    fields === undefined ||
    fields.some((field) => !Object.hasOwn(event, field))
  )
    throw new Error(`recording line ${line} has an invalid renderer event`);
  if (event.kind === "click") {
    if (wireVersion < 33 && Object.hasOwn(event, "coldConfig"))
      event.coldConfig = { config: event.coldConfig };
    if (wireVersion === 22 && !Object.hasOwn(event, "placementSeed")) {
      // The historical click may have been refused before it needed an ID.
      // An empty seed fails only when the renderer actually mints a placement.
      event.placementSeed = "";
    } else if (
      typeof event.placementSeed !== "string" ||
      !event.placementSeed
    ) {
      throw new Error(
        `recording line ${line} has an invalid click placement seed`,
      );
    }
  }
  // The checked envelope holds the same payload taken by the private wire.
  return value as unknown as EventInput;
}

// Wire 37 keys every presentation fact, the animation clock included, by the
// surface a frame is shown on, draws each followed lane its own frame under
// the lane's turn, and records a delivery only when the host's verdict is
// `presented`. Older wires keyed presentation by drawer (`request`, `feed`),
// held one clock and one pointer per session, had no lane turns, and recorded
// every present that reached its client.
const SURFACE_WIRE = 37;

// [LAW:parse-dont-validate] The one upgrade of an older wire's input to wire
// 37: a new value, or a refusal naming the field it cannot map. A request's
// frame was the statusline's, drawn under the session's clock and effects;
// the feed's one frame was no single surface's, so it is dropped.
function surfaceInputOf(
  value: Record<string, unknown>,
  line: number,
  presents: ReadonlySet<unknown>,
): Record<string, unknown> {
  const refuse = (what: string): never => {
    throw new Error(
      `recording line ${line} has ${what} that wire ${SURFACE_WIRE} cannot read`,
    );
  };
  const object = (raw: unknown, what: string): Record<string, unknown> =>
    isPlainObject(raw) ? raw : refuse(what);
  // The session's one pointer named no surface, so no lane's frame is drawn
  // with it. An older wire minted no turns: every lane reads the one turn 0,
  // and the recording's outputs carry no frame that one would stamp.
  const seenOf = (raw: unknown) => {
    const { pointer: _sessionPointer, ...seen } = object(raw, "viewers");
    return {
      ...seen,
      lanes: Object.fromEntries(
        Object.entries(object(seen.lanes, "viewers")).map(([lane, viewers]) => [
          lane,
          { ...object(viewers, "viewers"), pointer: null, turn: 0 },
        ]),
      ),
    };
  };
  const viewersOf = (raw: unknown) =>
    Object.fromEntries(
      Object.entries(object(raw, "viewers")).map(([sid, seen]) => [
        sid,
        seenOf(seen),
      ]),
    );
  const resumeOf = (raw: unknown) => {
    const { surfaces, motion, ...resume } = object(
      raw,
      "a presentation resume",
    );
    const { request } = object(surfaces, "a presentation resume");
    const { placements, made, ...clock } = object(
      object(motion, "a presentation resume").value,
      "a presentation resume",
    );
    if (request === undefined) return { ...resume, surfaces: {} };
    const held = object(request, "a request presentation");
    if (placements === undefined || made === undefined)
      refuse("a request presentation");
    const drawn = object(held.value, "a request presentation");
    return {
      ...resume,
      surfaces: {
        statusline: {
          ...held,
          value: { ...drawn, clock, effects: { placements, made } },
        },
      },
    };
  };
  const event = object(value.event, "a renderer event");
  const click = isPlainObject(event.click) ? event.click : null;
  const outcome = isPlainObject(event.outcome) ? event.outcome : null;
  const upgraded: Record<string, unknown> = {
    ...event,
    ...(event.kind === "viewers" && { viewers: viewersOf(event.viewers) }),
    ...(event.kind === "start" && { viewers: viewersOf(event.viewers) }),
    ...(click !== null &&
      Array.isArray(click.steps) && {
        click: {
          ...click,
          steps: click.steps.map((step: unknown) => {
            if (
              !isPlainObject(step) ||
              step.verb !== VERB_COPY_DIAGNOSTIC ||
              !Array.isArray(step.args)
            )
              return step;
            if (step.args[1] === "feed")
              refuse("a copy click on a feed frame, which named no surface");
            return step.args[1] === "request"
              ? { ...step, args: step.args.with(1, "statusline") }
              : step;
          }),
        },
      }),
    // Every present that reached its client was recorded as shown.
    ...(event.kind === "effect-done" &&
      presents.has(event.of) &&
      outcome?.kind === "ok" && {
        outcome: { ...outcome, presentation: "presented" },
      }),
  };
  const { presentation, feedResumes } = value;
  return {
    ...value,
    event: upgraded,
    ...(presentation !== undefined && {
      presentation: (() => {
        const offered = object(presentation, "a presentation input");
        if (!Array.isArray(offered.sessions)) refuse("a presentation input");
        return {
          ...offered,
          sessions: (offered.sessions as unknown[]).map((raw) => {
            const {
              motion: _sessionMotion,
              bases,
              resume,
              ...offer
            } = object(raw, "a presentation offer");
            const { request } = object(bases, "a presentation offer");
            return {
              ...offer,
              bases: request === undefined ? {} : { statusline: request },
              ...(resume !== undefined && { resume: resumeOf(resume) }),
            };
          }),
        };
      })(),
    }),
    ...(feedResumes !== undefined && {
      feedResumes: (Array.isArray(feedResumes)
        ? feedResumes
        : refuse("a feed handoff")
      ).map((raw: unknown) => {
        const resume = object(raw, "a feed handoff");
        // A watched session never drawn hands off no history.
        if (resume.history === null) return resume;
        const { frame: _drawnForEveryLane, ...history } = object(
          resume.history,
          "a feed handoff",
        );
        return {
          ...resume,
          history: { ...history, viewers: seenOf(history.viewers), frames: {} },
        };
      }),
    }),
  };
}

// [LAW:one-source-of-truth] What an older wire's output and this one's are
// both compared by. An older draw noted which lanes the statusline handed the
// bar to, a fact this wire no longer has, and proposed its presentation as a
// surface and a session motion, each a change against its own base; this
// wire proposes one surface holding its clock. The frames, records and stored
// writes each turn produces are compared in full.
function withoutLegacyPresentation(output: unknown): unknown {
  if (!isPlainObject(output)) return output;
  const { record, effects } = output;
  return {
    ...output,
    ...(Array.isArray(record) && {
      record: record.filter(
        (field) => !(Array.isArray(field) && field[0] === "handoff"),
      ),
    }),
    ...(Array.isArray(effects) && {
      effects: effects.map((effect: unknown) => {
        if (!isPlainObject(effect) || effect.kind !== "present") return effect;
        const { proposal: _proposal, ...present } = effect;
        return present;
      }),
    }),
  };
}

// [LAW:one-source-of-truth] Compare what JSON actually carries, including
// omitted undefined properties and wire-frame nulls. Object key order is
// irrelevant. The order of an array and every recorded field are significant.
function firstDifference(
  expected: unknown,
  actual: unknown,
  at: string,
): string | undefined {
  if (expected === actual) return undefined;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i++) {
      const changed = firstDifference(expected[i], actual[i], `${at}[${i}]`);
      if (changed !== undefined) return changed;
    }
    return undefined;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [
      ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
    ].sort();
    for (const [i, key] of keys.entries()) {
      const path = REPORTABLE_FIELDS.has(key)
        ? `${at}.${key}`
        : `${at}[field ${i + 1}]`;
      if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key))
        return path;
      const changed = firstDifference(expected[key], actual[key], path);
      if (changed !== undefined) return changed;
    }
    return undefined;
  }
  return at;
}

function verify<T>(
  expected: unknown,
  actual: T,
  label: string,
  field: string,
  note = "",
  compareAs?: (output: T) => unknown,
): T {
  let value: unknown;
  try {
    value = JSON.parse(JSON.stringify(actual));
  } catch {
    throw new Error(`${label} could not be encoded as JSON`);
  }
  const changed = firstDifference(
    expected,
    compareAs ? compareAs(value as T) : value,
    field,
  );
  if (changed !== undefined)
    throw new Error(`${label} differs at ${changed}${note}`);
  // This detached copy was encoded from the typed production result.
  return value as T;
}

// [LAW:one-source-of-truth] Historical captures described each durable pick
// map in full. Reconstruct it from the boot and the actual changes alone;
// a wrong key, value, deletion or order must still show up in verification.
function historicalOutputs(
  stored: StoredState,
  wireVersion: number,
): (output: RendererOutput) => unknown {
  const histories = new Map(
    Object.entries(stored.history) as Array<[SessionId, SessionHistory]>,
  );
  const picks = new Map<SessionId, SessionPicks>();
  for (const [id, values] of Object.entries(stored.sessions)) {
    const kept = withoutRetiredKeys(values);
    if (kept.kind === "ok") picks.set(id as SessionId, kept.value.value);
  }
  return (output) => ({
    ...output,
    subscriptions:
      wireVersion >= 35
        ? output.subscriptions
        : {
            ...output.subscriptions,
            sources: Object.fromEntries(
              Object.entries(output.subscriptions.sources).map(
                ([sid, entries]) => [
                  sid,
                  entries.map((source) =>
                    source.kind === "run"
                      ? { kind: source.kind, run: source.run }
                      : source,
                  ),
                ],
              ),
            ),
          },
    effects: output.effects.map((effect) => {
      if (
        wireVersion >= 28 ||
        (effect.kind !== "change" && effect.kind !== "approve-repo")
      )
        return effect;
      const { onApplied: _hostDecision, ...historical } = effect;
      return historical;
    }),
    stored: output.stored.map((write) => {
      if (wireVersion >= 26) return write;
      if (
        write.store === "draft" ||
        write.store === "navigation" ||
        write.kind === "heard"
      )
        return write;
      if (write.store === "settings-history") {
        const next = historyAfterEdits(histories.get(write.key), write.edits);
        if (next === null) histories.delete(write.key);
        else histories.set(write.key, next);
        return {
          kind: "put",
          store: write.store,
          key: write.key,
          value: next && durableHistory(next),
        };
      }
      if (wireVersion >= 25) return write;
      const value = storedPicksAfter(picks.get(write.key), write);
      if (value === null) picks.delete(write.key);
      else picks.set(write.key, value);
      return { kind: "put", store: write.store, key: write.key, value };
    }),
  });
}

// Wires 22 and 23 included the locale and zone in their compile identity.
// Hash the actual compiler input in that spelling so cache and diagnostic
// comparisons still catch a different config. Drawing uses the restored facts.
function legacyCompileKey(input: CompileInput): string {
  const { locale, timeZone } = input.region;
  return sha256Text(JSON.stringify({ ...input, region: { locale, timeZone } }));
}

function constructionOf(entry: Record<string, unknown>): {
  readonly result: RecordedConstruction;
  readonly wireVersion: number;
  readonly sessionRevision: number;
  readonly renderer: SessionRenderer | null;
  readonly compareAs?: (output: RendererOutput) => unknown;
} {
  if (entry.version !== RECORDING_VERSION)
    throw new Error(
      `recording line 1 needs format version ${RECORDING_VERSION}`,
    );
  // Older recordings only carry a locale name. Recover its presentation at
  // the offline boundary. Whole-output verification still detects any drift.
  const wireVersion = entry.wireVersion;
  if (
    typeof wireVersion !== "number" ||
    !Number.isInteger(wireVersion) ||
    wireVersion < 22 ||
    wireVersion > RENDERER_WIRE_VERSION
  )
    throw new Error(
      `recording line 1 needs renderer wire version ${RENDERER_WIRE_VERSION}`,
    );
  const legacyRegion = wireVersion <= 23;
  let boot;
  try {
    let input = entry.input;
    if (wireVersion < 27 && isPlainObject(input))
      input = { ...input, sessionRevision: 0 };
    if (legacyRegion && isPlainObject(input) && isPlainObject(input.region)) {
      const { locale, timeZone } = input.region;
      if (typeof locale === "string" && typeof timeZone === "string")
        input = { ...input, region: regionFor(locale, timeZone) };
    }
    boot = rendererBootFrom({
      kind: "boot",
      wireVersion: RENDERER_WIRE_VERSION,
      boot: input,
    });
  } catch {
    throw new Error("recording line 1 has an invalid renderer boot input");
  }
  const built = mainRendererOf(
    boot,
    legacyRegion ? legacyCompileKey : undefined,
    wireVersion,
  );
  if (built.kind === "refused")
    return {
      result: built,
      wireVersion,
      renderer: null,
      sessionRevision: boot.sessionRevision,
    };
  const { renderer, ...result } = built;
  return {
    result,
    wireVersion,
    renderer,
    sessionRevision: boot.sessionRevision,
    compareAs:
      wireVersion === RENDERER_WIRE_VERSION
        ? undefined
        : wireVersion < SURFACE_WIRE
          ? (() => {
              const historical = historicalOutputs(boot.stored, wireVersion);
              return (output: RendererOutput) =>
                withoutLegacyPresentation(historical(output));
            })()
          : historicalOutputs(boot.stored, wireVersion),
  };
}

// [LAW:effects-at-boundaries] The caller supplies the lines and can inspect a
// verified turn. This function never reads a file or interprets an effect.
// [LAW:no-silent-failure] Only a matching terminal entry at EOF confirms the
// recording. A replayed prefix is not a successful replay.
export async function replayRecording(
  lines: AsyncIterable<string> | Iterable<string>,
  onTurn?: (input: EventInput, output: RendererOutput) => void,
): Promise<{ turns: number }> {
  let renderer: SessionRenderer | null = null;
  let sessionRevision: number | undefined;
  let wireVersion: number = RENDERER_WIRE_VERSION;
  let compareAs: ((output: RendererOutput) => unknown) | undefined;
  let ended = false;
  let line = 0;
  let turns = 0;
  const presents = new Set<unknown>();
  for await (const raw of lines) {
    line++;
    if (ended)
      throw new Error(`recording line ${line} follows the terminal entry`);
    const entry = lineEntry(raw, line);
    if (line === 1) {
      if (entry.kind !== "boot")
        throw new Error("recording line 1 must be a boot entry");
      requireFields(entry, "boot", line);
      const boot = constructionOf(entry);
      wireVersion = boot.wireVersion;
      sessionRevision = wireVersion >= 27 ? boot.sessionRevision : undefined;
      verify(entry.result, boot.result, "recording boot", "result");
      renderer = boot.renderer;
      compareAs = boot.compareAs;
    } else if (
      entry.kind === "session-commit" &&
      sessionRevision !== undefined &&
      renderer !== null
    ) {
      try {
        const commit = sessionCommitOf(entry);
        renderer.observe(commit);
        sessionRevision = commit.revision;
      } catch {
        throw new Error(
          `recording line ${line} has an invalid or out-of-order session commit`,
        );
      }
    } else if (entry.kind === "turn") {
      requireFields(entry, "turn", line);
      if (renderer === null)
        throw new Error(
          `recording line ${line} has a turn after refused construction`,
        );
      if (
        wireVersion < SURFACE_WIRE &&
        isPlainObject(entry.output) &&
        Array.isArray(entry.output.frames) &&
        entry.output.frames.length > 0
      )
        throw new Error(
          `recording line ${line} carries feed frames from wire ${wireVersion}, which drew one frame for every lane; wire ${SURFACE_WIRE} draws each lane its own frame, so replay cannot compare them`,
        );
      const input = inputOf(entry.input, line, wireVersion, presents);
      turns++;
      let actual: RendererOutput;
      try {
        actual = await renderer.answer(input);
      } catch (error) {
        // [LAW:no-silent-failure] The renderer's own error says which field
        // of the turn it could not draw from.
        throw new Error(
          `recording turn ${turns} was not answered: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const output = verify(
        wireVersion < SURFACE_WIRE
          ? withoutLegacyPresentation(entry.output)
          : entry.output,
        actual,
        `recording turn ${turns}`,
        "output",
        input.event.kind === "click" &&
          input.event.placementSeed === "" &&
          input.event.click?.scope === "session" &&
          Array.isArray(input.event.click.steps) &&
          input.event.click.steps.some(
            (step) =>
              step.kind === "session" &&
              step.verb === VERB_APPLY_LAYOUT_OP &&
              typeof step.args?.[2] === "string" &&
              decodeLayoutOp(step.args[2])?.op === "insert",
          )
          ? " (this historical insertion had no recorded placement seed)"
          : "",
        compareAs,
      );
      for (const effect of output.effects)
        if (effect.kind === "present") presents.add(effect.id);
      onTurn?.(input, output);
    } else if (entry.kind === "end") {
      requireFields(
        entry,
        "end",
        line,
        sessionRevision === undefined ? [] : ["sessionRevision"],
      );
      if (entry.sessionRevision !== sessionRevision)
        throw new Error(
          `recording line ${line} has the wrong terminal session revision (expected ${sessionRevision})`,
        );
      if (entry.turns !== turns)
        throw new Error(
          `recording line ${line} has the wrong terminal turn count (expected ${turns})`,
        );
      ended = true;
    } else {
      throw new Error(
        `recording line ${line} must be a turn or terminal entry`,
      );
    }
  }
  if (line === 0) throw new Error("recording has no boot entry");
  if (!ended) throw new Error("recording has no terminal entry");
  return { turns };
}
