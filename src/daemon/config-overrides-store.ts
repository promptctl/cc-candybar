// [LAW:one-source-of-truth] The daemon is the SOLE writer of
// configOverridesPath() — the hand-authored user config file is never
// machine-edited (candybar-config-engine-71o's binding guardrail). A
// persistent config write (the `persist` action, distinct from `set`'s
// per-session write) lands here; RenderCache merges it on top of the user
// file every reload (src/daemon/cache/render.ts), so this module owns only
// the read/write/shape of the override layer, never the merge.
//
// [LAW:single-enforcer] Read-modify-write + atomic rename, synchronous. Writes
// here are click-rate (rare), not render-rate (SessionState's every-render
// atom) — there is no debounce to coalesce and no in-memory cache to keep
// warm; RenderCache re-reads this file fresh on every reload, exactly as it
// re-reads the user config file. One source, read where it's needed.

import fs from "node:fs";
import path from "node:path";
import type { Globals } from "../config/dsl-types.js";
import { debug } from "../utils/logger.js";
import type { DaemonLogger } from "./log.js";

const quietLogger: DaemonLogger = (_level, message) => debug(message);

// [LAW:types-are-the-program] Every Globals field's primitive wire shape,
// keyed by `keyof Globals` — TypeScript forces this map to stay total over
// Globals, so a field added to/removed from that interface is a compile
// error here until this table is updated. This is the ONE place a `persist`
// write's canonical string is coerced to the JS type Globals actually
// declares (padding: number, autoWrap: boolean, everything else: string).
const GLOBALS_FIELD_KIND: Readonly<
  Record<keyof Globals, "string" | "number" | "boolean">
> = {
  default_bg: "string",
  default_fg: "string",
  default_empty_value: "string",
  default_separator: "string",
  default_truncate_marker: "string",
  palette: "string",
  look: "string",
  style: "string",
  autoWrap: "boolean",
  padding: "number",
  charset: "string",
  colorCompatibility: "string",
};

// [LAW:one-source-of-truth] Whether `key` names a real Globals field —
// derived from GLOBALS_FIELD_KIND rather than a second hand-maintained list,
// so "is this a legal persist target" and "what type does it coerce to"
// cannot disagree.
export function isGlobalsField(key: string): key is keyof Globals {
  return Object.prototype.hasOwnProperty.call(GLOBALS_FIELD_KIND, key);
}

// [LAW:one-source-of-truth] The same four canonical boolean-ish inputs
// validateBoolean (state-validators.ts) accepts — a `persist` action's gate
// is an ALLOW-LIST (the declared `to`/`cycle` members pass through
// membership-checked but otherwise VERBATIM, unlike validateBoolean's own
// bespoke normalization), so a config author writing `cycle: ["true",
// "false"]` or `to: "0"` reaches this boundary with the raw member string,
// not a pre-canonicalized "1"/"". This is the ONE place that must accept the
// full accepted-input set, not just the canonical pair.
const BOOLEAN_TRUTHY = new Set(["1", "true"]);
const BOOLEAN_FALSY = new Set(["0", "false", ""]);

// [LAW:no-silent-fallbacks] The `persist` write's validator canonicalizes to
// a STRING (the same wire currency `set` uses) — this is the boundary that
// lifts it into the typed value Globals declares. An out-of-range/non-numeric
// string for a "number" field is a caller bug (the range validator already
// canonicalized it), so it throws loudly rather than writing a silently-wrong
// type into the overrides file.
export function coerceGlobalsValue(
  key: keyof Globals,
  raw: string,
): Globals[keyof Globals] {
  const kind = GLOBALS_FIELD_KIND[key];
  if (kind === "string") return raw;
  if (kind === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(
        `coerceGlobalsValue: "${key}" expects a number, got "${raw}"`,
      );
    }
    return n;
  }
  if (BOOLEAN_TRUTHY.has(raw)) return true;
  if (BOOLEAN_FALSY.has(raw)) return false;
  throw new Error(
    `coerceGlobalsValue: "${key}" expects boolean-ish (1, 0, true, false), got "${raw}"`,
  );
}

// [LAW:no-silent-fallbacks] Missing/corrupt/wrong-shape file → the empty
// override set is the *defined* recovery (identical to a first-ever boot),
// not a hidden fallback to different data. Every present key/value pair is
// checked against GLOBALS_FIELD_KIND; a single malformed entry drops the
// WHOLE file back to empty (mirrors FileSessionStorage's all-or-nothing
// shape check) rather than guessing which entries to keep.
function isValidOverrides(value: unknown): value is Partial<Globals> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const [key, v] of Object.entries(value)) {
    if (!isGlobalsField(key)) return false;
    const kind = GLOBALS_FIELD_KIND[key];
    if (kind === "number" && typeof v !== "number") return false;
    if (kind === "boolean" && typeof v !== "boolean") return false;
    if (kind === "string" && typeof v !== "string") return false;
  }
  return true;
}

export function loadConfigOverrides(
  filePath: string,
  logger: DaemonLogger = quietLogger,
): Partial<Globals> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger("warn", `config-overrides read failed (${code}); starting empty`);
    }
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isValidOverrides(parsed)) return parsed;
    logger("warn", `config-overrides load: unexpected shape, starting empty`);
    return {};
  } catch {
    logger("warn", `config-overrides load: corrupt JSON, starting empty`);
    return {};
  }
}

// [LAW:no-silent-failure] Atomic write shared by set/clear: read the current
// overrides, apply one mutation, write-to-temp + rename. Owner-only mode,
// matching every other daemon runtime file (session-state.json, pid, lease).
// Unlike session-state.json's debounced best-effort flush (no synchronous
// caller waiting on it), a `persist` write is directly caused by a click that
// expects a truthful ack — a swallowed failure here would let the verb
// handler log "set-config: ..." as if it landed when nothing was written.
// Logs at "error" for the daemon-log breadcrumb, then RETHROWS so the caller
// (the click) fails loudly instead of claiming a success that didn't happen.
function writeOverrides(
  filePath: string,
  overrides: Partial<Globals>,
  logger: DaemonLogger,
): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(overrides), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    const message = `config-overrides write failed: ${(e as Error).message}`;
    logger("error", message);
    throw new Error(message);
  }
}

export function writeConfigOverride(
  filePath: string,
  key: keyof Globals,
  value: Globals[keyof Globals],
  logger: DaemonLogger = quietLogger,
): void {
  const overrides = loadConfigOverrides(filePath, logger);
  writeOverrides(filePath, { ...overrides, [key]: value }, logger);
}

export function clearConfigOverride(
  filePath: string,
  key: string,
  logger: DaemonLogger = quietLogger,
): void {
  const overrides = loadConfigOverrides(filePath, logger);
  if (!(key in overrides)) return;
  const next = { ...overrides };
  delete next[key as keyof Globals];
  writeOverrides(filePath, next, logger);
}
