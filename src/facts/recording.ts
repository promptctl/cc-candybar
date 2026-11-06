// [LAW:parse-dont-validate] The one place a recording's text becomes typed
// lines. A recording is newline-delimited JSON, one `{ at, facts }` per line
// (docs/design/gather-and-renderer.md §14), written by a facts source's
// recorder and read back here. Everything past this unit holds `FactsLine`
// values and asks nothing of their shape again; a malformed or partial line
// throws naming its line number, as `parseFact` does for a fact.
//
// [LAW:one-way-deps] Pure over text and values: no file, no clock. Where the
// text comes from is the caller's edge.

import {
  BUILTIN_FACTS,
  FACTS_VERSION,
  type BuiltinFacts,
  type FactsDiagnostic,
  type SessionFacts,
  type SourceValue,
  type UpdateNotice,
} from "./session-facts";
import { FactParseError, parseFact, type Fact } from "./fact";
import type { Instant } from "../utils/instant";
import { isPlainObject } from "../utils/plain";
import { parseSessionId } from "../daemon/session-id";
import { REFRESH_LANES, type RefreshLane } from "../daemon/refresh-faults";

// One pushed document and the instant its stamp was taken at: what the player
// replays, and what the recorder writes.
export interface FactsLine {
  readonly at: Instant;
  readonly facts: SessionFacts;
}

const LANES: ReadonlySet<unknown> = new Set<RefreshLane>(REFRESH_LANES);

function parseDiagnostic(json: unknown, where: string): FactsDiagnostic {
  if (!isPlainObject(json)) throw new FactParseError(where, "is not an object");
  if (!LANES.has(json.lane)) {
    throw new FactParseError(where, `names lane ${String(json.lane)}`);
  }
  if (typeof json.reason !== "string") {
    throw new FactParseError(where, "has no reason");
  }
  return { lane: json.lane as RefreshLane, reason: json.reason };
}

// [LAW:types-are-the-program] A document off a wire or a recording, or a
// throw naming where it is wrong. Each fact crosses `parseFact`; what a fact's
// value is (a usage record, a git read) is the owner's shape carried as JSON,
// which the type names and this parser takes as read.
export function parseSessionFacts(json: unknown, where: string): SessionFacts {
  if (!isPlainObject(json)) throw new FactParseError(where, "is not an object");
  if (json.v !== FACTS_VERSION) {
    throw new FactParseError(
      where,
      `is facts version ${String(json.v)}, and this build reads ${FACTS_VERSION}`,
    );
  }
  const session = parseSessionId(json.session);
  if (!session.ok)
    throw new FactParseError(where, `session ${session.problem}`);
  if (typeof json.seq !== "number" || !Number.isInteger(json.seq)) {
    throw new FactParseError(where, "has no integer `seq`");
  }
  const builtinsJson = json.builtins;
  if (!isPlainObject(builtinsJson)) {
    throw new FactParseError(where, "has no `builtins`");
  }
  // [LAW:types-are-the-program] Each built-in's value is its owner's shape
  // carried as JSON, which the type names and this parser takes as read: the
  // one cast, here, is that claim.
  const builtins = Object.fromEntries(
    BUILTIN_FACTS.map((name) => [
      name,
      parseFact(builtinsJson[name], `${where} builtins.${name}`),
    ]),
  ) as unknown as BuiltinFacts;
  if (!isPlainObject(json.sources)) {
    throw new FactParseError(where, "has no `sources`");
  }
  const sources = Object.fromEntries(
    Object.entries(json.sources).map(([name, fact]) => [
      name,
      parseFact(fact, `${where} sources.${name}`) as Fact<SourceValue>,
    ]),
  );
  if (!Array.isArray(json.diagnostics)) {
    throw new FactParseError(where, "has no `diagnostics`");
  }
  return {
    v: FACTS_VERSION,
    session: session.id,
    seq: json.seq,
    builtins,
    sources,
    update: parseFact(json.update, `${where} update`) as Fact<UpdateNotice>,
    diagnostics: json.diagnostics.map((d, i) =>
      parseDiagnostic(d, `${where} diagnostics[${i}]`),
    ),
  };
}

// A recording's text as lines. Line numbers are 1-based, as an editor counts
// them; an empty line (the file's trailing newline) is no line.
export function parseRecording(text: string): FactsLine[] {
  return text
    .split("\n")
    .map((line, i) => [line, i + 1] as const)
    .filter(([line]) => line !== "")
    .map(([line, n]) => {
      const where = `line ${n}`;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (e) {
        throw new FactParseError(where, `is not JSON: ${String(e)}`);
      }
      if (!isPlainObject(json))
        throw new FactParseError(where, "is not an object");
      if (typeof json.at !== "number" || !Number.isFinite(json.at)) {
        throw new FactParseError(where, "has no finite `at`");
      }
      return {
        at: json.at as Instant,
        facts: parseSessionFacts(json.facts, `${where} facts`),
      };
    });
}

// A line as the recorder writes it: one JSON object, one newline.
export function formatLine(line: FactsLine): string {
  return `${JSON.stringify(line)}\n`;
}
