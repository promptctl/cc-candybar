// [LAW:one-source-of-truth] The config FILE is the one durable store
// (candybar-config-dqe). A `persist` click, a `reset`, a `+`/`-` layout edit
// — every durable write lands in the file the session's render actually
// read, at the path its persist key spells (loader/persist-target.ts). There
// is no machine-owned overrides layer beside it: two durable stores for one
// key could disagree, and nothing could say which was lying. What remains is
// config file < session pick, and the session pick never claims to be the
// durable answer.
//
// [LAW:effects-at-boundaries] This module is the ONE edge that reads and
// writes the config file and the edit history. Everything it computes over
// the file's text is the pure editor in src/config/json5-edit.ts, so a
// hand-authored file keeps its comments, key order, quoting, and trailing
// commas: exactly one span changes per edit.
//
// [LAW:dataflow-not-control-flow] Every write runs the same two steps —
// "ensure the target's declaration is authored in the file", then "splice
// the value" — and the first step is the identity when the file already
// authors it. `segments` and `presets` merge BY NAME, WHOLESALE (loader/
// merge.ts), so a first-ever write under a bundled name materializes the
// whole bundled declaration first; otherwise the one-field file would shadow
// the bundled decl and lose its template. A follow-up ticket proposes per-
// field merge for those decls, after which materialization collapses to the
// one field. A root's ROWS already merge by name (src/config/root.ts), so a
// structural edit on a row the file inherits materializes that one row —
// `root.rows.<name>` — and never the whole tree.

import { BadVerbArgs } from "./verb-error";
import fs from "node:fs";
import path from "node:path";
import { RAW_DEFAULT_DSL_CONFIG } from "../config/default-dsl-config.js";
import type {
  Globals,
  LayoutNode,
  PresetDecl,
  Root,
  RootFragment,
} from "../config/dsl-types.js";
import { isRowsFragment } from "../config/root.js";
import {
  deleteValue as deleteAtPath,
  hasSegmentRef,
  insertSegmentRef,
  json5Text,
  JSON5_DIALECT,
  nodeAt,
  parseDocument,
  removeSegmentRef,
  restagesFragment,
  rowEntriesOf,
  setValue,
  type Node,
} from "../config/json5-edit.js";
import type { LayoutOp } from "../config/layout-ops.js";
import {
  parsePersistTarget,
  persistPath,
  type ConfigPath,
  type PersistTarget,
} from "../config/loader/persist-target.js";
import type { DaemonLogger } from "./log.js";

// [LAW:types-are-the-program] Every Globals field's primitive type, keyed by
// `keyof Globals` — TypeScript forces this map to stay total over Globals, so
// a field added to/removed from that interface is a compile error here until
// this table is updated. This is the ONE place a `persist` write's canonical
// string becomes the JSON5 text the file declares the field with (padding: a
// number, autoWrap: a boolean, everything else: a string). A segment-palette
// target has no row: it is always a NAME.
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
  preset: "string",
  style: "string",
  autoWrap: "boolean",
  padding: "number",
  charset: "string",
  updateNotice: "boolean",
  colorCompatibility: "string",
};

// [LAW:one-source-of-truth] The same four boolean-ish inputs validateBoolean
// (state-validators.ts) accepts — a `persist` action's gate is an ALLOW-LIST
// whose members pass through verbatim, so a config author writing
// `cycle: ["true", "false"]` or `to: "0"` reaches this boundary with the raw
// member string, not a pre-canonicalized "1"/"".
const BOOLEAN_TRUTHY = new Set(["1", "true"]);
const BOOLEAN_FALSY = new Set(["0", "false", ""]);

// [LAW:parse-dont-validate] The write gate canonicalizes to a STRING (the
// wire currency); this is the boundary that lifts it into the JSON5 text of
// the typed value the file declares. An out-of-range/non-numeric string for a
// "number" field is a caller bug (the range validator already canonicalized
// it), so it throws loudly rather than writing a wrongly-typed value.
export function persistValueText(key: string, raw: string): string {
  const target = requireValueTarget(key);
  const kind =
    target.scope === "globals" ? GLOBALS_FIELD_KIND[target.field] : "string";
  if (kind === "string") return JSON.stringify(raw);
  if (kind === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(
        `persistValueText: "${key}" expects a number, got "${raw}"`,
      );
    }
    return String(n);
  }
  if (BOOLEAN_TRUTHY.has(raw)) return "true";
  if (BOOLEAN_FALSY.has(raw)) return "false";
  throw new Error(
    `persistValueText: "${key}" expects boolean-ish (1, 0, true, false), got "${raw}"`,
  );
}

// ─── The file ────────────────────────────────────────────────────────────────

/** The file's text, or null when it does not exist. */
export function readConfigText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// [LAW:one-source-of-truth] The one tmp+rename: a reader never sees a torn
// file, and a rename that fails leaves no orphaned tmp behind.
function writeAtomic(file: string, text: string, mode?: number): void {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? {} : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// [LAW:no-silent-failure] The existing file's mode survives (a hand-authored
// file keeps whatever the user gave it) and a first-ever file takes the
// process umask like any file the user would create. `null` text is the
// absent file — undo of a first-ever write removes what that write created.
// Logs at "error" for the daemon-log breadcrumb, then RETHROWS so the click
// fails loudly instead of claiming a success that didn't happen.
function writeConfigText(
  file: string,
  text: string | null,
  logger: DaemonLogger,
): void {
  try {
    if (text === null) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.statSync(file, { throwIfNoEntry: false });
    writeAtomic(file, text, existing?.mode);
  } catch (e) {
    const message = `config write failed (${file}): ${(e as Error).message}`;
    logger("error", message);
    throw new Error(message);
  }
}

function docOf(text: string): Node | null {
  return /^\s*$/.test(text) ? null : parseDocument(text);
}

function has(doc: Node | null, p: ConfigPath): boolean {
  return doc !== null && nodeAt(doc, p) !== undefined;
}

// ─── Where a target lives, and what authors it ──────────────────────────────

// [LAW:types-are-the-program] A target's placement in THIS file: the path the
// value is spliced at, and the by-name declaration that must be authored for
// that path to mean what it means today (`null` when the path's parent merges
// per field, as `globals` does). `value` is what the merged config holds
// there now — the bundled declaration — or undefined when nothing does, which
// `ensureAuthored` turns into a loud error rather than a hollow decl.
// [LAW:types-are-the-program] `path` is the value span the key names; `unit`
// is the by-name declaration the file must hold before that path exists —
// the bundled declaration to materialize — or null when the file already
// authors it (globals always; a segment/preset the file declares). There is
// no "declared nowhere" placement: placementOf refuses instead.
interface Placement {
  readonly path: ConfigPath;
  readonly unit: { readonly path: ConfigPath; readonly value: unknown } | null;
}

// [LAW:one-source-of-truth] The A-grammar spelling of a canonical tree, so a
// materialized root reads like a root the user would write (`{ h: [...] }`,
// bare segment names) rather than the loader's lowered form. A node that is
// already authoring grammar (the raw default's group sugar) passes through.
function authoredLayout(node: LayoutNode): unknown {
  if (node.kind === "segment") {
    return node.when === undefined
      ? node.name
      : { seg: node.name, when: node.when };
  }
  if (node.kind === "container") {
    const { kind, direction, children, ...own } = node;
    return {
      [direction === "horizontal" ? "h" : "v"]: children.map(authoredLayout),
      ...own,
    };
  }
  return node;
}

// A root fragment as authored: a `{ rows }` map spells each row, a tree
// spells itself. Lossless: the loader reads the spelling back to the same
// canonical fragment, own fields included (pinned in test/dsl-layout-edit).
export function authoredFragment(fragment: RootFragment): unknown {
  if (!isRowsFragment(fragment)) return authoredLayout(fragment);
  const { rows, ...own } = fragment;
  return {
    rows: Object.fromEntries(
      Object.entries(rows).map(([name, row]) => [name, authoredLayout(row)]),
    ),
    ...own,
  };
}

function authoredPreset(decl: PresetDecl): unknown {
  return {
    ...(decl.root !== undefined && { root: authoredFragment(decl.root) }),
    ...(decl.globals !== undefined && { globals: decl.globals }),
  };
}

const RAW = RAW_DEFAULT_DSL_CONFIG;
const RAW_SEGMENTS: Readonly<Record<string, unknown>> = RAW.segments;
const RAW_PRESETS: Readonly<Record<string, PresetDecl>> = RAW.presets;
const RAW_ROOT: Root = RAW.root;

// [LAW:parse-dont-validate] The ONE place "who declares this unit" is
// decided, by mergeWithDefault's own rule: the file's declaration wins by
// name (nothing to materialize), else the bundled one is what a first write
// materializes, else there is no declaration. That last arm is the stale
// click: the gate admitted a key from a config this file no longer holds (a
// custom preset deleted by hand since the render, another session's file).
// It must refuse, never fall through — for a preset, "not declared" once
// read as "declares no root" and redirected the write onto the file's own
// top-level `root`.
type Declaration<T> =
  | { readonly source: "file" }
  | { readonly source: "bundled"; readonly decl: T };

function declarationOf<T>(
  doc: Node | null,
  unitPath: ConfigPath,
  bundled: T | undefined,
  key: string,
): Declaration<T> {
  if (has(doc, unitPath)) return { source: "file" };
  if (bundled === undefined) {
    throw new BadVerbArgs(
      `cannot edit ${key}: neither the config file nor the bundled default declares ${unitPath.join(".")}`,
    );
  }
  return { source: "bundled", decl: bundled };
}

function unitOf<T>(
  declaration: Declaration<T>,
  unitPath: ConfigPath,
  spell: (decl: T) => unknown,
): Placement["unit"] {
  return declaration.source === "file"
    ? null
    : { path: unitPath, value: spell(declaration.decl) };
}

// [LAW:types-are-the-program] A target that names a VALUE — every scope but
// the preset root, whose edits are structural (a row, not a scalar).
type ValueTarget = Exclude<PersistTarget, { scope: "preset-root" }>;

function valuePlacementOf(doc: Node | null, target: ValueTarget): Placement {
  if (target.scope === "globals") {
    return { path: persistPath(target), unit: null };
  }
  const path = persistPath(target);
  const own: ConfigPath = ["segments", target.segment];
  return {
    path,
    unit: unitOf(
      declarationOf(doc, own, RAW_SEGMENTS[target.segment], path.join(".")),
      own,
      (decl) => decl,
    ),
  };
}

// ─── The root cascade, as the file spells it ────────────────────────────────

// [LAW:one-type-per-behavior] One layer of the root cascade a preset renders
// (bundled root rows < file root < the preset's fragment — the order
// mergeRoot folds in src/config/root.ts): its fragment in the AUTHORING
// grammar, the config-file path a structural edit to it lands at, and what
// the file must author first for that path to hold it — null for a layer the
// file already authors. Every layer is spelled the way it would sit in the
// file (a bundled one as the very text `ensureAuthored` would materialize),
// so one grammar reader (json5-edit) answers "does this layer hold the
// segment" for all of them [LAW:one-source-of-truth].
interface RootLayer {
  readonly path: ConfigPath;
  readonly fragment: Node;
  readonly unit: Placement["unit"];
}

function bundledDoc(value: unknown): Node {
  return parseDocument(json5Text(value));
}

// The bundled default's root, one layer PER ROW: a first edit on an inherited
// row materializes `root.rows.<name>` alone, the by-name cascade's own unit,
// never the whole tree.
function bundledRowLayers(): readonly RootLayer[] {
  return Object.entries(RAW_ROOT.rows).map(([name, row]) => {
    const authored = authoredLayout(row);
    return {
      path: ["root"],
      fragment: bundledDoc({ rows: { [name]: authored } }),
      unit: { path: ["root", "rows", name], value: authored },
    };
  });
}

function fileLayer(doc: Node | null, path: ConfigPath): RootLayer | null {
  const fragment = doc === null ? undefined : nodeAt(doc, path);
  return fragment === undefined ? null : { path, fragment, unit: null };
}

// [LAW:parse-dont-validate] The preset's fragment, by mergeWithDefault's own
// rule: the file's declaration wins by name (its `root`, if any), else the
// bundled one (materialized whole, `globals` included — presets still merge
// wholesale by name), else the click is stale: the gate admitted a key from a
// config this file no longer holds, and it must refuse, never fall through.
// [LAW:one-source-of-truth] A declared fragment that is the merge identity
// stages the config's own root, exactly as presetRoot classifies it
// (root.ts's `restages`), so every path this module names agrees with the
// one the renderer reports.
function presetLayer(doc: Node | null, preset: string): RootLayer | null {
  const own: ConfigPath = ["presets", preset];
  const path: ConfigPath = [...own, "root"];
  const declaration = declarationOf(
    doc,
    own,
    RAW_PRESETS[preset],
    path.join("."),
  );
  const root =
    declaration.source === "file" ? undefined : declaration.decl.root;
  const layer =
    declaration.source === "file"
      ? fileLayer(doc, path)
      : root === undefined
        ? null
        : {
            path,
            fragment: bundledDoc(authoredFragment(root)),
            unit: { path: own, value: authoredPreset(declaration.decl) },
          };
  return layer !== null && restagesFragment(layer.fragment) ? layer : null;
}

// [LAW:one-source-of-truth] The merged rows with their PROVENANCE, folded by
// the same algebra mergeRoot uses: a `{ rows }` layer spreads over the base
// by name (a replaced row keeps its place, a new one appends), a whole tree
// replaces the base outright. A tree is one block under an unauthorable key
// — its positional rows can never be replaced individually (root.ts's
// ROW_NAME_RE), so they are searched as the contiguous front they always
// form, in the pre-order the bar renders. Each entry carries the exact
// config-file address a structural edit to it lands at — the row's own
// `rows.<name>` member, or the whole tree — stamped here, where the layer's
// shape is known, so the splice edits the row the cascade chose and never
// re-searches the fragment in file order [LAW:parse-dont-validate].
type Cascade = ReadonlyMap<string, Placement & { readonly node: Node }>;
const TREE_BLOCK = "#";

function applyLayer(base: Cascade, layer: RootLayer): Cascade {
  const rows = rowEntriesOf(layer.fragment);
  return rows === null
    ? new Map([
        [
          TREE_BLOCK,
          { path: layer.path, unit: layer.unit, node: layer.fragment },
        ],
      ])
    : new Map([
        ...base,
        ...rows.map(
          (row) =>
            [
              row.key,
              {
                path: [...layer.path, "rows", row.key],
                unit: layer.unit,
                node: row.value,
              },
            ] as const,
        ),
      ]);
}

function cascadeOf(doc: Node | null, preset: string): Cascade {
  const layers = [
    ...bundledRowLayers(),
    fileLayer(doc, ["root"]),
    presetLayer(doc, preset),
  ].filter((layer): layer is RootLayer => layer !== null);
  return layers.reduce(applyLayer, new Map());
}

// [LAW:single-enforcer] THE answer to "which row does this click edit": the
// first merged row holding the segment, at the address the cascade stamped.
// [LAW:no-silent-failure] No row holds it ⇒ the bar clicked rendered before
// the row changed under it — loud, never a write somewhere plausible.
function layoutPlacementOf(
  doc: Node | null,
  preset: string,
  segment: string,
): Placement {
  for (const { node, ...placement } of cascadeOf(doc, preset).values()) {
    if (hasSegmentRef(node, segment)) return placement;
  }
  throw new BadVerbArgs(
    `${stagedPathOf(doc, preset).join(".")} holds no segment "${segment}" — the bar you clicked is stale; it reloads on the next render`,
  );
}

// The path a preset's layout is authored at: the fragment it stages (the
// file's, or the bundled one's place in the file), else the config's own
// `root` — the same fact presetRoot's reported path projects.
function stagedPathOf(doc: Node | null, preset: string): ConfigPath {
  return presetLayer(doc, preset)?.path ?? ["root"];
}

function resetPathOf(doc: Node | null, target: PersistTarget): ConfigPath {
  return target.scope === "preset-root"
    ? stagedPathOf(doc, target.preset)
    : persistPath(target);
}

// [LAW:dataflow-not-control-flow] Always runs; identity when the file already
// authors the unit (the placement resolved it to null).
function ensureAuthored(text: string, { unit }: Placement): string {
  return unit === null
    ? text
    : setValue(text, unit.path, json5Text(unit.value), JSON5_DIALECT);
}

function requireTarget(key: string): PersistTarget {
  const target = parsePersistTarget(key);
  if (target === null) {
    throw new Error(`"${key}" is not a valid persist target`);
  }
  return target;
}

function requireValueTarget(key: string): ValueTarget {
  const target = requireTarget(key);
  if (target.scope === "preset-root") {
    throw new Error(`"${key}" names a layout, not a value`);
  }
  return target;
}

// ─── Tracked edits ───────────────────────────────────────────────────────────

export interface EditStore {
  readonly historyPath: string;
  readonly logger: DaemonLogger;
}

/** The scalar the file declares at a value target, or undefined. */
export function readValue(
  file: string,
  key: string,
): string | number | boolean | undefined {
  const target = requireValueTarget(key);
  const doc = docOf(readConfigText(file) ?? "");
  const node = doc === null ? undefined : nodeAt(doc, persistPath(target));
  return node !== undefined && "value" in node ? node.value : undefined;
}

/** `persist`'s write: set the value the key names, tracked in history. */
export function writeValue(
  store: EditStore,
  file: string,
  key: string,
  raw: string,
): void {
  const target = requireValueTarget(key);
  const before = readConfigText(file);
  const placement = valuePlacementOf(docOf(before ?? ""), target);
  const authored = ensureAuthored(before ?? "", placement);
  const after = setValue(
    authored,
    placement.path,
    persistValueText(key, raw),
    JSON5_DIALECT,
  );
  commit(store, file, { before, after });
}

/**
 * `reset`'s write: delete the path the key names, so the next reload falls
 * back to the bundled default (or, for a preset root, the config's own root).
 * A path the file never authored changes nothing and records nothing.
 */
export function deleteValue(store: EditStore, file: string, key: string): void {
  const target = requireTarget(key);
  const before = readConfigText(file);
  if (before === null) return;
  const after = deleteAtPath(before, resetPathOf(docOf(before), target));
  if (after === before) return;
  commit(store, file, { before, after });
}

/**
 * A structural edit to the layout a preset-root key names, applied to the ROW
 * of the cascade that holds the segment (the op's target, or the anchor it
 * inserts beside), in the authored (A-grammar) text so its comments survive.
 * [LAW:no-silent-failure] A target/anchor no row holds is a loud error — the
 * click came from a bar rendered before the row changed.
 */
export function applyLayoutOp(
  store: EditStore,
  file: string,
  key: string,
  op: LayoutOp,
): void {
  const target = requireTarget(key);
  if (target.scope !== "preset-root") {
    throw new Error(`"${key}" is not a "presets.<name>.root" target`);
  }
  const before = readConfigText(file);
  const subject = op.op === "remove" ? op.target : op.anchor;
  const placement = layoutPlacementOf(
    docOf(before ?? ""),
    target.preset,
    subject,
  );
  const authored = ensureAuthored(before ?? "", placement);
  const after =
    op.op === "remove"
      ? removeSegmentRef(authored, placement.path, op.target)
      : insertSegmentRef(
          authored,
          placement.path,
          op.segment,
          op.anchor,
          op.relation,
        );
  if (after === null) {
    throw new BadVerbArgs(
      `${placement.path.join(".")} in ${file} has no segment "${subject}" — the bar you clicked is stale; it reloads on the next render`,
    );
  }
  commit(store, file, { before, after });
}

// ─── History: whole-file snapshots, one stack per file ──────────────────────

// [LAW:types-are-the-program] ONE snapshot shape covers every edit kind — a
// globals value, a palette pin, a layout op, a reset — because at this layer
// each is "the file went from `before` to `after`". `before: null` is the
// absent file (a first-ever write created it), so undoing that write removes
// the file rather than leaving an empty one the loader rejects.
export interface Snapshot {
  readonly before: string | null;
  readonly after: string;
}

export interface FileHistory {
  readonly past: readonly Snapshot[];
  readonly future: readonly Snapshot[];
}

// [LAW:types-are-the-program] Keyed by config file: a snapshot sits in the
// stack of the one file it belongs to, so a session whose render resolved
// file A steps A's stack and cannot pop an edit made to file B.
type HistoryState = Readonly<Record<string, FileHistory>>;

const EMPTY_FILE_HISTORY: FileHistory = { past: [], future: [] };

// [LAW:carrying-cost] Bounded per file so a long-running daemon's history
// cannot grow without limit — a whole-file snapshot per entry is why the
// bound is what makes this safe, not a nicety. Oldest entries fall off first.
const MAX_HISTORY_DEPTH = 50;

function isSnapshot(v: unknown): v is Snapshot {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    (o.before === null || typeof o.before === "string") &&
    typeof o.after === "string"
  );
}

function isFileHistory(v: unknown): v is FileHistory {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.past) &&
    o.past.every(isSnapshot) &&
    Array.isArray(o.future) &&
    o.future.every(isSnapshot)
  );
}

// [LAW:no-silent-failure] Missing/corrupt/wrong-shape file → the empty
// history is the DEFINED recovery (a first-ever boot), logged; a single
// malformed entry drops the WHOLE history rather than guessing which entries
// to salvage.
function loadHistory(store: EditStore): HistoryState {
  let raw: string;
  try {
    raw = fs.readFileSync(store.historyPath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      store.logger(
        "warn",
        `config-edit-history read failed (${code}); starting empty`,
      );
    }
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every(isFileHistory)
    ) {
      return parsed as HistoryState;
    }
  } catch {
    // fall through to the warn below
  }
  store.logger(
    "warn",
    "config-edit-history load: unexpected shape, starting empty",
  );
  return {};
}

function writeHistory(store: EditStore, state: HistoryState): void {
  try {
    fs.mkdirSync(path.dirname(store.historyPath), { recursive: true });
    writeAtomic(store.historyPath, JSON.stringify(state), 0o600);
  } catch (e) {
    const message = `config-edit-history write failed: ${(e as Error).message}`;
    store.logger("error", message);
    throw new Error(message);
  }
}

function capPush<T>(arr: readonly T[], entry: T): readonly T[] {
  const next = [...arr, entry];
  return next.length > MAX_HISTORY_DEPTH
    ? next.slice(-MAX_HISTORY_DEPTH)
    : next;
}

// [LAW:one-source-of-truth] Every tracked write lands here — the file write
// and the history record in one place, so recording cannot drift from
// mutation. The file is the truth and the history derives from it, so the
// file goes first; [LAW:no-silent-failure] a record that fails after the
// file landed says so — the edit is real, it is just not undoable.
function record(
  store: EditStore,
  file: string,
  text: string | null,
  state: HistoryState,
  verb: string,
): void {
  writeConfigText(file, text, store.logger);
  try {
    writeHistory(store, state);
  } catch (e) {
    throw new Error(
      `${verb} landed in ${file} but recording it failed — it is not undoable: ${(e as Error).message}`,
    );
  }
}

// A fresh edit TRUNCATES `future`: doing something new abandons whatever was
// undone.
function commit(store: EditStore, file: string, snapshot: Snapshot): void {
  const state = loadHistory(store);
  const { past } = state[file] ?? EMPTY_FILE_HISTORY;
  record(
    store,
    file,
    snapshot.after,
    { ...state, [file]: { past: capPush(past, snapshot), future: [] } },
    "edit",
  );
}

// [LAW:no-silent-failure] Undo restores `before` only while the file still
// reads as `after` — the state the entry promised to revert from. A file
// edited by hand (or by another daemon) since then is not that state, and
// silently overwriting it would destroy work the history never saw. The
// refusal names the file so the user knows what to look at. Returns `null`
// at the bottom of the stack; the verb turns that into a loud BadVerbArgs.
export function undoEdit(store: EditStore, file: string): Snapshot | null {
  const state = loadHistory(store);
  const { past, future } = state[file] ?? EMPTY_FILE_HISTORY;
  const entry = past[past.length - 1];
  if (entry === undefined) return null;
  requireFileState(file, entry.after, "undo");
  record(
    store,
    file,
    entry.before,
    {
      ...state,
      [file]: { past: past.slice(0, -1), future: capPush(future, entry) },
    },
    "undo",
  );
  return entry;
}

export function redoEdit(store: EditStore, file: string): Snapshot | null {
  const state = loadHistory(store);
  const { past, future } = state[file] ?? EMPTY_FILE_HISTORY;
  const entry = future[future.length - 1];
  if (entry === undefined) return null;
  requireFileState(file, entry.before, "redo");
  record(
    store,
    file,
    entry.after,
    {
      ...state,
      [file]: { past: capPush(past, entry), future: future.slice(0, -1) },
    },
    "redo",
  );
  return entry;
}

function requireFileState(
  file: string,
  expected: string | null,
  verb: "undo" | "redo",
): void {
  if (readConfigText(file) !== expected) {
    throw new BadVerbArgs(
      `${verb}: ${file} has changed since that edit — refusing to overwrite it`,
    );
  }
}
