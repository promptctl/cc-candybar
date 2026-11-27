import {
  historyAfterEdits,
  durableHistory,
  type SessionHistory,
} from "../renderer-interface/history-storage.js";
import { VERB_APPLY_LAYOUT_OP } from "../click/wire.js";
import { decodeLayoutOp } from "../config/layout-ops.js";
import { isPlainObject } from "../config/loader/validate-core.js";
import type {
  Event,
  EventInput,
  Renderer,
  RendererOutput,
} from "../renderer-interface/interface.js";
import {
  RECORDING_VERSION,
  type RecordedConstruction,
} from "../renderer-interface/recording.js";
import {
  rendererBootFrom,
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
  "handoff",
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
): void {
  const fields = ENTRY_FIELDS[kind];
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
  value: unknown,
  line: number,
  historical: boolean,
): EventInput {
  if (
    !isPlainObject(value) ||
    value.kind !== "event" ||
    typeof value.at !== "number" ||
    !Number.isFinite(value.at) ||
    typeof value.tick !== "number" ||
    !Number.isFinite(value.tick) ||
    !isPlainObject(value.event) ||
    typeof value.event.kind !== "string" ||
    Object.keys(value).length !== 4
  ) {
    throw new Error(`recording line ${line} has an invalid renderer input`);
  }
  const { event } = value;
  const fields = ownValue(EVENT_FIELDS, value.event.kind);
  if (
    fields === undefined ||
    fields.some((field) => !Object.hasOwn(event, field))
  )
    throw new Error(`recording line ${line} has an invalid renderer event`);
  if (event.kind === "click") {
    if (historical && !Object.hasOwn(event, "placementSeed")) {
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
  fullPicks: boolean,
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
    stored: output.stored.map((write) => {
      if (write.kind === "heard") return write;
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
      if (!fullPicks) return write;
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
  readonly renderer: Renderer | null;
  readonly compareAs?: (output: RendererOutput) => unknown;
} {
  if (entry.version !== RECORDING_VERSION)
    throw new Error(
      `recording line 1 needs format version ${RECORDING_VERSION}`,
    );
  // Older recordings only carry a locale name. Recover its presentation at
  // the offline boundary. Whole-output verification still detects any drift.
  const legacyRegion = entry.wireVersion === 22 || entry.wireVersion === 23;
  if (
    !legacyRegion &&
    entry.wireVersion !== 24 &&
    entry.wireVersion !== 25 &&
    entry.wireVersion !== RENDERER_WIRE_VERSION
  )
    throw new Error(
      `recording line 1 needs renderer wire version ${RENDERER_WIRE_VERSION}`,
    );
  let boot;
  try {
    let input = entry.input;
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
  );
  if (built.kind === "refused") return { result: built, renderer: null };
  const { renderer, ...result } = built;
  return {
    result,
    renderer,
    compareAs:
      entry.wireVersion === RENDERER_WIRE_VERSION
        ? undefined
        : historicalOutputs(boot.stored, entry.wireVersion !== 25),
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
  let renderer: Renderer | null = null;
  let historical = false;
  let compareAs: ((output: RendererOutput) => unknown) | undefined;
  let ended = false;
  let line = 0;
  let turns = 0;
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
      historical = entry.wireVersion === 22;
      verify(entry.result, boot.result, "recording boot", "result");
      renderer = boot.renderer;
      compareAs = boot.compareAs;
    } else if (entry.kind === "turn") {
      requireFields(entry, "turn", line);
      if (renderer === null)
        throw new Error(
          `recording line ${line} has a turn after refused construction`,
        );
      const input = inputOf(entry.input, line, historical);
      turns++;
      let actual: RendererOutput;
      try {
        actual = await renderer.answer(input);
      } catch {
        throw new Error(`recording turn ${turns} was not answered`);
      }
      const output = verify(
        entry.output,
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
      onTurn?.(input, output);
    } else if (entry.kind === "end") {
      requireFields(entry, "end", line);
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
