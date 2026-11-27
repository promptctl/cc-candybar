import type { Visit } from "../renderer-interface/navigation.js";
import { VERB_SET_STATE } from "../click/wire.js";
import type { SessionId } from "./foundations/session-id.js";
import type { DrawnEffect } from "../render/drawn-link.js";
import type { ConfigSnapshot } from "../config/config-snapshot.js";
import { HOVER_KEY, NO_HOVER } from "../config/click-mode.js";
import { DEFAULT_DSL_CONFIG } from "../config/default-dsl-config.js";
import { DIAGNOSTICS_CLOSED } from "../config/door.js";
import {
  FIRST_PAGE,
  menuOfKey,
  PAGE_HOLDING_CURRENT,
} from "../config/menu-keys.js";
import { entryOf, parseDocument } from "../config/json5-edit.js";
import { isPlainObject } from "../config/loader/validate-core.js";
import { synthesizeSettingsMenu } from "../config/settings-menu.js";
import { sessionKeyKind } from "../config/session-key.js";
import { makeStateKeyspace } from "./foundations/state-validators.js";
import type {
  Step,
  HistoryEdit,
} from "../renderer-interface/history-storage.js";
import type {
  ChangedPicks,
  StoreWrite,
} from "../renderer-interface/stored-state.js";
import type { WorldState } from "../facts/world-state.js";
import { configSessionDecision } from "../renderer-interface/interface.js";
import type { WireFrame } from "../render/frame.js";
import type {
  EventInput,
  RendererBoot,
  RendererOutput,
} from "../renderer-interface/interface.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import { validateHookData } from "../utils/schema-validator.js";
import { refusedHints } from "./foundations/protocol.js";
import { isEnvironmentOutput } from "./environment-output.js";

const SESSION_ENVIRONMENT =
  "a declared environment source supplied a value; record with that variable unset";
const ENVIRONMENT_OUTPUT =
  "a command returned data after receiving a session environment; record without that command output";
const ACTION_ENVIRONMENT =
  "a run action supplies environment values; record without its environment overlay";
const UNKNOWN_CONFIG =
  "config or plugin text could not be inspected for action environments; fix its syntax before recording";
const UNKNOWN_PROFILE =
  "saved renderer state contains values of unknown origin; record from a fresh daemon state directory";

// [LAW:effects-at-boundaries] Export permits the original bytes or refuses the
// capture. An environment reading can become arbitrary text in a frame,
// write or diagnostic, so deleting its field cannot produce a faithful replay.
function worldProblem({ env, runs, daemon }: WorldState): string | null {
  if (Object.values(env).some((fact) => fact.kind === "ok"))
    return SESSION_ENVIRONMENT;
  return Object.values(runs).some(isEnvironmentOutput) ||
    daemon.held.some(({ event }) => isEnvironmentOutput(event))
    ? ENVIRONMENT_OUTPUT
    : null;
}

// Hooks preserve client-supplied extensions. Explicit environment fields can
// be nested inside known hook fields, which are not projected by the checkpoint.
function hookCarriesEnvironment(hook: unknown): boolean {
  const remaining = [hook];
  while (remaining.length > 0) {
    const value = remaining.pop();
    if (Array.isArray(value)) {
      for (const item of value) remaining.push(item);
    } else if (isPlainObject(value)) {
      for (const [key, field] of Object.entries(value)) {
        if (key === "env" || key === "environment") return true;
        remaining.push(field);
      }
    }
  }
  return false;
}

function contextProblem(request: CheckedRenderRequest): string | null {
  // The host adds location after the live hook checkpoint.
  const { location: _location, ...hook } = request.hookData;
  if (
    validateHookData(hook).report.unknownTopLevelFields.length > 0 ||
    hookCarriesEnvironment(hook)
  )
    return "the client hook contains unrecognized data; record with a supported hook payload";
  // [LAW:one-source-of-truth] Only the existing hint checkpoint knows which
  // values were refused. The checked request preserves their raw bytes for
  // interactive diagnostics, unlike the parsed hints of an ordinary client.
  return refusedHints(request, request.hints).length > 0
    ? "the client supplied unparsed hints; record with a supported statusline client"
    : null;
}

// [LAW:parse-dont-validate] Check the source being saved, even if an action
// never draws or a later file replaces it. The document parser also refuses
// duplicate keys, whose overwritten values still occur in that source text.
function configTextProblem(text: string): string | null {
  try {
    const actions = entryOf(parseDocument(text), "actions")?.value;
    if (actions?.kind !== "object") return null;
    for (const { value } of actions.entries) {
      if (entryOf(value, "run") === undefined) continue;
      const env = entryOf(value, "env")?.value;
      if (
        env !== undefined &&
        env.kind !== "null" &&
        (env.kind !== "object" || env.entries.length > 0)
      )
        return ACTION_ENVIRONMENT;
    }
    return null;
  } catch {
    // The recording includes raw source bytes. A syntax error cannot prove
    // that those bytes are safe to export, and its parser error can quote them.
    return UNKNOWN_CONFIG;
  }
}

function configProblem({ chain, plugins }: ConfigSnapshot): string | null {
  for (const { content, listed } of chain) {
    if (content.kind === "text") {
      const problem = configTextProblem(content.text);
      if (problem !== null) return problem;
    }
    for (const { definition } of Object.values(listed)) {
      if (definition.kind !== "text") continue;
      const problem = configTextProblem(definition.text);
      if (problem !== null) return problem;
    }
  }
  for (const { definition } of plugins) {
    if (definition.kind !== "text") continue;
    const problem = configTextProblem(definition.text);
    if (problem !== null) return problem;
  }
  return null;
}

// [LAW:single-enforcer] Every input kind has one export disposition. The
// check reads the checked renderer input, never the host's environment book.
export function recordingInputProblem(
  { event }: EventInput,
  controls?: RecordingControls,
): string | null {
  switch (event.kind) {
    case "start":
      for (const { context, worldState } of event.sessions) {
        const problem = worldProblem(worldState) ?? contextProblem(context);
        if (problem !== null) return problem;
      }
      for (const { config, retained } of event.configs) {
        const problem =
          configProblem(config) ??
          (typeof retained === "object" ? configProblem(retained) : null);
        if (problem !== null) return problem;
      }
      return null;
    case "context":
      return worldProblem(event.worldState) ?? contextProblem(event.context);
    case "world-state":
      return worldProblem(event.worldState);
    case "effect-done":
      return isEnvironmentOutput(event.outcome) ? ENVIRONMENT_OUTPUT : null;
    case "config":
      return configProblem(event.config);
    case "request":
      return contextProblem(event.context);
    case "click": {
      const problem = event.coldConfig && configProblem(event.coldConfig);
      if (problem) return problem;
      const live = event.context?.live;
      const problemAtClick = live == null ? null : contextProblem(live);
      if (problemAtClick !== null || event.click.scope !== "session")
        return problemAtClick;
      const session = event.click.session;
      for (const step of event.click.steps) {
        if (step.kind !== "state-writes") continue;
        for (const write of step.writes) {
          if (write.verb !== VERB_SET_STATE) continue;
          const pairs = pickPairs(write.args);
          if (
            pairs === null ||
            pairs.some(
              ([key, value]) =>
                !knownPick(key, value) &&
                !controls?.offers(session, key, value),
            )
          )
            return UNKNOWN_PROFILE;
        }
      }
      return null;
    }
    case "stats":
    case "debug":
    case "close-journal":
    case "due":
    case "viewers":
      return null;
    case "close-views":
      controls?.clear();
      return null;
    case "retire":
      controls?.forget(event.session);
      return null;
  }
}

function pickPairs(args: readonly string[]): Array<[string, string]> | null {
  if (args.length === 0 || args.length % 2 !== 0) return null;
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i]!, args[i + 1]!]);
  return pairs;
}

function* frameEffects({ rows }: WireFrame): Generator<DrawnEffect> {
  for (const { runs } of rows)
    for (const { link } of runs) {
      if (typeof link !== "object" || link.kind !== "action") continue;
      yield* link.effects;
      if (link.region === undefined) continue;
      for (const effects of Object.values(link.region.gestures)) yield* effects;
      yield* link.region.hover ?? [];
    }
}

type RecordedSurface = "statusline" | "bar";
interface RecordedFrame {
  session: SessionId;
  surface: RecordedSurface;
  frame: WireFrame;
}

function* drawnFrames(output: RendererOutput): Generator<RecordedFrame> {
  for (const effect of output.effects)
    if (effect.kind === "present") yield effect;
  for (const { session, frame } of output.frames) {
    if (frame.kind !== "drawn") continue;
    yield { session, surface: "bar", frame: frame.bar };
    if (frame.handoff !== null)
      yield { session, surface: "statusline", frame: frame.handoff };
  }
}

// [LAW:no-ambient-temporal-coupling] A recording can identify an authored
// choice it has already exported in this session's controls. Keep the latest
// frame per surface. Boot and other sessions supply no such evidence.
export class RecordingControls {
  private readonly sessions = new Map<
    SessionId,
    Map<RecordedSurface, ReadonlySet<string>>
  >();

  offers(session: SessionId, key: string, value: string | null): boolean {
    const surfaces = this.sessions.get(session);
    if (surfaces === undefined || value === null) return false;
    const pair = JSON.stringify([key, value]);
    for (const pairs of surfaces.values()) if (pairs.has(pair)) return true;
    return false;
  }

  remember(
    { session, surface }: RecordedFrame,
    pairs: ReadonlySet<string>,
  ): void {
    const surfaces =
      this.sessions.get(session) ??
      new Map<RecordedSurface, ReadonlySet<string>>();
    if (pairs.size > 0) surfaces.set(surface, pairs);
    else surfaces.delete(surface);
    if (surfaces.size > 0) this.sessions.set(session, surfaces);
    else this.sessions.delete(session);
  }

  forget(session: SessionId): void {
    this.sessions.delete(session);
  }
  clear(): void {
    this.sessions.clear();
  }
}

// [LAW:effects-at-boundaries] The input and output are captured together.
// A new frame cannot vouch for a write in its own turn. Only a previously
// admitted control can establish the origin of an authored pair.
export function recordingOutputProblem(
  output: RendererOutput,
  controls?: RecordingControls,
): string | null {
  const frames = new Map<RecordedFrame, Set<string>>();
  for (const drawn of drawnFrames(output)) {
    const pairs = new Set<string>();
    for (const effect of frameEffects(drawn.frame)) {
      if ("kind" in effect) {
        if (Object.keys(effect.evaluated.env).length > 0)
          return ACTION_ENVIRONMENT;
      } else if (
        controls &&
        effect.verb === VERB_SET_STATE &&
        effect.args[0] === drawn.session
      ) {
        for (const [key, value] of pickPairs(effect.args.slice(1)) ?? []) {
          if (sessionKeyKind(key).kind === "plain")
            pairs.add(JSON.stringify([key, value]));
        }
      }
    }
    if (controls) frames.set(drawn, pairs);
  }
  const writesProblem = recordingWritesProblem(output.stored, controls);
  if (writesProblem !== null) return writesProblem;
  const decision = configSessionDecision(output.effects);
  if (decision !== undefined) {
    const problem = recordingWritesProblem(decision, controls);
    if (problem !== null) return problem;
  }
  for (const [drawn, pairs] of frames) controls?.remember(drawn, pairs);
  return null;
}

function visitProblem(
  visit: Visit,
  offered?: (key: string, value: string | null) => boolean,
): string | null {
  for (const { key, from, to } of visit) {
    // A drawn authored value proves the key's name. Only that value and
    // absence at the other end of its visit have known provenance.
    const publicValue = (value: string | null) =>
      knownPick(key, value) || offered?.(key, value) === true;
    if (
      from === to ||
      (from !== null && !publicValue(from)) ||
      (to !== null && !publicValue(to))
    )
      return UNKNOWN_PROFILE;
  }
  return null;
}

export function recordingWritesProblem(
  writes: readonly StoreWrite[],
  controls?: RecordingControls,
): string | null {
  for (const write of writes) {
    const problem =
      write.kind === "navigate" && write.edit.kind === "visit"
        ? visitProblem(
            write.edit.changes,
            (key, value) => controls?.offers(write.key, key, value) === true,
          )
        : write.kind === "patch"
          ? picksProblem(
              write.changes,
              (key, value) => controls?.offers(write.key, key, value) === true,
            )
          : write.kind === "steps"
            ? editsProblem(write.edits)
            : null;
    if (problem !== null) return problem;
  }
  return null;
}

// [LAW:one-source-of-truth] The bundled actions are a public vocabulary of
// concrete key/value pairs. A session's own config can add private names to
// that vocabulary, so it cannot establish what is safe to export at boot.
function bundledPickDomain() {
  const bundled = synthesizeSettingsMenu(DEFAULT_DSL_CONFIG);
  const gate = makeStateKeyspace().gateFor(bundled);
  const unrestricted = new Set(
    Object.values(bundled.actions).flatMap((action) =>
      "set" in action && "int" in action ? [action.set] : [],
    ),
  );
  const keys = new Set(gate.listKeys());
  return (key: string, value: string | null): boolean => {
    const { kind } = sessionKeyKind(key);
    if (kind === "plain" || kind === "record" || kind === "edit") return false;
    if (key === HOVER_KEY) return value === null || value === NO_HOVER;
    if (value === null) return keys.has(key);
    // An integer action accepts arbitrary strings of digits. Admit only the
    // fixed public markers of its owner. A newly introduced integer action
    // otherwise remains private until its recording domain is known.
    if (unrestricted.has(key)) {
      if (kind === "viewer") return value === DIAGNOSTICS_CLOSED;
      return (
        menuOfKey(key)?.page === true &&
        (value === FIRST_PAGE || value === PAGE_HOLDING_CURRENT)
      );
    }
    const result = gate.validate(key, value);
    return result.ok && result.value === value;
  };
}

// The recording vocabulary belongs to the immutable bundled config. Compute it
// on the first exported pick so daemons without recordings pay no setup cost.
let publicPick: ReturnType<typeof bundledPickDomain> | undefined;

function knownPick(key: string, value: string | null): boolean {
  return (publicPick ??= bundledPickDomain())(key, value);
}

function picksProblem(
  picks: ChangedPicks,
  offered?: (key: string, value: string | null) => boolean,
): string | null {
  return Object.entries(picks).every(
    ([key, value]) => knownPick(key, value) || offered?.(key, value),
  )
    ? null
    : UNKNOWN_PROFILE;
}

function stepsProblem(steps: readonly Step[]): string | null {
  for (const step of steps) {
    for (const change of step) {
      for (const value of [change.before, change.after]) {
        if (change.kind === "session") {
          if (!knownPick(change.key, value)) return UNKNOWN_PROFILE;
        } else if (value !== null) {
          const problem = configTextProblem(value);
          if (problem !== null)
            return `${problem} or use a fresh daemon state directory`;
        }
      }
      if (change.kind === "layer" && !isLayerDigest(change.digest))
        return UNKNOWN_PROFILE;
    }
  }
  return null;
}

// A layer target is the digest of its path. Unknown bytes in a field named
// digest are still bytes the capture would publish.
const isLayerDigest = (digest: string) => /^[0-9a-f]{64}$/.test(digest);

function editsProblem(edits: readonly HistoryEdit[]): string | null {
  for (const edit of edits) {
    if (edit.kind === "append") {
      const problem = stepsProblem([edit.step]);
      if (problem !== null) return problem;
    }
    if (
      edit.kind === "forget" &&
      edit.targets.some((target) =>
        target.kind === "session"
          ? !knownPick(target.key, null)
          : !isLayerDigest(target.digest),
      )
    )
      return UNKNOWN_PROFILE;
  }
  return null;
}

// [LAW:single-enforcer] Starting a capture and appending a turn inspect the
// same state, including names of erased picks and both sides of an undo.
export function recordingBootProblem({ stored }: RendererBoot): string | null {
  for (const timeline of Object.values(stored.navigation ?? {}))
    for (const visit of timeline.visits)
      if (visitProblem(visit) !== null) return UNKNOWN_PROFILE;
  for (const picks of Object.values(stored.sessions)) {
    const problem = picksProblem(picks);
    if (problem !== null) return problem;
  }
  for (const history of Object.values(stored.history)) {
    const problem = stepsProblem(history.past) ?? stepsProblem(history.future);
    if (problem !== null) return problem;
  }
  return null;
}
