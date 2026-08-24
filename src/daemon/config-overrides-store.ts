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
  // The active arrangement — a NAME like palette/look, so `persist: "preset"`
  // makes a chosen preset the default every future session opens in.
  preset: "string",
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
  // [LAW:one-type-per-behavior] Both non-globals scopes are always a NAME/
  // TOKEN string — segment-palette's value is a palette name, preset-root-ops'
  // is one op token appended by the daemon's apply-layout-op verb handler
  // (never a bare `persist` write — see verbs/index.ts). Neither has a
  // GLOBALS_FIELD_KIND row because neither is a Globals field.
  if (
    target.scope === "segment-palette" ||
    target.scope === "preset-root-ops"
  ) {
    return raw;
  }
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
      target.scope === "globals" ? GLOBALS_FIELD_KIND[target.field] : "string";
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

// [LAW:one-source-of-truth] The Globals-scoped VIEW of a raw dict — kept as
// `Partial<Globals>` so every existing caller (RenderCache's
// mergeWithDefault({globals: ...}), stepConfig's range-seed lookup) keeps its
// original, precisely-typed contract unchanged. Segment-palette entries in
// the same file are invisible here by construction (isGlobalsField filters
// them out) — see projectSegmentPaletteOverrides for that half. A pure
// projection over an already-read dict (not a filePath) so a caller wanting
// BOTH views (loadOverrides below) pays for exactly one read.
//
// [LAW:no-defensive-null-guards] exception: `Object.create(null)` — the key
// being assigned comes from the on-disk overrides file, which a `persist`
// write only ever populates from a real Globals field name (isGlobalsField
// already excludes "__proto__"), but the accumulator itself gets the same
// null-prototype hygiene src/dsl/render.ts's segment-keyed accumulator uses
// ("segment names come from user config; a null-prototype object prevents
// __proto__/constructor/prototype from being treated as segment data") —
// one guard at the object, not a per-caller property-name check.
function projectGlobalsOverrides(
  raw: Readonly<Record<string, string | number | boolean>>,
): Partial<Globals> {
  const out: Record<string, string | number | boolean> = Object.create(
    null,
  ) as Record<string, string | number | boolean>;
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
//
// [LAW:no-defensive-null-guards] exception: `Object.create(null)` — unlike
// projectGlobalsOverrides, the assigned key here (`target.segment`) is NOT
// membership-checked against any closed set before the write (any string a
// config declares as a segment name is legal), so a segment genuinely named
// `__proto__` would otherwise hit the prototype setter on `out[key] =` —
// the exact crash class the render.ts precedent (see above) already guards
// against for segment-keyed objects.
function projectSegmentPaletteOverrides(
  raw: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [key, value] of Object.entries(raw)) {
    const target = parsePersistTarget(key);
    if (target?.scope === "segment-palette" && typeof value === "string") {
      out[target.segment] = value;
    }
  }
  return out;
}

// [LAW:one-source-of-truth] The preset-root-ops-scoped VIEW of the SAME raw
// dict — preset name -> the accumulated op-token LIST (brandon-layout-edit-
// 2gc.1's structural-edit log; see src/config/layout-ops.ts). This is a
// SHAPE check only (well-formed JSON array of strings) — decoding each
// token into a typed LayoutOp, and applying the ops to a tree, is presets.ts's
// job, not this storage-layer module's [LAW:decomposition]. A stored value
// that isn't a JSON array of strings drops for THAT preset only (a warn log,
// never a crash of the whole overrides file) — the identical "the world
// moved on since this was written" recovery projectSegmentPaletteOverrides
// already gets, one level narrower.
function projectPresetRootOpsOverrides(
  raw: Readonly<Record<string, string | number | boolean>>,
  logger: DaemonLogger,
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = Object.create(null) as Record<
    string,
    readonly string[]
  >;
  for (const [key, value] of Object.entries(raw)) {
    const target = parsePersistTarget(key);
    if (target?.scope !== "preset-root-ops" || typeof value !== "string") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) {
        out[target.preset] = parsed;
        continue;
      }
    } catch {
      // fall through to the warn below
    }
    logger(
      "warn",
      `config-overrides: "${key}" is not a valid op-token list, dropping`,
    );
  }
  return out;
}

export function loadConfigOverrides(
  filePath: string,
  logger: DaemonLogger = quietLogger,
): Partial<Globals> {
  return projectGlobalsOverrides(loadRawOverrides(filePath, logger));
}

export function loadSegmentPaletteOverrides(
  filePath: string,
  logger: DaemonLogger = quietLogger,
): Readonly<Record<string, string>> {
  return projectSegmentPaletteOverrides(loadRawOverrides(filePath, logger));
}

// [LAW:carrying-cost] RenderCache wants ALL THREE views on every reload
// (buildState merges globals overrides, overlays segment-palette overrides,
// then replays preset-root-ops overrides) — calling the scoped loaders back
// to back would read, parse, and shape-validate the same tiny file three
// times per reload for no reason. One read, three projections.
export interface Overrides {
  readonly globals: Partial<Globals>;
  readonly segmentPalette: Readonly<Record<string, string>>;
  readonly presetRootOps: Readonly<Record<string, readonly string[]>>;
}

export function loadOverrides(
  filePath: string,
  logger: DaemonLogger = quietLogger,
): Overrides {
  const raw = loadRawOverrides(filePath, logger);
  return {
    globals: projectGlobalsOverrides(raw),
    segmentPalette: projectSegmentPaletteOverrides(raw),
    presetRootOps: projectPresetRootOpsOverrides(raw, logger),
  };
}

// [LAW:no-silent-failure] The atomic write/rename dance, generalized over ANY
// JSON-serializable value — both this module's flat overrides dict and its
// history stack (below) go through this one primitive rather than each
// re-implementing mkdir+tmp+chmod+rename. Owner-only mode, matching every
// other daemon runtime file (session-state.json, pid, lease). `label` names
// the failure in the log/thrown message (the caller's own vocabulary —
// "config-overrides"/"config-overrides-history" — not derived from the path,
// so the wording a test might match on stays stable across either file).
// Unlike session-state.json's debounced best-effort flush (no synchronous
// caller waiting on it), a `persist`/`undo`/`redo` write is directly caused
// by a click that expects a truthful ack — a swallowed failure here would let
// the verb handler log success for a write that didn't land. Logs at "error"
// for the daemon-log breadcrumb, then RETHROWS so the caller (the click)
// fails loudly instead of claiming a success that didn't happen.
function writeJsonAtomic(
  filePath: string,
  label: string,
  value: unknown,
  logger: DaemonLogger,
): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    const message = `${label} write failed: ${(e as Error).message}`;
    logger("error", message);
    throw new Error(message);
  }
}

function writeOverrides(
  filePath: string,
  overrides: Readonly<Record<string, string | number | boolean>>,
  logger: DaemonLogger,
): void {
  writeJsonAtomic(filePath, "config-overrides", overrides, logger);
}

// [LAW:one-source-of-truth] The one place a key's value in the flat dict
// changes (set-or-delete) — writeConfigOverride/clearConfigOverride/
// restoreConfigOverrideValue all fold through here, so "what was the value
// BEFORE this write" (the fact history needs) is captured at the one site
// that reads-then-writes it, never re-derived. `value: undefined` deletes;
// any other value sets. Returns the previous value (or undefined if the key
// was absent) — the caller decides whether that fact matters.
function mutateOverride(
  filePath: string,
  key: string,
  value: string | number | boolean | undefined,
  logger: DaemonLogger,
): string | number | boolean | undefined {
  const overrides = loadRawOverrides(filePath, logger);
  const prev = overrides[key];
  if (value === undefined) {
    if (!(key in overrides)) return prev;
    const next = { ...overrides };
    delete next[key];
    writeOverrides(filePath, next, logger);
  } else {
    writeOverrides(filePath, { ...overrides, [key]: value }, logger);
  }
  return prev;
}

// [LAW:one-source-of-truth] `persist`'s write, TRACKED: mutate the key, then
// record the transition on the SAME global history undo/redo step
// (brandon-layout-edit-2gc.2). This is the ONE enforcement point — every
// current and future caller of writeConfigOverride (setConfig, stepConfig,
// apply-layout-op's append) gets history for free, with zero edits to those
// verb handlers, because the recording lives here rather than at each call
// site. [LAW:locality-or-seam]
export function writeConfigOverride(
  filePath: string,
  key: string,
  value: string | number | boolean,
  logger: DaemonLogger = quietLogger,
): void {
  const prev = mutateOverride(filePath, key, value, logger);
  pushHistoryEntry(filePath, { key, from: prev ?? null, to: value }, logger);
}

// [LAW:one-source-of-truth] `reset`'s write, TRACKED — mirrors
// writeConfigOverride above. A clear that touches nothing (the key was
// already absent) records no entry: nothing changed, so there is nothing to
// undo back to.
export function clearConfigOverride(
  filePath: string,
  key: string,
  logger: DaemonLogger = quietLogger,
): void {
  const overrides = loadRawOverrides(filePath, logger);
  if (!(key in overrides)) return;
  const prev = mutateOverride(filePath, key, undefined, logger);
  pushHistoryEntry(filePath, { key, from: prev ?? null, to: null }, logger);
}

// [LAW:one-source-of-truth] The UNTRACKED twin — restores a key to EXACTLY
// `value` (or clears it, for `null`) without recording a new history entry.
// The only legitimate callers are popPastEntry/popFutureEntry below: undo and
// redo already know they're moving an entry between the past/future stacks,
// so routing their own restoration back through the tracked writers would
// record the undo/redo AS a new forward edit — burying the entry it just
// popped and making the OTHER stack unreachable. This is a structurally
// distinct function, not a boolean flag on the tracked ones
// [LAW:no-mode-explosion] — its contract ("apply this exact value, no
// bookkeeping") is different from theirs ("write this value, remember how to
// undo it"), not a variant of the same one.
function restoreConfigOverrideValue(
  filePath: string,
  key: string,
  value: string | number | boolean | null,
  logger: DaemonLogger,
): void {
  mutateOverride(filePath, key, value === null ? undefined : value, logger);
}

// ─── Undo/redo history (brandon-layout-edit-2gc.2) ────────────────────────

// [LAW:types-are-the-program] ONE entry shape covers every scope the
// overrides file holds — a globals field's snapshot overwrite (setConfig), a
// segment-palette snapshot overwrite (same verb, different key shape), AND a
// preset-root-ops APPEND (apply-layout-op's read-current-append-write) —
// because at the STORAGE layer every one of those is indistinguishable from
// "the value at `key` changed from `from` to `to`". apply-layout-op computes
// its new array-of-tokens string by reading-then-appending one level up
// (verbs/index.ts); by the time that string reaches writeConfigOverride, it
// is just the next value at that key. Undo restoring `from` verbatim is
// therefore ALSO the correct "pop the last op token" behavior for a rootOps
// key, with no rootOps-specific code anywhere in this module — the ticket's
// "one history over the overrides layer, not a layout-specific feature" falls
// out of the shape, it isn't special-cased into it. `null` is the ABSENT
// sentinel (a key with no prior/no resulting value): safe because no real
// override value is ever `null` — see isValidOverrides's kind table.
export interface HistoryEntry {
  readonly key: string;
  readonly from: string | number | boolean | null;
  readonly to: string | number | boolean | null;
}

interface HistoryState {
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
}

const EMPTY_HISTORY: HistoryState = { past: [], future: [] };

// [LAW:carrying-cost] Resolves the ticket's "depth of the ring" question:
// bounded so a long-running daemon's history file cannot grow without limit,
// generous enough that no realistic editing session bumps into it. Oldest
// entries fall off first (capPush below) — a silent, documented trim, not a
// failure.
const MAX_HISTORY_DEPTH = 50;

// [LAW:one-source-of-truth] Resolves the ticket's "where it lives relative to
// the overrides file" question: a SIBLING file in the same directory, derived
// as a pure function of the overrides path already passed in — no reach to
// paths.ts/global state, so every existing call site (and every existing
// test's XDG_STATE_HOME isolation, which already isolates configOverridesPath())
// isolates this file too, with zero additional test-harness surface. Kept
// SEPARATE from the overrides file itself (rather than nesting it inside a
// wrapper shape) so the overrides file's own on-disk shape — asserted by
// name in existing tests and callers — never changes
// [LAW:locality-or-seam]: a change to history storage must not ripple into
// every existing reader of the flat overrides dict.
function historyPathFor(overridesFilePath: string): string {
  return path.join(
    path.dirname(overridesFilePath),
    "config-overrides-history.json",
  );
}

function isValidHistoryValue(
  v: unknown,
): v is string | number | boolean | null {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

function isValidHistoryEntry(v: unknown): v is HistoryEntry {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.key === "string" &&
    isValidHistoryValue(obj.from) &&
    isValidHistoryValue(obj.to)
  );
}

// [LAW:no-silent-failure] Missing/corrupt/wrong-shape file → the empty
// history is the DEFINED recovery (mirrors isValidOverrides/loadRawOverrides'
// identical "first-ever boot" treatment for the sibling file) — a single
// malformed entry drops the WHOLE history, never a guess at which entries to
// salvage.
function isValidHistoryState(v: unknown): v is HistoryState {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return (
    Array.isArray(obj.past) &&
    obj.past.every(isValidHistoryEntry) &&
    Array.isArray(obj.future) &&
    obj.future.every(isValidHistoryEntry)
  );
}

function loadHistoryState(
  overridesFilePath: string,
  logger: DaemonLogger,
): HistoryState {
  const filePath = historyPathFor(overridesFilePath);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger(
        "warn",
        `config-overrides-history read failed (${code}); starting empty`,
      );
    }
    return EMPTY_HISTORY;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isValidHistoryState(parsed)) return parsed;
    logger(
      "warn",
      `config-overrides-history load: unexpected shape, starting empty`,
    );
    return EMPTY_HISTORY;
  } catch {
    logger(
      "warn",
      `config-overrides-history load: corrupt JSON, starting empty`,
    );
    return EMPTY_HISTORY;
  }
}

function writeHistoryState(
  overridesFilePath: string,
  state: HistoryState,
  logger: DaemonLogger,
): void {
  writeJsonAtomic(
    historyPathFor(overridesFilePath),
    "config-overrides-history",
    state,
    logger,
  );
}

// [LAW:no-mode-explosion] Bounded push, oldest-drops-first, shared by both
// stacks (past grows on a fresh edit or a redo; future grows on an undo) —
// one shape, not two near-duplicate arms.
function capPush<T>(arr: readonly T[], entry: T, max: number): readonly T[] {
  const next = [...arr, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

// [LAW:one-source-of-truth] The ONLY caller is writeConfigOverride/
// clearConfigOverride above — every tracked write lands here, so recording
// cannot drift from mutation. A fresh edit TRUNCATES `future`: the classic
// undo/redo branch — diverging from history by doing something NEW abandons
// whatever was undone, rather than silently keeping it reachable from a
// history state the new edit has already invalidated.
function pushHistoryEntry(
  overridesFilePath: string,
  entry: HistoryEntry,
  logger: DaemonLogger,
): void {
  const state = loadHistoryState(overridesFilePath, logger);
  writeHistoryState(
    overridesFilePath,
    { past: capPush(state.past, entry, MAX_HISTORY_DEPTH), future: [] },
    logger,
  );
}

// [LAW:one-source-of-truth] The daemon-GLOBAL history is ONE stack, not
// per-session: config-overrides.json already has exactly one writer (the
// daemon) and no session-scoping (candybar-config-engine-71o's own binding
// guardrail — a `persist` write is daemon-global by design), so undo/redo
// stepping that SAME single-writer file inherits the same scope rather than
// inventing a session axis the storage layer doesn't otherwise have. Two
// sessions clicking undo do see each other's edits — a real, DELIBERATE
// consequence of there being one bar default, not a bug: the alternative
// (per-session history over daemon-global state) would let one session's
// "undo" silently fail to undo what another session's click actually did.
//
// [LAW:no-silent-failure] Returns `null` at the bottom of the stack — the
// verb handler (verbs/index.ts) turns that into a loud BadVerbArgs surfaced
// through click.error, never a silent no-op.
export function undoLastOverride(
  overridesFilePath: string,
  logger: DaemonLogger = quietLogger,
): HistoryEntry | null {
  const state = loadHistoryState(overridesFilePath, logger);
  const entry = state.past[state.past.length - 1];
  if (entry === undefined) return null;
  restoreConfigOverrideValue(overridesFilePath, entry.key, entry.from, logger);
  writeHistoryState(
    overridesFilePath,
    {
      past: state.past.slice(0, -1),
      future: capPush(state.future, entry, MAX_HISTORY_DEPTH),
    },
    logger,
  );
  return entry;
}

// [LAW:no-silent-failure] Redo's mirror of undo above — `null` at the top of
// the stack, same loud surfacing contract.
export function redoLastOverride(
  overridesFilePath: string,
  logger: DaemonLogger = quietLogger,
): HistoryEntry | null {
  const state = loadHistoryState(overridesFilePath, logger);
  const entry = state.future[state.future.length - 1];
  if (entry === undefined) return null;
  restoreConfigOverrideValue(overridesFilePath, entry.key, entry.to, logger);
  writeHistoryState(
    overridesFilePath,
    {
      past: capPush(state.past, entry, MAX_HISTORY_DEPTH),
      future: state.future.slice(0, -1),
    },
    logger,
  );
  return entry;
}
