import type { ConfigSnapshot } from "../config/config-snapshot.js";
import { DISCLOSURE_CLOSED, DISCLOSURE_OPEN } from "../config/disclosure.js";
import { GLOBAL_FIELDS } from "../config/globals-fields.js";
import { entryOf, parseDocument } from "../config/json5-edit.js";
import { isPlainObject } from "../config/loader/validate-core.js";
import { SUBMENU_NAMES, TABS } from "../config/menu-places.js";
import { isReservedName } from "../config/reserved-names.js";
import {
  SESSION_KEY_TO_SETTING,
  SETTINGS,
} from "../config/setting-projections.js";
import type { WorldState } from "../facts/world-state.js";
import type { WireFrame } from "../render/frame.js";
import type {
  EventInput,
  RendererBoot,
  RendererOutput,
} from "../renderer-interface/interface.js";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import { listResolvablePaletteNames } from "../themes/policy.js";
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
  "saved renderer state contains values of unknown origin; record from a fresh renderer profile";

// [LAW:effects-at-boundaries] Export permits the original bytes or refuses the
// capture. An environment reading can become arbitrary text in a frame,
// write or diagnostic, so deleting its field cannot produce a faithful replay.
function worldProblem({ env, runs, daemon }: WorldState): string | null {
  if (Object.values(env).some((fact) => fact.kind === "ok"))
    return SESSION_ENVIRONMENT;
  return Object.values(runs).some(isEnvironmentOutput) ||
    (daemon.daemonFailed !== null && isEnvironmentOutput(daemon.daemonFailed))
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
export function recordingInputProblem({ event }: EventInput): string | null {
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
      const live = event.context?.live;
      return live == null ? null : contextProblem(live);
    }
    case "stats":
    case "debug":
    case "close-journal":
    case "close-views":
    case "due":
    case "viewers":
    case "retire":
      return null;
  }
}

function frameHasActionEnvironment({ rows }: WireFrame): boolean {
  return rows.some(({ runs }) =>
    runs.some(
      ({ link }) =>
        typeof link === "object" &&
        link.kind === "action" &&
        link.effects.some(
          (effect) =>
            "kind" in effect && Object.keys(effect.evaluated.env).length > 0,
        ),
    ),
  );
}

// [LAW:one-source-of-truth] Both surfaces carry the same typed action links.
// The run's environment stays in the link at draw time. On click it is kept
// as host-only run evidence and is absent from the renderer's run request.
export function recordingOutputProblem(output: RendererOutput): string | null {
  return output.effects.some(
    (effect) =>
      effect.kind === "present" && frameHasActionEnvironment(effect.frame),
  ) ||
    output.frames.some(
      ({ frame }) =>
        frame.kind === "drawn" &&
        (frameHasActionEnvironment(frame.bar) ||
          (frame.handoff !== null && frameHasActionEnvironment(frame.handoff))),
    )
    ? ACTION_ENVIRONMENT
    : null;
}

// Saved session picks do not carry provenance. Admit existing built-in
// vocabulary, whose fields cannot disclose arbitrary historical text.
// [LAW:one-source-of-truth] Use the menu members and each builtin setting's
// own parser or closed domain instead of spelling their values again.
function knownPick(key: string, value: string): boolean {
  if (isReservedName(key)) {
    return (
      value === DISCLOSURE_CLOSED ||
      value === DISCLOSURE_OPEN ||
      TABS.some(({ member }) => member === value) ||
      SUBMENU_NAMES.some((member) => member === value)
    );
  }
  const setting = SESSION_KEY_TO_SETTING.get(key);
  if (setting === undefined) return false;
  const field = GLOBAL_FIELDS[SETTINGS[setting].configKey];
  if (field.kind === "session") return field.parse(value) !== null;
  const { domain } = field;
  if (typeof domain !== "object") return false;
  if ("themes" in domain) return listResolvablePaletteNames().includes(value);
  return (
    "from" in domain &&
    Array.isArray(domain.from) &&
    domain.from.includes(value)
  );
}

// [LAW:effects-at-boundaries] Refuse unproven historical values at export,
// when all their original text is still private. Replay needs the whole boot
// profile, including untouched sessions and both sides of history changes.
export function recordingBootProblem({ stored }: RendererBoot): string | null {
  for (const picks of Object.values(stored.sessions)) {
    if (!Object.entries(picks).every(([key, value]) => knownPick(key, value)))
      return UNKNOWN_PROFILE;
  }
  for (const { past, future } of Object.values(stored.history)) {
    for (const steps of [past, future]) {
      for (const step of steps) {
        for (const change of step) {
          for (const value of [change.before, change.after]) {
            if (value === null) continue;
            if (change.kind === "session") {
              if (!knownPick(change.key, value)) return UNKNOWN_PROFILE;
            } else {
              const problem = configTextProblem(value);
              if (problem !== null)
                return `${problem} or use a fresh renderer profile`;
            }
          }
        }
      }
    }
  }
  return null;
}
