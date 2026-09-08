// [LAW:one-source-of-truth] The config FILE is the one durable store: every durable write lands in the file
// the session's render actually read. What remains is config file < session pick.
// [LAW:effects-at-boundaries] This module is the ONE edge that reads and writes the config file and the edit history.

import { BadVerbArgs } from "./verb-error";
import fs from "node:fs";
import { writeAtomic } from "../utils/atomic-write.js";
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

// [LAW:types-are-the-program] Total over `keyof Globals`, so a field added to that interface is a compile error until this table is updated.
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

// [LAW:one-source-of-truth] The same four boolean-ish inputs validateBoolean accepts, arriving as the raw member string.
const BOOLEAN_TRUTHY = new Set(["1", "true"]);
const BOOLEAN_FALSY = new Set(["0", "false", ""]);

// [LAW:parse-dont-validate] A wrongly-typed string here is a caller bug the range validator should already have rejected, so it throws.
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

export function readConfigText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// [LAW:no-silent-failure] Logs the breadcrumb, then RETHROWS so the click fails loudly instead of claiming a success that didn't happen.
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
    writeAtomic(file, text);
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

// [LAW:types-are-the-program] `path` is the value span the key names; `unit` is the by-name declaration the file must hold first, or null when it already does.
interface Placement {
  readonly path: ConfigPath;
  readonly unit: { readonly path: ConfigPath; readonly value: unknown } | null;
}

// [LAW:one-source-of-truth] The A-grammar spelling, so a materialized root reads like a root the user would write.
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

// [LAW:parse-dont-validate] The ONE place "who declares this unit" is decided, by mergeWithDefault's own rule.
// The last arm is the stale click — a key from a config this file no longer holds — and it must refuse, never fall through.
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

// [LAW:types-are-the-program] A target that names a VALUE — every scope but the preset root, whose edits are structural.
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

// [LAW:one-type-per-behavior] One layer of the root cascade a preset renders, spelled the way it would sit in the
// file, so one grammar reader answers "does this layer hold the segment" for all of them [LAW:one-source-of-truth].
interface RootLayer {
  readonly path: ConfigPath;
  readonly fragment: Node;
  readonly unit: Placement["unit"];
}

function bundledDoc(value: unknown): Node {
  return parseDocument(json5Text(value));
}

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

// [LAW:parse-dont-validate] The preset's fragment by mergeWithDefault's own rule; the last arm is a stale click and must refuse.
// [LAW:one-source-of-truth] A fragment that is the merge identity stages the config's own root, as presetRoot classifies it.
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

// [LAW:one-source-of-truth] The merged rows with their PROVENANCE, folded by the same algebra mergeRoot uses.
// [LAW:parse-dont-validate] Each entry carries the config-file address an edit lands at, stamped where the layer's shape is known.
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

// [LAW:single-enforcer] THE answer to "which row does this click edit": the first merged row holding the segment.
// [LAW:no-silent-failure] No row holds it ⇒ the bar clicked rendered before the row changed — loud, never a plausible write.
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

function stagedPathOf(doc: Node | null, preset: string): ConfigPath {
  return presetLayer(doc, preset)?.path ?? ["root"];
}

function resetPathOf(doc: Node | null, target: PersistTarget): ConfigPath {
  return target.scope === "preset-root"
    ? stagedPathOf(doc, target.preset)
    : persistPath(target);
}

// [LAW:dataflow-not-control-flow] Always runs; identity when the file already authors the unit.
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

export interface EditStore {
  readonly historyPath: string;
  readonly logger: DaemonLogger;
}

export function readValue(
  file: string,
  key: string,
): string | number | boolean | undefined {
  const target = requireValueTarget(key);
  const doc = docOf(readConfigText(file) ?? "");
  const node = doc === null ? undefined : nodeAt(doc, persistPath(target));
  return node !== undefined && "value" in node ? node.value : undefined;
}

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

/** `reset`'s write: delete the path the key names. A path the file never authored changes nothing. */
export function deleteValue(store: EditStore, file: string, key: string): void {
  const target = requireTarget(key);
  const before = readConfigText(file);
  if (before === null) return;
  const after = deleteAtPath(before, resetPathOf(docOf(before), target));
  if (after === before) return;
  commit(store, file, { before, after });
}

/** A structural edit applied to the cascade row holding the segment, in authored grammar so its comments survive. [LAW:no-silent-failure] A target no row holds is a loud error. */
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

// [LAW:types-are-the-program] ONE snapshot shape for every edit kind; `before: null` is the absent file, so undo removes it.
export interface Snapshot {
  readonly before: string | null;
  readonly after: string;
}

export interface FileHistory {
  readonly past: readonly Snapshot[];
  readonly future: readonly Snapshot[];
}

// [LAW:types-are-the-program] Keyed by config file, so a session stepping file A's stack cannot pop an edit made to file B.
type HistoryState = Readonly<Record<string, FileHistory>>;

const EMPTY_FILE_HISTORY: FileHistory = { past: [], future: [] };

// [LAW:carrying-cost] Bounded per file: a whole-file snapshot per entry is why the bound is what makes this safe.
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

// [LAW:no-silent-failure] Missing/corrupt/wrong-shape → the empty history is the DEFINED recovery, logged; one bad entry drops the whole history.
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

// [LAW:one-source-of-truth] Every tracked write lands here, so recording cannot drift from mutation; the file goes first.
// [LAW:no-silent-failure] A record that fails after the file landed says so — the edit is real, it is just not undoable.
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

// A fresh edit TRUNCATES `future`: doing something new abandons whatever was undone.
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

// [LAW:no-silent-failure] Undo restores `before` only while the file still reads as `after`; a file edited since is not that
// state, and the refusal names it. Returns `null` at the bottom of the stack, which the verb turns into a loud BadVerbArgs.
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
