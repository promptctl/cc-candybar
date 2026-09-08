// [LAW:single-enforcer] One registry mapping click verb names to handlers; the
// dispatcher does table lookup only, and a new verb is one entry.
// Multi-arg verbs carry their args as one slash-delimited `value` string, keeping
// ClickRequest shape-stable; each handler parses its own value.

import { launchSync } from "../../proc/launch";
import type { SessionStateRW } from "../session-state";
import {
  listStateKeys,
  rangeParamsFor,
  validateStateWrite,
} from "./state-validators";
import {
  listConfigKeys,
  rangeParamsForConfig,
  validateConfigWrite,
} from "./config-validators";
import {
  applyLayoutOp as applyLayoutOpToFile,
  deleteValue,
  readValue,
  redoEdit,
  undoEdit,
  writeValue,
  type EditStore,
} from "../config-file-store";
import { configEditHistoryPath } from "../paths";
import { durableConfigPath } from "../../config/loader/discovery";
import { decodeLayoutOp } from "../../config/layout-ops";
import {
  decodeSegments,
  parseEffects,
  VERB_APPLY_LAYOUT_OP,
  VERB_APPLY_UPDATE,
  VERB_COPY,
  VERB_DISPATCH,
  VERB_OPEN_VSCODE,
  VERB_LOAD_CONFIG,
  VERB_REDO,
  VERB_RESET_CONFIG,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_STEP_CONFIG,
  VERB_STEP_STATE,
  VERB_SHOW_CONFIG_ERROR,
  VERB_SHOW_CONFIG_WARNING,
  VERB_TOOLBAR_TOGGLE,
  VERB_UNDO,
  VERB_DOCTOR_RUN,
  VERB_DOCTOR_FIX,
} from "../../click/wire";
import { parseClientHints } from "../protocol";
import { checkByName, runDoctor, type DoctorFacts } from "../../doctor/checks";
import { doctorReportPairs } from "../../doctor/report";
import { applyFix, gatherFacts, type DoctorEdge } from "../../doctor/edge";

export interface VerbContext {
  readonly sessionState: SessionStateRW;
  readonly dlog: (level: "info" | "warn" | "error", msg: string) => void;
  // [LAW:effects-at-boundaries] The verb names the effect; the watch that knows
  // what is newer performs it.
  readonly applyUpdate: () => void;
  // [LAW:effects-at-boundaries] Handed in so the handlers stay a fold over pure verdicts.
  readonly doctor: DoctorEdge;
}

// [LAW:types-are-the-program] An operational failure throws Error (→ RENDER_FAILED);
// a bad argument shape throws BadVerbArgs (→ BAD_REQUEST).
export type VerbHandler = (value: string, ctx: VerbContext) => void;

import { BadVerbArgs } from "../verb-error";
export { BadVerbArgs };

// [LAW:single-enforcer] The id comes from an untrusted URL: rejecting `/` and `..` forbids path traversal downstream.
function requireSessionId(value: string): string {
  if (!value) throw new BadVerbArgs("session id is required");
  if (value.includes("/") || value.includes(".."))
    throw new BadVerbArgs(`invalid session id "${value}"`);
  return value;
}

// [LAW:types-are-the-program] The verb's arity picks the codec. A single-arg value
// legitimately contains "/", so this one must NOT split the way set-state does.
function oneArg(value: string): string {
  return decodeWire(() => decodeURIComponent(value));
}

// [LAW:single-enforcer] A URIError from a bad escape is an argument-shape failure, not an operational one.
function decodeWire<T>(decode: () => T): T {
  try {
    return decode();
  } catch (err) {
    if (err instanceof URIError)
      throw new BadVerbArgs(`malformed wire encoding: ${err.message}`);
    throw err;
  }
}

function pbcopy(text: string, ctx: VerbContext): void {
  const result = launchSync({
    bin: "/usr/bin/pbcopy",
    stdinInput: text,
    category: "click.pbcopy",
  });
  // [LAW:dataflow-not-control-flow] A rate-limit rejection is acknowledged and logged, not an error.
  if (!result.ok) {
    if (result.reason === "rate-limited") {
      ctx.dlog("warn", `click.pbcopy rate-limited: ${result.error ?? ""}`);
      return;
    }
    throw new Error(
      `pbcopy failed (${result.reason}, exit ${result.exitCode ?? "null"})`,
    );
  }
}

const copy: VerbHandler = (value, ctx) => pbcopy(oneArg(value), ctx);

const openVscode: VerbHandler = (value, ctx) => {
  const result = launchSync({
    bin: "/usr/bin/open",
    args: ["-a", "Visual Studio Code", oneArg(value)],
    category: "click.open",
  });
  if (!result.ok) {
    if (result.reason === "rate-limited") {
      ctx.dlog("warn", `click.open rate-limited: ${result.error ?? ""}`);
      return;
    }
    throw new Error(
      `open -a "Visual Studio Code" failed (${result.reason}, exit ${result.exitCode ?? "null"})`,
    );
  }
};

const showConfigError: VerbHandler = (value, ctx) => pbcopy(oneArg(value), ctx);

// [LAW:one-type-per-behavior] Same click behavior, but advisory and fatal diagnostics stay distinct channels through the render pipeline.
const showConfigWarning: VerbHandler = (value, ctx) =>
  pbcopy(oneArg(value), ctx);

const toolbarToggle: VerbHandler = (value, ctx) => {
  const sessionId = requireSessionId(oneArg(value));
  const expanded = ctx.sessionState.get(sessionId, "toolbar-expanded");
  if (expanded) ctx.sessionState.clear(sessionId, "toolbar-expanded");
  else ctx.sessionState.set(sessionId, "toolbar-expanded", "1");
};

// [LAW:single-enforcer] One verb writes SessionState, for every registered key and
// every pair in a batch; ./state-validators.ts alone decides what is legal.
// [LAW:no-silent-fallbacks] Every pair is validated BEFORE any write: one click is
// one transactional intent, so a half-applied batch is unrepresentable.
// Value shape: the percent-encoded segment run <sessionId>/<k1>/<v1>[/<k2>/<v2>…].
const setState: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", ...rest] = decodeWire(() => decodeSegments(rawValue));
  const sid = requireSessionId(sessionId);
  if (rest.length === 0)
    throw new BadVerbArgs(
      `set-state: <key>/<value> is required (have keys: ${listStateKeys().join(", ")})`,
    );
  if (rest.length % 2 !== 0) {
    throw new BadVerbArgs(
      `set-state: expected even-count <key>/<value> pairs, got ${rest.length} ` +
        `segment(s) after session id (have keys: ${listStateKeys().join(", ")})`,
    );
  }
  const validated: Array<{ key: string; value: string }> = [];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!;
    const incoming = rest[i + 1]!;
    // [LAW:types-are-the-program] A missing segment is a structural error; the unknown-key message would misdirect.
    if (!key) {
      throw new BadVerbArgs(
        `set-state: empty key at pair ${i / 2 + 1} ` +
          `(expected <sessionId>/<key>/<value>[/<key>/<value>...] segments)`,
      );
    }
    const result = validateStateWrite(key, incoming);
    if (!result.ok) {
      throw new BadVerbArgs(`set-state: pair ${i / 2 + 1}: ${result.reason}`);
    }
    validated.push({ key, value: result.value });
  }
  // [LAW:single-enforcer] setBatch owns reactive atomicity: every pair lands before observers fire.
  ctx.sessionState.setBatch(sid, validated);
  const summary = validated.map((p) => `${p.key}=${p.value}`).join(" ");
  ctx.dlog("info", `set-state: ${summary} (session=${sid})`);
};

const STEP_INT_RE = /^-?\d+$/;

// Wrap is navigation and lives here; the range gate still owns the [min,max] clamp.
function wrapStep(n: number, min: number, max: number): number {
  return n > max ? min : n < min ? max : n;
}

// [LAW:no-ambient-temporal-coupling] The RELEASE half of a durable write, run by the
// handler AFTER its own write succeeded. As a separate effect the dispatcher would
// clear the session pick even when the persist failed — a lost update. The key is
// checked BEFORE the write and cleared AFTER it, an order one handler owns.
// Gated by key MEMBERSHIP: there is no value to validate, only a target to clear.
function parseRelease(release: string, verb: string): string | null {
  if (!release) return null;
  if (!listStateKeys().includes(release)) {
    throw new BadVerbArgs(
      `${verb}: unknown session key "${release}" to release (have: ${listStateKeys().join(", ")})`,
    );
  }
  return release;
}

function releaseSessionKey(
  release: string | null,
  sid: string,
  ctx: VerbContext,
  verb: string,
): void {
  if (release === null) return;
  ctx.sessionState.clear(sid, release);
  ctx.dlog("info", `${verb}: released session key ${release} (session=${sid})`);
}

// [LAW:one-source-of-truth] The link carries only `[sessionId, key, by]` and no
// `current` snapshot, so N rapid clicks each re-read live state and accumulate.
const stepState: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", byRaw = ""] = decodeWire(() =>
    decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  if (!key) {
    throw new BadVerbArgs(
      "step-state: <key> is required (shape: <sessionId>/<key>/<by>)",
    );
  }
  if (!STEP_INT_RE.test(byRaw)) {
    throw new BadVerbArgs(
      `step-state: delta must be an integer, got "${byRaw}"`,
    );
  }
  const by = parseInt(byRaw, 10);
  const params = rangeParamsFor(key);
  if (!params) {
    throw new BadVerbArgs(
      `step-state: key "${key}" is not a bounded (range) state key ` +
        `(have keys: ${listStateKeys().join(", ")})`,
    );
  }
  // [LAW:no-defensive-null-guards] "unset" is a real state, seeded from the configured default.
  const stored = ctx.sessionState.get(sid, key);
  const current =
    stored && STEP_INT_RE.test(stored)
      ? Math.max(params.min, Math.min(params.max, parseInt(stored, 10)))
      : params.seed;
  const next = wrapStep(current + by, params.min, params.max);
  const result = validateStateWrite(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-state: ${result.reason}`);
  ctx.sessionState.set(sid, key, result.value);
  ctx.dlog(
    "info",
    `step-state: ${key} ${current}→${result.value} (by ${by}, session=${sid})`,
  );
};

// [LAW:one-source-of-truth] The render records the INPUTS its config resolution ran
// on, and a durable verb re-runs that resolution at click time, so the write lands in
// the file the NEXT reload reads. A recorded resolved path would be a second clock,
// and the daemon's own cwd describes only whichever shell spawned it.
export const SESSION_RENDER_ORIGIN_KEY = "render-origin";

export interface RenderOrigin {
  readonly projectDir: string;
  readonly cwd: string;
  readonly configFile: string | null;
}

export function encodeRenderOrigin(origin: RenderOrigin): string {
  return JSON.stringify(origin);
}

function parseRenderOrigin(raw: string): RenderOrigin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadVerbArgs(`render origin is not JSON: ${raw}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BadVerbArgs(`render origin is not an object: ${raw}`);
  }
  const { projectDir, cwd, configFile } = parsed as Record<string, unknown>;
  if (
    typeof projectDir !== "string" ||
    typeof cwd !== "string" ||
    (configFile !== null && typeof configFile !== "string")
  ) {
    throw new BadVerbArgs(`render origin has the wrong shape: ${raw}`);
  }
  return { projectDir, cwd, configFile };
}

// [LAW:no-silent-failure] No origin means no file to write, not the daemon's own XDG guess.
function sessionConfigFile(ctx: VerbContext, sid: string): string {
  const raw = ctx.sessionState.get(sid, SESSION_RENDER_ORIGIN_KEY);
  if (raw === null) {
    throw new BadVerbArgs(
      `session ${sid} has not rendered yet — no config file to write`,
    );
  }
  const origin = parseRenderOrigin(raw);
  return durableConfigPath(
    origin.projectDir,
    origin.cwd,
    origin.configFile ?? undefined,
  );
}

function editStore(ctx: VerbContext): EditStore {
  return { historyPath: configEditHistoryPath(), logger: ctx.dlog };
}

// [LAW:single-enforcer] `persist`'s twin of setState, writing the session's config
// file: a watcher picks it up exactly as it would a hand edit, indistinguishably.
const setConfig: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", incoming = "", release = ""] = decodeWire(
    () => decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  if (!key) {
    throw new BadVerbArgs(
      `set-config: <key>/<value> is required (have keys: ${listConfigKeys().join(", ")})`,
    );
  }
  const result = validateConfigWrite(key, incoming);
  if (!result.ok) throw new BadVerbArgs(`set-config: ${result.reason}`);
  const releaseKey = parseRelease(release, "set-config");
  const file = sessionConfigFile(ctx, sid);
  writeValue(editStore(ctx), file, key, result.value);
  ctx.dlog(
    "info",
    `set-config: ${key}=${result.value} → ${file} (session=${sid})`,
  );
  releaseSessionKey(releaseKey, sid, ctx, "set-config");
};

const stepConfig: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", byRaw = "", release = ""] = decodeWire(() =>
    decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  if (!key) {
    throw new BadVerbArgs(
      "step-config: <key> is required (shape: <sessionId>/<key>/<by>)",
    );
  }
  if (!STEP_INT_RE.test(byRaw)) {
    throw new BadVerbArgs(
      `step-config: delta must be an integer, got "${byRaw}"`,
    );
  }
  const by = parseInt(byRaw, 10);
  const releaseKey = parseRelease(release, "step-config");
  const params = rangeParamsForConfig(key);
  if (!params) {
    throw new BadVerbArgs(
      `step-config: key "${key}" is not a bounded (range) config key ` +
        `(have keys: ${listConfigKeys().join(", ")})`,
    );
  }
  const file = sessionConfigFile(ctx, sid);
  const stored = readValue(file, key);
  const current =
    typeof stored === "number"
      ? Math.max(params.min, Math.min(params.max, stored))
      : params.seed;
  const next = wrapStep(current + by, params.min, params.max);
  const result = validateConfigWrite(key, String(next));
  if (!result.ok) throw new BadVerbArgs(`step-config: ${result.reason}`);
  writeValue(editStore(ctx), file, key, result.value);
  ctx.dlog(
    "info",
    `step-config: ${key} ${current}→${result.value} (by ${by}) → ${file} (session=${sid})`,
  );
  releaseSessionKey(releaseKey, sid, ctx, "step-config");
};

const resetConfig: VerbHandler = (value, ctx) => {
  const [sessionId = "", key = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  if (!key || !listConfigKeys().includes(key)) {
    throw new BadVerbArgs(
      `reset-config: unknown config key "${key}" (have: ${listConfigKeys().join(", ")})`,
    );
  }
  const file = sessionConfigFile(ctx, sid);
  deleteValue(editStore(ctx), file, key);
  ctx.dlog("info", `reset-config: ${key} ← ${file} (session=${sid})`);
};

// [LAW:parse-dont-validate] The gate proves the VALUE is one an action allows,
// decodeLayoutOp stamps its shape, and the store proves the KEY is a preset-root
// target — a globals or segment-palette key smuggled through here is refused there.
const applyLayoutOp: VerbHandler = (rawValue, ctx) => {
  const [sessionId = "", key = "", opToken = ""] = decodeWire(() =>
    decodeSegments(rawValue),
  );
  const sid = requireSessionId(sessionId);
  if (!key) {
    throw new BadVerbArgs(
      `apply-layout-op: <key>/<op> is required (have: ${listConfigKeys().join(", ")})`,
    );
  }
  const result = validateConfigWrite(key, opToken);
  if (!result.ok) throw new BadVerbArgs(`apply-layout-op: ${result.reason}`);
  const op = decodeLayoutOp(result.value);
  if (op === null) {
    throw new BadVerbArgs(
      `apply-layout-op: "${result.value}" is not a layout op token`,
    );
  }
  const file = sessionConfigFile(ctx, sid);
  applyLayoutOpToFile(editStore(ctx), file, key, op);
  ctx.dlog(
    "info",
    `apply-layout-op: ${key} ${result.value} → ${file} (session=${sid})`,
  );
};

// Steps the history of the file the session's render resolved, so one project's undo
// cannot revert another's write. [LAW:no-silent-failure] An empty stack is loud.
const undoConfig: VerbHandler = (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const file = sessionConfigFile(ctx, sid);
  if (undoEdit(editStore(ctx), file) === null) {
    throw new BadVerbArgs("undo: history is empty, nothing to undo");
  }
  ctx.dlog("info", `undo: ${file} (session=${sid})`);
};

const redoConfig: VerbHandler = (value, ctx) => {
  const [sessionId = ""] = decodeWire(() => decodeSegments(value));
  const sid = requireSessionId(sessionId);
  const file = sessionConfigFile(ctx, sid);
  if (redoEdit(editStore(ctx), file) === null) {
    throw new BadVerbArgs("redo: nothing to redo");
  }
  ctx.dlog("info", `redo: ${file} (session=${sid})`);
};

// [LAW:effects-at-boundaries] The daemon's update watch decides what to run, so no command or version ever arrives from a URL.
const applyUpdate: VerbHandler = (value, ctx) => {
  requireSessionId(oneArg(value));
  ctx.applyUpdate();
};

// [LAW:one-source-of-truth] A click carries no hints, so the doctor reasons over the
// session's last render, read back through the SAME checkpoint the live frame crossed.
export const SESSION_CLIENT_HINTS_KEY = "client-hints";

function sessionHints(
  ctx: VerbContext,
  sid: string,
): ReturnType<typeof parseClientHints> {
  const raw = ctx.sessionState.get(sid, SESSION_CLIENT_HINTS_KEY);
  if (raw === null) {
    throw new BadVerbArgs(
      `session ${sid} has not rendered yet — no client facts to diagnose`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadVerbArgs(`client hints record is not JSON: ${raw}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new BadVerbArgs(`client hints record is not an object: ${raw}`);
  }
  return parseClientHints(parsed as Record<string, unknown>);
}

function writeReport(ctx: VerbContext, sid: string, facts: DoctorFacts): void {
  const reports = runDoctor(facts);
  ctx.sessionState.setBatch(sid, doctorReportPairs(reports));
  ctx.dlog(
    "info",
    `doctor: ${reports.map((r) => `${r.check.name}=${r.verdict.ok ? "ok" : "failed"}`).join(" ")} (session=${sid})`,
  );
}

const doctorRun: VerbHandler = (value, ctx) => {
  const sid = requireSessionId(oneArg(value));
  writeReport(ctx, sid, gatherFacts(ctx.doctor, sessionHints(ctx, sid).tmux));
};

// Re-probe at click time rather than trust the verdict the `[fix]` was drawn from,
// then re-run over the post-fix facts so the row flips to the truthful reason.
const doctorFix: VerbHandler = (value, ctx) => {
  const [sessionId = "", checkName = ""] = decodeWire(() =>
    decodeSegments(value),
  );
  const sid = requireSessionId(sessionId);
  const check = checkByName(checkName);
  if (check === undefined) {
    throw new BadVerbArgs(`doctor-fix: unknown check "${checkName}"`);
  }
  const facts = gatherFacts(ctx.doctor, sessionHints(ctx, sid).tmux);
  const verdict = check.probe(facts);
  if (verdict.ok || verdict.fix === undefined) {
    throw new BadVerbArgs(
      `doctor-fix: ${check.label} — ${verdict.ok ? "nothing to fix" : verdict.reason}`,
    );
  }
  const after = applyFix(ctx.doctor, verdict.fix, facts);
  ctx.dlog(
    "info",
    `doctor-fix: ${check.name} → ${verdict.fix.kind} ${verdict.fix.name}=${verdict.fix.value} (session=${sid})`,
  );
  writeReport(ctx, sid, after);
};

// [LAW:one-source-of-truth] The LEAF verbs. `dispatch` is NOT here: it folds an
// effect list back through THIS map, so nesting is structurally impossible.
// [LAW:types-are-the-program] A Map, not an object: the untrusted wire `verb` could
// otherwise be a truthy `__proto__` hit on Object.prototype.
// Wire value `<sessionId>/<path>`, split at the FIRST slash — the session id is
// slash-free and the path is not. An empty path clears the override.
export const SESSION_CONFIG_OVERRIDE_KEY = "config-override";
const loadConfig: VerbHandler = (value, ctx) => {
  const slash = value.indexOf("/");
  if (slash === -1) {
    throw new BadVerbArgs(
      "load-config: expected <sessionId>/<path> (missing separator)",
    );
  }
  const sid = requireSessionId(
    decodeWire(() => decodeURIComponent(value.slice(0, slash))),
  );
  const p = decodeWire(() => decodeURIComponent(value.slice(slash + 1))).trim();
  if (p !== "") {
    if (!p.startsWith("/")) {
      throw new BadVerbArgs(`load-config: path must be absolute, got "${p}"`);
    }
    if (!/\.(json5?|json)$/.test(p)) {
      throw new BadVerbArgs(
        `load-config: path must end with .json5 or .json, got "${p}"`,
      );
    }
  }
  if (p === "") {
    ctx.sessionState.clear(sid, SESSION_CONFIG_OVERRIDE_KEY);
    ctx.dlog("info", `load-config: override cleared (session=${sid})`);
  } else {
    ctx.sessionState.set(sid, SESSION_CONFIG_OVERRIDE_KEY, p);
    ctx.dlog("info", `load-config: ${p} (session=${sid})`);
  }
};

const LEAF_VERBS = new Map<string, VerbHandler>([
  [VERB_COPY, copy],
  [VERB_LOAD_CONFIG, loadConfig],
  [VERB_OPEN_VSCODE, openVscode],
  [VERB_SET_STATE, setState],
  [VERB_STEP_STATE, stepState],
  [VERB_SET_CONFIG, setConfig],
  [VERB_STEP_CONFIG, stepConfig],
  [VERB_RESET_CONFIG, resetConfig],
  [VERB_APPLY_LAYOUT_OP, applyLayoutOp],
  [VERB_UNDO, undoConfig],
  [VERB_REDO, redoConfig],
  [VERB_SHOW_CONFIG_ERROR, showConfigError],
  [VERB_SHOW_CONFIG_WARNING, showConfigWarning],
  [VERB_TOOLBAR_TOGGLE, toolbarToggle],
  [VERB_APPLY_UPDATE, applyUpdate],
  [VERB_DOCTOR_RUN, doctorRun],
  [VERB_DOCTOR_FIX, doctorFix],
]);

// [LAW:one-source-of-truth] Membership is the fact `dispatch` reads to know which session a failing click surfaces its error in.
const SESSION_FIRST_VERBS: ReadonlySet<string> = new Set([
  VERB_SET_STATE,
  VERB_STEP_STATE,
  VERB_SET_CONFIG,
  VERB_STEP_CONFIG,
  VERB_RESET_CONFIG,
  VERB_APPLY_LAYOUT_OP,
  VERB_UNDO,
  VERB_REDO,
  VERB_TOOLBAR_TOGGLE,
  VERB_APPLY_UPDATE,
  VERB_DOCTOR_RUN,
  VERB_DOCTOR_FIX,
]);

// [LAW:no-silent-fallbacks] EVERY effect runs even if an earlier one failed, and
// failures accumulate. [LAW:types-are-the-program] The aggregate preserves the
// input-vs-operational classification: any operational failure makes the whole
// click operational; an unknown verb is bad input and does not flip it.
const dispatch: VerbHandler = (rawValue, ctx) => {
  const errors: string[] = [];
  let operational = false;
  let sessionId: string | null = null;
  for (const { verb, value } of parseEffects(rawValue)) {
    if (!sessionId && SESSION_FIRST_VERBS.has(verb)) {
      const parts = decodeSegments(value);
      if (parts.length > 0 && parts[0]) sessionId = parts[0];
    }
    const handler = LEAF_VERBS.get(verb);
    if (!handler) {
      errors.push(`unknown effect verb "${verb}"`);
      continue;
    }
    try {
      handler(value, ctx);
    } catch (e) {
      if (!(e instanceof BadVerbArgs)) operational = true;
      errors.push(`${verb}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (errors.length > 0) {
    if (sessionId) {
      ctx.sessionState.set(sessionId, "click.error", errors.join("\n"));
    }
    const message = `dispatch: ${errors.join("; ")}`;
    throw operational ? new Error(message) : new BadVerbArgs(message);
  }
};

export const VERBS: ReadonlyMap<string, VerbHandler> = new Map<
  string,
  VerbHandler
>([...LEAF_VERBS, [VERB_DISPATCH, dispatch]]);

export const VERB_NAMES: readonly string[] = Object.freeze([
  ...VERBS.keys(),
]) as readonly string[];
