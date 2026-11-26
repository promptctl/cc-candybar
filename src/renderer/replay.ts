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
import { ownValue } from "../utils/plain.js";
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

function inputOf(value: unknown, line: number): EventInput {
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
): T {
  let value: unknown;
  try {
    value = JSON.parse(JSON.stringify(actual));
  } catch {
    throw new Error(`${label} could not be encoded as JSON`);
  }
  const changed = firstDifference(expected, value, field);
  if (changed !== undefined) throw new Error(`${label} differs at ${changed}`);
  // This detached copy was encoded from the typed production result.
  return value as T;
}

function constructionOf(entry: Record<string, unknown>): {
  readonly result: RecordedConstruction;
  readonly renderer: Renderer | null;
} {
  if (entry.version !== RECORDING_VERSION)
    throw new Error(
      `recording line 1 needs format version ${RECORDING_VERSION}`,
    );
  if (entry.wireVersion !== RENDERER_WIRE_VERSION)
    throw new Error(
      `recording line 1 needs renderer wire version ${RENDERER_WIRE_VERSION}`,
    );
  let boot;
  try {
    boot = rendererBootFrom({
      kind: "boot",
      wireVersion: entry.wireVersion,
      boot: entry.input,
    });
  } catch {
    throw new Error("recording line 1 has an invalid renderer boot input");
  }
  const built = mainRendererOf(boot);
  if (built.kind === "refused") return { result: built, renderer: null };
  const { renderer, ...result } = built;
  return { result, renderer };
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
      verify(entry.result, boot.result, "recording boot", "result");
      renderer = boot.renderer;
    } else if (entry.kind === "turn") {
      requireFields(entry, "turn", line);
      if (renderer === null)
        throw new Error(
          `recording line ${line} has a turn after refused construction`,
        );
      const input = inputOf(entry.input, line);
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
