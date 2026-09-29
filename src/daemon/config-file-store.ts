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
// writes the config file. Everything it computes over
// the file's text is the pure editor in src/config/json5-edit.ts, so a
// hand-authored file keeps its comments, key order, quoting, and trailing
// commas: exactly one span changes per edit.
//
// [LAW:dataflow-not-control-flow] A VALUE write is one splice at the path its
// key spells: `globals` merge per field, and so do `segments.<name>` and
// `presets.<name>` (loader/merge.ts), so a first pin under a bundled name
// writes that one field and nothing else, and a reset that empties the
// declaration prunes it (json5-edit's deleteValue) so the name tracks the
// bundled one again. Only a STRUCTURAL edit on a tree the file inherits has
// something to author first — the one row (`root.rows.<name>`, the by-name
// cascade of src/config/root.ts) or the one preset root
// (`presets.<name>.root`) the edit lands in — and that step is the identity
// when the file already authors it.

import { BadVerbArgs } from "./verb-error";
import fs from "node:fs";
import { writeAtomic } from "../utils/atomic-write.js";
import path from "node:path";
import {
  DEFAULT_DSL_CONFIG,
  RAW_DEFAULT_DSL_CONFIG,
} from "../config/default-dsl-config.js";
import { loadConfigSource, validateConfig } from "../config/dsl-loader.js";
import { ConfigError } from "../config/loader/diagnostics.js";
import type {
  Globals,
  LayoutNode,
  PresetDecl,
  Root,
  RootFragment,
  SettingValue,
  ValidatedConfig,
} from "../config/dsl-types.js";
import { isRowsFragment } from "../config/root.js";
import { presetNames, presetRoot } from "../config/presets.js";
import {
  deleteValue,
  hasSegmentRef,
  insertSegmentRef,
  json5Text,
  JSON5_DIALECT,
  movableTextOf,
  nodeAt,
  parseDocument,
  removeSegmentRef,
  restagesFragment,
  rowEntriesOf,
  setPlacementSetting,
  setValue,
  type Node,
} from "../config/json5-edit.js";
import {
  mintPlacement,
  type LayoutOp,
  type NewPlacement,
} from "../config/layout-ops.js";
import {
  parsePersistTarget,
  persistPath,
  presetGlobalsKey,
  type ConfigPath,
  type PersistTarget,
} from "../config/loader/persist-target.js";
import type { DaemonLogger } from "./log.js";
import { BUNDLED_PRESETS, isBundledPreset } from "./bundled-presets.js";
import { ident } from "../config/ident.js";

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
  default_empty_value: "string",
  default_separator: "string",
  default_truncate_marker: "string",
  palette: "string",
  look: "string",
  preset: "string",
  style: "string",
  progression: "string",
  autoWrap: "boolean",
  padding: "number",
  charset: "string",
  updateNotice: "boolean",
  colorCompatibility: "string",
  menuGlyph: "string",
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
    target.scope === "segment-palette"
      ? "string"
      : GLOBALS_FIELD_KIND[target.field];
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

// [LAW:no-silent-failure] The existing file's mode survives (a hand-authored
// file keeps whatever the user gave it) and a first-ever file takes the
// process umask like any file the user would create. `null` text is the
// absent file — undo of a first-ever write removes what that write created.
// Logs at "error" for the daemon-log breadcrumb, then RETHROWS so the click
// fails loudly instead of claiming a success that didn't happen.
export function writeConfigText(
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

// ─── Where a target lives, and what authors it ──────────────────────────────

// [LAW:types-are-the-program] A structural edit's placement in THIS file:
// the path the edited tree is spliced at, and the TREE the file must author
// before that path exists — the bundled row or preset root the edit lands
// in — or null when the file already authors it. There is no "declared
// nowhere" placement: the cascade refuses instead.
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

const RAW = RAW_DEFAULT_DSL_CONFIG;
const RAW_SEGMENTS: Readonly<Record<string, unknown>> = RAW.segments;
const RAW_PRESETS: Readonly<Record<string, PresetDecl>> = RAW.presets;
const RAW_ROOT: Root = RAW.root;

// [LAW:no-silent-failure] A write under a by-name declaration NEITHER the
// file nor the bundled default carries is the stale click: the gate admitted
// a key from a config this file no longer holds (a custom segment or preset
// deleted by hand since the render, another session's file). It refuses,
// never falls through — for a preset, "not declared" once read as "declares
// no root" and redirected the write onto the file's own top-level `root`.
function requireDeclared(
  doc: Node | null,
  own: ConfigPath,
  bundled: unknown,
  key: string,
): void {
  if (!has(doc, own) && bundled === undefined) {
    throw new BadVerbArgs(
      `cannot edit ${key}: neither the config file nor the bundled default declares ${own.join(".")}`,
    );
  }
}

// [LAW:types-are-the-program] A target that names a VALUE — every scope but
// the preset root, whose edits are structural (a row, not a scalar).
type ValueTarget = Exclude<PersistTarget, { scope: "preset-root" }>;

// The path a value write splices at. A globals field is always declared; a
// segment field needs its segment declared somewhere, since the one field
// the file would then hold is a delta over the bundled declaration.
function valuePathOf(doc: Node | null, target: ValueTarget): ConfigPath {
  const path = persistPath(target);
  if (target.scope === "segment-palette") {
    requireDeclared(
      doc,
      ["segments", target.segment],
      RAW_SEGMENTS[target.segment],
      path.join("."),
    );
  }
  return path;
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

// The bundled preset's root as a layer at its place in the file — a first
// structural edit materializes `presets.<name>.root` alone, the one field
// the edit lands in — or null for a preset that stages no root.
function bundledRootLayer(
  path: ConfigPath,
  root: RootFragment | undefined,
): RootLayer | null {
  if (root === undefined) return null;
  const authored = authoredFragment(root);
  return {
    path,
    fragment: bundledDoc(authored),
    unit: { path, value: authored },
  };
}

// [LAW:parse-dont-validate] The preset's fragment, by mergeWithDefault's own
// rule, field by field: the file's `root` under that name wins, else the
// bundled preset's, else the preset stages no root. A preset declared
// nowhere is the stale click requireDeclared refuses.
// [LAW:one-source-of-truth] A declared fragment that is the merge identity
// stages the config's own root, exactly as presetRoot classifies it
// (root.ts's `restages`), so every path this module names agrees with the
// one the renderer reports.
function presetLayer(doc: Node | null, preset: string): RootLayer | null {
  const own: ConfigPath = ["presets", preset];
  const path: ConfigPath = [...own, "root"];
  const bundled = RAW_PRESETS[preset];
  requireDeclared(doc, own, bundled, path.join("."));
  const layer = fileLayer(doc, path) ?? bundledRootLayer(path, bundled?.root);
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
  id: string,
): Placement {
  for (const { node, ...placement } of cascadeOf(doc, preset).values()) {
    if (hasSegmentRef(node, id)) return placement;
  }
  throw new BadVerbArgs(
    `${stagedPathOf(doc, preset).join(".")} holds no placement "${id}" — the bar you clicked is stale (it reloads on the next render), or the action names a placement the layout never held`,
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

// [LAW:locality-or-seam] Where a tracked write reports what it changed: the
// click's journal (src/daemon/settings-history.ts), which turns the click into
// one undoable step. This module writes the file and never keeps history.
export interface EditStore {
  readonly record: (file: string, before: string | null, after: string) => void;
  readonly logger: DaemonLogger;
}

// [LAW:one-source-of-truth] Every tracked write lands here — the file write
// and its record in one place, so recording cannot drift from mutation. The
// file is the truth, so it goes first.
// [LAW:single-enforcer] THE gate on what a click may write: text the loader
// accepts, proved by the loader itself before the file changes. A write that
// would not load (a copied group declared twice, a preset an action still
// targets) is refused with the loader's own diagnosis, and the file — and
// everything the verb does after its write — stays as it was.
function commit(
  store: EditStore,
  file: string,
  before: string | null,
  after: string,
): void {
  loadOrRefuse(file, after);
  writeConfigText(file, after, store.logger);
  store.record(file, before, after);
}

// The config `text` loads to as `file`, or the click's refusal naming why it
// does not load.
function loadOrRefuse(file: string, text: string): ValidatedConfig {
  try {
    return validateConfig(
      loadConfigSource(file, text, DEFAULT_DSL_CONFIG),
      file,
    );
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    throw new BadVerbArgs(
      `refused: the config file would not load after this click — ${e.message}`,
    );
  }
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

/**
 * Set the value each key names, as ONE tracked write: `persist` writes one
 * pair, `save` every draft. The splices fold over the text in memory and the
 * file is written once, so a reload can never read a half-saved file.
 */
export function writeValues(
  store: EditStore,
  file: string,
  pairs: ReadonlyArray<readonly [key: string, raw: string]>,
): void {
  writeDrafts(store, file, pairs, []);
}

// One placement's setting as a save writes it: the value, and the placement
// `id` in the layout `preset` renders that holds it.
export interface PlacementValue {
  readonly preset: string;
  readonly id: string;
  readonly setting: string;
  readonly value: SettingValue;
}

/** `save`'s write: every value key and every placement setting, as ONE tracked write. */
export function writeDrafts(
  store: EditStore,
  file: string,
  pairs: ReadonlyArray<readonly [key: string, raw: string]>,
  placements: readonly PlacementValue[],
): void {
  const before = readConfigText(file);
  const valued = pairs.reduce(
    (text, [key, raw]) =>
      setValue(
        text,
        valuePathOf(docOf(text), requireValueTarget(key)),
        persistValueText(key, raw),
        JSON5_DIALECT,
      ),
    before ?? "",
  );
  commit(
    store,
    file,
    before,
    withPlacements(valued, file, placements, (text) => text),
  );
}

// Every placement value laid into `text`, each inside its placement in the row
// of its preset's layout that holds it — the row materialized first when the
// file inherits it, as a structural edit's is. `own` runs first, and decides
// which layer that row is in: a save leaves it where the preset renders it
// from; save-as-preset moves it into the new preset (ownRow).
// [LAW:no-silent-failure] A placement no row holds is the stale click's loud
// error, never a value written somewhere plausible.
function withPlacements(
  text: string,
  file: string,
  placements: readonly PlacementValue[],
  own: (text: string, preset: string, id: string) => string,
): string {
  return placements.reduce((prior, { preset, id, setting, value }) => {
    const acc = own(prior, preset, id);
    const placement = layoutPlacementOf(docOf(acc), preset, id);
    const set = setPlacementSetting(
      ensureAuthored(acc, placement),
      placement.path,
      id,
      setting,
      json5Text(value),
    );
    if (set === null) {
      throw new BadVerbArgs(
        `${placement.path.join(".")} in ${file} has no placement "${id}" — the bar you clicked is stale (it reloads on the next render)`,
      );
    }
    return set;
  }, text);
}

// The row holding `id` in `preset`'s layout, copied into the preset's OWN root
// when a layer other presets share supplies it — the file's `root` or a
// bundled row — so a value written into it is this preset's alone. A named
// row lands at `rows.<row>`, the unit the by-name cascade replaces; a whole
// tree replaces the preset's root outright.
// [LAW:no-silent-failure] A tree under a preset that already stages its own
// rows cannot be copied without discarding them: refused, never clobbered.
function ownRow(text: string, preset: string, id: string): string {
  const doc = docOf(text);
  const own: ConfigPath = ["presets", preset, "root"];
  for (const [row, { path, unit, node }] of cascadeOf(doc, preset)) {
    if (!hasSegmentRef(node, id)) continue;
    if (own.every((key, i) => path[i] === key)) return text;
    const rowText =
      unit === null ? movableTextOf(text, node) : json5Text(unit.value);
    if (row !== TREE_BLOCK) {
      return setValue(text, [...own, "rows", row], rowText, JSON5_DIALECT);
    }
    if (presetLayer(doc, preset) !== null) {
      throw new BadVerbArgs(
        `cannot give preset "${preset}" its own copy of ${path.join(".")}: it already stages rows of its own over that tree`,
      );
    }
    return setValue(text, own, rowText, JSON5_DIALECT);
  }
  return text;
}

// [LAW:one-source-of-truth] A preset the user authored is declared by its
// name alone — `presets.mine: {}` still offers `mine` — so a reset that empties
// it keeps the name; under a bundled name the entry is a delta, and an empty
// one prunes so the name tracks the bundled preset again.
function deleteAtPath(text: string, path: ConfigPath): string {
  const ownPreset =
    path[0] === "presets" && path.length > 2 && !isBundledPreset(path[1]!);
  return deleteValue(text, path, ownPreset ? 2 : 0);
}

/**
 * `reset`'s write: delete the path each key names, as ONE tracked write, so
 * the next reload falls back to the bundled default (or, for a preset root,
 * the config's own root). Paths the file never authored change nothing, and a
 * reset that changes nothing records nothing.
 */
export function deleteValues(
  store: EditStore,
  file: string,
  keys: readonly string[],
): void {
  const targets = keys.map(requireTarget);
  const before = readConfigText(file);
  if (before === null) return;
  const after = targets.reduce(
    (text, target) => deleteAtPath(text, resetPathOf(docOf(text), target)),
    before,
  );
  if (after === before) return;
  commit(store, file, before, after);
}

const SAVED_PRESET_PREFIX = "custom-";

// [LAW:single-enforcer] The name a saved preset takes: the first `custom-N`
// no preset the written file will declare already holds — the bundled ones
// and the file's own, read from the very text the write lands in — compared
// by `ident`, the collapse the loader refuses two preset names sharing.
function freePresetName(doc: Node | null): string {
  const declared = doc === null ? undefined : nodeAt(doc, ["presets"]);
  const taken = new Set(
    [
      ...BUNDLED_PRESETS,
      ...(declared?.kind === "object"
        ? declared.entries.map((e) => e.key)
        : []),
    ].map(ident),
  );
  // One more candidate than there are names, so one is always free.
  return Array.from(
    { length: taken.size + 1 },
    (_, i) => `${SAVED_PRESET_PREFIX}${i + 1}`,
  ).find((candidate) => !taken.has(ident(candidate)))!;
}

/**
 * Save as preset: declare `presets.<name>` as ONE tracked write and return the
 * name — a copy of preset `from`: the root it stages, as the file spells it
 * (comments included) or as the bundled preset's authored text, and its
 * `globals`; then each `presets.<name>.globals.<field>` of `picks` over them.
 * A preset that stages the config's own root carries no root, and one with
 * nothing to pin is `{}`: the name alone is the declaration.
 */
export function writePreset(
  store: EditStore,
  file: string,
  from: string,
  globals: Globals,
  picks: ReadonlyArray<readonly [field: keyof Globals, raw: string]>,
  placements: ReadonlyArray<Omit<PlacementValue, "preset">>,
): string {
  const before = readConfigText(file);
  const doc = docOf(before ?? "");
  const name = freePresetName(doc);
  const own: ConfigPath = ["presets", name];
  const staged = presetLayer(doc, from);
  const copied: ReadonlyArray<readonly [ConfigPath, string]> = [
    ...(staged === null
      ? []
      : [
          [
            [...own, "root"],
            staged.unit === null
              ? movableTextOf(before ?? "", staged.fragment)
              : json5Text(staged.unit.value),
          ] as const,
        ]),
    ...(Object.keys(globals).length === 0
      ? []
      : [[[...own, "globals"], json5Text(globals)] as const]),
  ];
  const pinned = picks.map(([field, raw]) => {
    const key = presetGlobalsKey(name, field);
    return [
      valuePathOf(doc, requireValueTarget(key)),
      persistValueText(key, raw),
    ] as const;
  });
  const after = [...copied, ...pinned].reduce(
    (text, [at, value]) => setValue(text, at, value, JSON5_DIALECT),
    setValue(before ?? "", own, "{}", JSON5_DIALECT),
  );
  // The placements the session configured, each in a row the new preset
  // owns — never in a layer the preset it was copied from renders too.
  const placed = withPlacements(
    after,
    file,
    placements.map((p) => ({ ...p, preset: name })),
    ownRow,
  );
  commit(store, file, before, placed);
  return name;
}

/**
 * Delete a preset the file authors, as ONE tracked write — and the file's
 * `globals.preset` with it when that names it, since a default naming no
 * declared preset fails the load. Never a bundled preset: the file's entry
 * there is a delta the bundled preset survives, which `reset` owns. Never a
 * name the file does not declare: the stale click. What else the file says
 * about the preset (an action targeting it) is commit's to refuse.
 */
export function deletePreset(
  store: EditStore,
  file: string,
  name: string,
): void {
  if (isBundledPreset(name)) {
    throw new BadVerbArgs(
      `cannot delete preset "${name}": it is bundled — reset its settings instead`,
    );
  }
  const own: ConfigPath = ["presets", name];
  const before = readConfigText(file);
  const doc = docOf(before ?? "");
  if (before === null || doc === null || nodeAt(doc, own) === undefined) {
    throw new BadVerbArgs(
      `cannot delete preset "${name}": ${file} declares no ${own.join(".")} — the bar you clicked is stale; it reloads on the next render`,
    );
  }
  const selected = nodeAt(doc, ["globals", "preset"]);
  const paths: readonly ConfigPath[] = [
    own,
    ...(selected?.kind === "string" && selected.value === name
      ? [["globals", "preset"]]
      : []),
  ];
  commit(
    store,
    file,
    before,
    paths.reduce((text, at) => deleteAtPath(text, at), before),
  );
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
): NewPlacement | null {
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
  const { after, placed } = spliceOp(authored, placement.path, op, () => {
    // [LAW:no-ambient-temporal-coupling] Minted over the text this click
    // splices, never a cached render of it: a hand edit, or a click an
    // instant earlier, is in the text before any watcher reloads it.
    const config = loadOrRefuse(file, authored);
    return presetNames(config.presets).map(
      (preset) => presetRoot(config, preset).node,
    );
  });
  if (after === null) {
    throw new BadVerbArgs(
      `${placement.path.join(".")} in ${file} has no placement "${subject}" — the bar you clicked is stale (it reloads on the next render), or the action names a placement the layout never held`,
    );
  }
  commit(store, file, before, after);
  return placed;
}

// [LAW:dataflow-not-control-flow] One splice per op arm, total over LayoutOp:
// a removal places nothing; an insertion places the segment under the id
// `mintPlacement` finds free in every tree it reaches.
function spliceOp(
  text: string,
  path: ConfigPath,
  op: LayoutOp,
  rendered: () => readonly LayoutNode[],
): { readonly after: string | null; readonly placed: NewPlacement | null } {
  switch (op.op) {
    case "remove":
      return { after: removeSegmentRef(text, path, op.target), placed: null };
    case "insert": {
      const placed = mintPlacement(op.segment, op.anchor, rendered());
      return {
        after: insertSegmentRef(text, path, placed, op.anchor, op.relation),
        placed,
      };
    }
  }
}
