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
//
// [LAW:one-source-of-truth] The file is ONE flat dict keyed by whatever
// string a `persist`/`reset` action names (candybar-config-engine-71o.6
// generalized this from Globals-only fields to also admit
// `segments.<name>.palette` keys — see loader/persist-target.ts, the shared
// parser both this module and cross-ref.ts classify a key through). Keeping
// ONE flat dict (rather than a nested `{globals, segments}` shape) means the
// read-modify-write/atomic-rename plumbing below never needed to change
// shape — only what keys/values count as valid grew.

import fs from "node:fs";
import path from "node:path";
import type { Globals } from "../config/dsl-types.js";
import { isGlobalsField } from "../config/loader/globals.js";
import { parsePersistTarget } from "../config/loader/persist-target.js";
import { debug } from "../utils/logger.js";
import type { DaemonLogger } from "./log.js";

const quietLogger: DaemonLogger = (_level, message) => debug(message);

// [LAW:one-source-of-truth] Re-exported so every existing importer
// (verbs/index.ts, verbs/config-validators.ts) keeps reading membership
// through this module — but the membership check itself now has exactly ONE
// implementation (loader/globals.ts's isGlobalsField, derived from
// GLOBALS_SCHEMA), not two independently-authored tables that TypeScript's
// per-table exhaustiveness only coincidentally kept in agreement.
export { isGlobalsField } from "../config/loader/globals.js";

// [LAW:types-are-the-program] Every Globals field's primitive WIRE TYPE,
// keyed by `keyof Globals` — TypeScript forces this map to stay total over
// Globals, so a field added to/removed from that interface is a compile
// error here until this table is updated. This is the ONE place a `persist`
// write's canonical string is coerced to the JS type Globals actually
// declares (padding: number, autoWrap: boolean, everything else: string). A
// segment-palette target has no matching row: it's always a NAME, so its
// kind is "string" unconditionally — see coercePersistValue below. Membership
// (which keys exist) is NOT re-declared here — see the re-exported
// isGlobalsField above; this table only adds the per-field KIND membership
// alone doesn't carry.
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
// lifts it into the typed value its scope declares. An out-of-range/non-
// numeric string for a "number" Globals field is a caller bug (the range
// validator already canonicalized it), so it throws loudly rather than
// writing a silently-wrong type into the overrides file. Replaces the old
// Globals-only `coerceGlobalsValue`: a bare `string` key (not `keyof
// Globals`) so a caller no longer needs a type-narrowing assertion before
// calling this — parsePersistTarget does the classification internally.
export function coercePersistValue(
  key: string,
  raw: string,
): string | number | boolean {
  const target = parsePersistTarget(key);
  if (target === null) {
    throw new Error(
      `coercePersistValue: "${key}" is not a valid persist target`,
    );
  }
  if (target.scope === "segment-palette") return raw;
  const kind = GLOBALS_FIELD_KIND[target.field];
  if (kind === "string") return raw;
  if (kind === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(
        `coercePersistValue: "${key}" expects a number, got "${raw}"`,
      );
    }
    return n;
  }
  if (BOOLEAN_TRUTHY.has(raw)) return true;
  if (BOOLEAN_FALSY.has(raw)) return false;
  throw new Error(
    `coercePersistValue: "${key}" expects boolean-ish (1, 0, true, false), got "${raw}"`,
  );
}

// [LAW:no-silent-failure] Missing/corrupt/wrong-shape file → the empty
// override set is the *defined* recovery (identical to a first-ever boot),
// not a hidden fallback to different data. Every present key is classified
// through parsePersistTarget (globals field or segment-palette) and its
// value checked against that target's kind; a single malformed entry drops
// the WHOLE file back to empty (mirrors FileSessionStorage's all-or-nothing
// shape check) rather than guessing which entries to keep.
function isValidOverrides(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const [key, v] of Object.entries(value)) {
    const target = parsePersistTarget(key);
    if (target === null) return false;
    const kind =
      target.scope === "segment-palette"
        ? "string"
        : GLOBALS_FIELD_KIND[target.field];
    if (kind === "number" && typeof v !== "number") return false;
    if (kind === "boolean" && typeof v !== "boolean") return false;
    if (kind === "string" && typeof v !== "string") return false;
  }
  return true;
}

// [LAW:single-enforcer] The ONE reader of the on-disk shape — every scoped
// view (loadConfigOverrides, loadSegmentPaletteOverrides) and every writer
// (writeConfigOverride, clearConfigOverride) reads through this, so the
// flat-dict shape and its recovery-to-empty behavior are decided exactly once.
function loadRawOverrides(
  filePath: string,
  logger: DaemonLogger,
): Readonly<Record<string, string | number | boolean>> {
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

// [LAW:one-source-of-truth] The Globals-scoped VIEW of the raw dict — kept as
// `Partial<Globals>` so every existing caller (RenderCache's
// mergeWithDefault({globals: ...}), stepConfig's range-seed lookup) keeps its
// original, precisely-typed contract unchanged. Segment-palette entries in
// the same file are invisible here by construction (isGlobalsField filters
// them out) — see loadSegmentPaletteOverrides for that half.
export function loadConfigOverrides(
  filePath: string,
  logger: DaemonLogger = quietLogger,
): Partial<Globals> {
  const raw = loadRawOverrides(filePath, logger);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isGlobalsField(key)) out[key] = value;
  }
  // [LAW:no-silent-fallbacks] exception: isValidOverrides already proved every
  // entry's runtime kind matches its target's declared kind (GLOBALS_FIELD_KIND)
  // before it ever reached the file — this cast states that proof, it doesn't
  // paper over an unchecked one.
  return out as Partial<Globals>;
}

// [LAW:one-source-of-truth] The segment-palette-scoped VIEW of the SAME raw
// dict — segment name -> persisted palette name. RenderCache overlays this
// onto the already-merged config's `segments[name].palette` field
// (applySegmentPaletteOverrides in config/loader/merge.ts), never through
// mergeWithDefault's wholesale per-name segment replacement.
export function loadSegmentPaletteOverrides(
  filePath: string,
  logger: DaemonLogger = quietLogger,
): Readonly<Record<string, string>> {
  const raw = loadRawOverrides(filePath, logger);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = parsePersistTarget(key);
    if (target?.scope === "segment-palette" && typeof value === "string") {
      out[target.segment] = value;
    }
  }
  return out;
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
  overrides: Readonly<Record<string, string | number | boolean>>,
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
  key: string,
  value: string | number | boolean,
  logger: DaemonLogger = quietLogger,
): void {
  const overrides = loadRawOverrides(filePath, logger);
  writeOverrides(filePath, { ...overrides, [key]: value }, logger);
}

export function clearConfigOverride(
  filePath: string,
  key: string,
  logger: DaemonLogger = quietLogger,
): void {
  const overrides = loadRawOverrides(filePath, logger);
  if (!(key in overrides)) return;
  const next = { ...overrides };
  delete next[key];
  writeOverrides(filePath, next, logger);
}
