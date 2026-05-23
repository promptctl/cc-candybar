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
// Multi-arg verbs (set-theme, set-style) carry their args as a single
// slash-delimited `value` string on the wire — keeping ClickRequest
// shape-stable at protocol v3 ({verb, value}). The per-verb handler
// parses its own value into the typed args it needs. URL format mirrors:
//   cc-candybar://<verb>/<value>   where <value> may itself contain `/`.

import { launchSync } from "../../proc/launch";
import { listAvailableThemes } from "../../themes/cascade";
import { STYLE_ORDER } from "../../themes/default-mapping";
import type { SessionStateRW } from "../session-state";

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

// [LAW:dataflow-not-control-flow] Theme is data; the verb writes the
// requested theme name into SessionState and the next render reads it via
// the same store. No cycling logic — cycling is a DSL-config decision
// (click → set-theme=<next-in-list>) per epic-vhi addendum.
const setTheme: VerbHandler = (value, ctx) => {
  const { sessionId, rest: themeName } = splitSessionAndRest(value);
  const sid = requireSessionId(sessionId);
  if (!themeName) throw new BadVerbArgs("set-theme: theme name is required");
  const themes = listAvailableThemes();
  if (!themes.includes(themeName))
    throw new BadVerbArgs(
      `set-theme: unknown theme "${themeName}" (have: ${themes.join(", ")})`,
    );
  ctx.sessionState.set(sid, "theme", themeName);
  ctx.dlog("info", `set-theme: ${themeName} (session=${sid})`);
};

const setStyle: VerbHandler = (value, ctx) => {
  const { sessionId, rest: styleName } = splitSessionAndRest(value);
  const sid = requireSessionId(sessionId);
  if (!styleName) throw new BadVerbArgs("set-style: style name is required");
  if (!STYLE_ORDER.includes(styleName))
    throw new BadVerbArgs(
      `set-style: unknown style "${styleName}" (have: ${STYLE_ORDER.join(", ")})`,
    );
  ctx.sessionState.set(sid, "style", styleName);
  ctx.dlog("info", `set-style: ${styleName} (session=${sid})`);
};

// ─── Registry ───────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The verb table is THE list of supported click
// verbs. Order is alphabetical for diff-stability — the daemon does not
// care about order, but human readers do.
export const VERBS: Readonly<Record<string, VerbHandler>> = Object.freeze({
  copy,
  "open-vscode": openVscode,
  "set-style": setStyle,
  "set-theme": setTheme,
  "show-config-error": showConfigError,
  "toolbar-toggle": toolbarToggle,
});

export const VERB_NAMES: readonly string[] = Object.freeze(
  Object.keys(VERBS),
) as readonly string[];
