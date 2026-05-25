// [LAW:single-enforcer] One registry that maps click verb names to their
// handlers. Adding a new verb is one entry — no branching in handleClick,
// no scattered if/else in server.ts. The dispatcher does table lookup
// only; verb semantics live in the per-verb handler functions.
//
// [LAW:dataflow-not-control-flow] The verb is data, the lookup is data;
// the dispatcher runs the same operation every call (find handler, invoke
// it). Variability lives entirely in the verb-name argument and in the
// per-verb handler body — never in whether dispatch happens.
//
// [LAW:one-source-of-truth] The verb table is the single canonical list of
// click verbs in the daemon. Tests assert against this table directly so
// the live registry and the test enumeration cannot drift.
//
// Multi-arg verbs (set-state) carry their args as a single slash-delimited
// `value` string on the wire — keeping ClickRequest shape-stable at
// protocol v3 ({verb, value}). The per-verb handler parses its own value
// into the typed args it needs. URL format mirrors:
//   cc-candybar://<verb>/<value>   where <value> may itself contain `/`.

import { launchSync } from "../../proc/launch";
import type { SessionStateRW } from "../session-state";
import { STATE_KEYS, validateStateWrite } from "./state-validators";

export interface VerbContext {
  readonly sessionState: SessionStateRW;
  readonly dlog: (level: "info" | "warn" | "error", msg: string) => void;
}

// [LAW:types-are-the-program] The handler IS the contract — it takes the
// raw wire-level `value` string and the daemon's verb context; it returns
// nothing (clicks have no payload). User-facing failures throw an Error;
// the dispatcher in server.ts converts that to a RENDER_FAILED response.
// Invalid-shape inputs (e.g. missing required slash-delimited subfield)
// throw a BadVerbArgs error which the dispatcher surfaces as BAD_REQUEST.
export type VerbHandler = (value: string, ctx: VerbContext) => void;

// [LAW:types-are-the-program] Argument-shape failures are structurally
// distinct from operational failures. The dispatcher uses `instanceof` to
// route BadVerbArgs to BAD_REQUEST and any other Error to RENDER_FAILED.
export class BadVerbArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadVerbArgs";
  }
}

// ─── Argument decoders ───────────────────────────────────────────────────────

// [LAW:single-enforcer] One place that validates "this string is a usable
// session id." A session id has come from an untrusted URL; rejecting `/`
// and `..` keeps it usable as a key in the SessionState map and forbids
// path-traversal through any downstream code that ever joins it with fs
// paths (the legacy flag-file path, now removed, was the original reason).
function requireSessionId(value: string): string {
  if (!value) throw new BadVerbArgs("session id is required");
  if (value.includes("/") || value.includes(".."))
    throw new BadVerbArgs(`invalid session id "${value}"`);
  return value;
}

// [LAW:dataflow-not-control-flow] Split value on the FIRST `/` only.
// Session-bound multi-arg verbs encode as `<sessionId>/<rest>` where
// <rest> may itself contain `/`. Splitting once preserves the rest verbatim.
function splitSessionAndRest(value: string): {
  sessionId: string;
  rest: string;
} {
  const slash = value.indexOf("/");
  if (slash === -1) return { sessionId: value, rest: "" };
  return {
    sessionId: value.slice(0, slash),
    rest: value.slice(slash + 1),
  };
}

// ─── Verb handlers ───────────────────────────────────────────────────────────

const copy: VerbHandler = (text, ctx) => {
  const result = launchSync({
    bin: "/usr/bin/pbcopy",
    stdinInput: text,
    category: "click.pbcopy",
  });
  // [LAW:dataflow-not-control-flow] Rate-limit rejection is one outcome among
  // many — the click is acknowledged and the rejection is logged. Other
  // failures are genuine errors that surface as RENDER_FAILED.
  if (!result.ok) {
    if (result.reason === "rate-limited") {
      ctx.dlog("warn", `click.pbcopy rate-limited: ${result.error ?? ""}`);
      return;
    }
    throw new Error(
      `pbcopy failed (${result.reason}, exit ${result.exitCode ?? "null"})`,
    );
  }
};

const openVscode: VerbHandler = (target, ctx) => {
  const result = launchSync({
    bin: "/usr/bin/open",
    args: ["-a", "Visual Studio Code", target],
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

// Click on the ⚠ in the bar copies the parse error to clipboard. The value
// arrives already URL-decoded by parseHandlerUrl on the client; downstream
// treats it as a plain string.
const showConfigError: VerbHandler = (message, ctx) => copy(message, ctx);

// [LAW:one-source-of-truth] SessionState is the canonical store for
// toolbar-expanded state (eir merge). Toggle via set/clear; the file-backed
// storage owned by the daemon process persists the change automatically.
const toolbarToggle: VerbHandler = (value, ctx) => {
  const sessionId = requireSessionId(value);
  const expanded = ctx.sessionState.get(sessionId, "toolbar-expanded");
  if (expanded) ctx.sessionState.clear(sessionId, "toolbar-expanded");
  else ctx.sessionState.set(sessionId, "toolbar-expanded", "1");
};

// [LAW:single-enforcer] One verb writes SessionState — for every
// registered key. The per-key validator registry in ./state-validators.ts
// is the single place that decides what is a legal value for a given key;
// the body here is residue: split args, validate, write, log.
//
// [LAW:dataflow-not-control-flow] The key is data flowing across the
// boundary, not a discriminator that selects between verb handlers. A new
// state-writable key is a registry row, not a new verb.
//
// [LAW:types-are-the-program] The validator returns a discriminated
// `ValidateResult`. The body cannot fabricate a value (the `ok: true`
// branch's `value` is the only thing it may write) and cannot proceed on
// `ok: false` (it throws BadVerbArgs with the reason verbatim). The
// dispatcher in server.ts maps BadVerbArgs to BAD_REQUEST.
//
// Wire shape: cc-candybar://set-state/<sessionId>/<key>/<value>
//   where <value> may itself contain `/` (no further splitting; the
//   validator decides what's legal for the key).
const setState: VerbHandler = (rawValue, ctx) => {
  const { sessionId, rest: keyAndValue } = splitSessionAndRest(rawValue);
  const sid = requireSessionId(sessionId);
  if (!keyAndValue)
    throw new BadVerbArgs(
      `set-state: <key>/<value> is required (have keys: ${STATE_KEYS.join(", ")})`,
    );
  const slash = keyAndValue.indexOf("/");
  if (slash === -1)
    throw new BadVerbArgs(
      `set-state: missing value after key "${keyAndValue}" (expected <key>/<value>)`,
    );
  // [LAW:types-are-the-program] Each structurally distinct rejection
  // category gets its own diagnostic — an empty key (e.g. wire shape
  // `<sid>//<value>`) is a structural error (missing key segment), not a
  // semantic one (validator rejection of an unknown key). Routing it to
  // the unknown-key validator message ("unknown state key \"\"") would
  // mislead the operator about where their mistake was. Catch it here.
  if (slash === 0)
    throw new BadVerbArgs(
      `set-state: empty key (expected <sessionId>/<key>/<value>)`,
    );
  const key = keyAndValue.slice(0, slash);
  const incoming = keyAndValue.slice(slash + 1);
  const result = validateStateWrite(key, incoming);
  if (!result.ok) throw new BadVerbArgs(`set-state: ${result.reason}`);
  ctx.sessionState.set(sid, key, result.value);
  ctx.dlog("info", `set-state: ${key}=${result.value} (session=${sid})`);
};

// ─── Registry ───────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The verb table is THE list of supported click
// verbs. Order is alphabetical for diff-stability — the daemon does not
// care about order, but human readers do.
//
// [LAW:types-are-the-program] `ReadonlyMap` is the dispatch type whose
// lookup is `(verb) → VerbHandler | undefined` with no prototype chain.
// The wire-level `verb` field is untrusted input; a `__proto__` or
// `constructor` value over a plain object would be a truthy hit on
// Object.prototype that then throws on invocation (RENDER_FAILED instead
// of BAD_REQUEST). Map makes the wrong dispatch unrepresentable, matching
// the in-memory dispatching pattern in src/daemon/session-state.ts.
export const VERBS: ReadonlyMap<string, VerbHandler> = new Map<
  string,
  VerbHandler
>([
  ["copy", copy],
  ["open-vscode", openVscode],
  ["set-state", setState],
  ["show-config-error", showConfigError],
  ["toolbar-toggle", toolbarToggle],
]);

export const VERB_NAMES: readonly string[] = Object.freeze([
  ...VERBS.keys(),
]) as readonly string[];
