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

import { BadVerbArgs } from "../daemon/foundations/verb-error";
import JSON5 from "json5";
import { DEFAULT_DSL_CONFIG } from "../config/default-dsl-config.js";
import {
  inheritedConfig,
  loadSnapshot,
  type LoadedChain,
} from "../config/dsl-loader.js";
import {
  writable,
  type ConfigSnapshot,
  type Layer,
  type LayerContent,
} from "../config/config-snapshot.js";
import { requireLayerText } from "./config-writes.js";
import { LAYER_ROLES, type LayerRole } from "../config/layer-role.js";
import { ConfigError } from "../config/loader/diagnostics.js";
import type {
  DslConfig,
  Globals,
  LayoutNode,
  PresetDecl,
  RootFragment,
  SettingValue,
} from "../config/dsl-types.js";
import {
  wireKindOf,
  type ThemeDefaultField,
} from "../config/globals-fields.js";
import { isRowsFragment, ROW_NAME_RE, rootNode } from "../config/root.js";
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

// [LAW:one-source-of-truth] The boolean-ish inputs a boolean field's file
// value is written from — a `persist` action's gate is an ALLOW-LIST
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
    target.scope === "segment-palette" ? "string" : wireKindOf(target.field);
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

// [LAW:no-silent-failure] A write under a by-name declaration NEITHER the
// file nor what it inherits carries is the stale click: the gate admitted
// a key from a config this file no longer holds (a custom segment or preset
// deleted by hand since the render, another session's file). It refuses,
// never falls through — for a preset, "not declared" once read as "declares
// no root" and redirected the write onto the file's own top-level `root`.
function requireDeclared(
  doc: Node | null,
  own: ConfigPath,
  inherited: unknown,
  key: string,
): void {
  if (!has(doc, own) && inherited === undefined) {
    throw new BadVerbArgs(
      `cannot edit ${key}: neither the config file nor the layers beneath it declare ${own.join(".")}`,
    );
  }
}

// [LAW:types-are-the-program] A target that names a VALUE — every scope but
// the preset root, whose edits are structural (a row, not a scalar).
type ValueTarget = Exclude<PersistTarget, { scope: "preset-root" }>;

// The path a value write splices at. A globals field is always declared; a
// segment field needs its segment declared somewhere, since the one field
// the file would then hold is a delta over the bundled declaration.
function valuePathOf(
  doc: Node | null,
  under: DslConfig,
  target: ValueTarget,
): ConfigPath {
  const path = persistPath(target);
  if (target.scope === "segment-palette") {
    requireDeclared(
      doc,
      ["segments", target.segment],
      under.segments[target.segment],
      path.join("."),
    );
  }
  return path;
}

// ─── The root cascade, as the file spells it ────────────────────────────────

// [LAW:one-type-per-behavior] One layer of the root cascade a preset renders
// (the rows the layers beneath hold < file root < the preset's fragment — the
// order mergeRoot folds in src/config/root.ts): its fragment in the AUTHORING
// grammar, the config-file path a structural edit to it lands at, and what
// the file must author first for that path to hold it — null for a layer the
// file already authors. Every layer is spelled the way it would sit in the
// file (an inherited one as the very text `ensureAuthored` would materialize),
// so one grammar reader (json5-edit) answers "does this layer hold the
// segment" for all of them [LAW:one-source-of-truth].
interface RootLayer {
  readonly path: ConfigPath;
  readonly fragment: Node;
  readonly unit: Placement["unit"];
}

function inheritedDoc(value: unknown): Node {
  return parseDocument(json5Text(value));
}

// The root the layers beneath merge to, one layer PER ROW: a first edit on an
// inherited row materializes `root.rows.<name>` alone, the by-name cascade's
// own unit, never the whole tree. A root a tree beneath lowered to positional
// rows has no row a file can name, so it is one layer: the whole tree.
function inheritedRowLayers(under: DslConfig): readonly RootLayer[] {
  if (!Object.keys(under.root.rows).every((name) => ROW_NAME_RE.test(name))) {
    const authored = authoredLayout(rootNode(under.root));
    return [
      {
        path: ["root"],
        fragment: inheritedDoc(authored),
        unit: { path: ["root"], value: authored },
      },
    ];
  }
  return Object.entries(under.root.rows).map(([name, row]) => {
    const authored = authoredLayout(row);
    return {
      path: ["root"],
      fragment: inheritedDoc({ rows: { [name]: authored } }),
      unit: { path: ["root", "rows", name], value: authored },
    };
  });
}

function fileLayer(doc: Node | null, path: ConfigPath): RootLayer | null {
  const fragment = doc === null ? undefined : nodeAt(doc, path);
  return fragment === undefined ? null : { path, fragment, unit: null };
}

// The preset's root as the layers beneath merge it, as a layer at its place
// in the file — a first structural edit materializes `presets.<name>.root`
// alone, the one field the edit lands in — or null for a preset that stages
// no root.
function inheritedRootLayer(
  path: ConfigPath,
  root: RootFragment | undefined,
): RootLayer | null {
  if (root === undefined) return null;
  const authored = authoredFragment(root);
  return {
    path,
    fragment: inheritedDoc(authored),
    unit: { path, value: authored },
  };
}

// [LAW:parse-dont-validate] The preset's fragment, by mergeWithDefault's own
// rule, field by field: the file's `root` under that name wins, else the one
// the layers beneath merge to, else the preset stages no root. A preset
// declared nowhere is the stale click requireDeclared refuses.
// [LAW:one-source-of-truth] A declared fragment that is the merge identity
// stages the config's own root, exactly as presetRoot classifies it
// (root.ts's `restages`), so every path this module names agrees with the
// one the renderer reports.
function presetLayer(
  doc: Node | null,
  under: DslConfig,
  preset: string,
): RootLayer | null {
  const own: ConfigPath = ["presets", preset];
  const path: ConfigPath = [...own, "root"];
  const inherited: PresetDecl | undefined = under.presets[preset];
  requireDeclared(doc, own, inherited, path.join("."));
  const layer =
    fileLayer(doc, path) ?? inheritedRootLayer(path, inherited?.root);
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

function cascadeOf(
  doc: Node | null,
  under: DslConfig,
  preset: string,
): Cascade {
  const layers = [
    ...inheritedRowLayers(under),
    fileLayer(doc, ["root"]),
    presetLayer(doc, under, preset),
  ].filter((layer): layer is RootLayer => layer !== null);
  return layers.reduce(applyLayer, new Map());
}

// [LAW:single-enforcer] THE answer to "which row does this click edit": the
// first merged row holding the segment, at the address the cascade stamped.
// [LAW:no-silent-failure] No row holds it ⇒ the bar clicked rendered before
// the row changed under it — loud, never a write somewhere plausible.
function layoutPlacementOf(
  doc: Node | null,
  under: DslConfig,
  preset: string,
  id: string,
): Placement {
  for (const { node, ...placement } of cascadeOf(doc, under, preset).values()) {
    if (hasSegmentRef(node, id)) return placement;
  }
  throw new BadVerbArgs(
    `${stagedPathOf(doc, under, preset).join(".")} holds no placement "${id}" — the bar you clicked is stale (it reloads on the next render), or the action names a placement the layout never held`,
  );
}

// The path a preset's layout is authored at: the fragment it stages (the
// file's, or the bundled one's place in the file), else the config's own
// `root` — the same fact presetRoot's reported path projects.
function stagedPathOf(
  doc: Node | null,
  under: DslConfig,
  preset: string,
): ConfigPath {
  return presetLayer(doc, under, preset)?.path ?? ["root"];
}

function resetPathOf(
  doc: Node | null,
  under: DslConfig,
  target: PersistTarget,
): ConfigPath {
  return target.scope === "preset-root"
    ? stagedPathOf(doc, under, target.preset)
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

// [LAW:locality-or-seam] Where a tracked write reads its file and reports
// what it wrote: the click's journal (src/renderer/settings-history.ts), which
// turns the click into one undoable step and its write into the change its
// turn returns. A click reads a file as its own writes left it. This module
// writes no file and keeps no history.
export interface EditStore {
  readonly read: (file: string) => LayerContent;
  readonly record: (file: string, before: string | null, after: string) => void;
}

// [LAW:one-source-of-truth] The layer a click writes, as the snapshot the
// host handed in for its session's origin holds it: the chain around it, and
// the plugins, strays and checkout a write is proved over.
export interface WriteLayer extends Layer {
  readonly snapshot: ConfigSnapshot;
  // The user's home, which a `~` in a listed or data path expands to.
  readonly home: string;
}

// [LAW:no-silent-failure] The layer `role` names in `snapshot`'s chain, or
// the click's refusal naming why it names none: a click never writes
// somewhere else.
export function writeLayerOf(
  snapshot: ConfigSnapshot,
  role: LayerRole,
  configFile: string | null,
  home: string,
): WriteLayer {
  const layer = snapshot.chain.find((l) => l.role === role);
  if (layer === undefined)
    throw new BadVerbArgs(
      `the ${role} layer is not writable: ${
        configFile !== null
          ? `${configFile} is the session's one config layer (it was named explicitly), so there is no ${role} layer to write`
          : `the ${role} layer is the project's, and this session has no approved project`
      }`,
    );
  if (!writable(layer.content))
    throw new BadVerbArgs(
      `the ${role} layer is not writable: ${layer.path} could not be read (${layer.content.error}), and a click does not write over a file it could not read`,
    );
  return { ...layer, snapshot, home };
}

// [LAW:one-source-of-truth] A write as its click sees it: each neighbouring
// layer read through the click, so a file the same click already changed or
// created reads as the click left it, and one it holds no text for is no
// layer. A click writes several files (a `do` across layers, an undo step), and
// each write is proved against the chain the click leaves, never the disk's.
// [LAW:effects-at-boundaries] Each held text keeps the definitions discovery
// read for its layer, so the loader proves a write from what discovery handed
// in, opening no file; a text listing one discovery did not read is refused
// by the loader, naming it.
interface Seen extends WriteLayer {
  readonly below: readonly HeldLayer[];
  readonly above: readonly HeldLayer[];
}
type HeldLayer = Layer & { readonly text: string };

const rank = (role: LayerRole): number => LAYER_ROLES.indexOf(role);

function seenBy(layer: WriteLayer, read: (file: string) => LayerContent): Seen {
  const held = (layers: readonly Layer[]): HeldLayer[] =>
    layers.flatMap((l) => {
      const text = requireLayerText(l.path, read(l.path));
      return text === null ? [] : [heldLayer(l, text)];
    });
  const { chain } = layer.snapshot;
  return {
    ...layer,
    below: held(chain.filter((l) => rank(l.role) < rank(layer.role))),
    above: held(chain.filter((l) => rank(l.role) > rank(layer.role))),
  };
}

function heldLayer(layer: Layer, text: string): HeldLayer {
  return {
    role: layer.role,
    path: layer.path,
    content: { kind: "text", text },
    listed: layer.listed,
    text,
  };
}

// The snapshot of a chain of held layers over the click's origin.
function heldSnapshot(
  into: Seen,
  layers: readonly HeldLayer[],
): ConfigSnapshot {
  return { ...into.snapshot, chain: layers };
}

// [LAW:one-source-of-truth] Every tracked write lands here, once, as the
// click's record of it. Returns the config the write's own load proved, which
// is what the session renders once the click lands.
// [LAW:single-enforcer] THE gate on what a click may write: text the loader
// accepts, proved by the loader itself — over the whole chain the file is
// the bottom of — before the file changes. A write that would not load (a
// copied group declared twice, a preset an action still targets, a segment a
// project layer places removed) is refused with the loader's own diagnosis,
// and the file — and everything the verb does after its write — stays as it
// was. `refuse` is what else the click promised: a value or layout click
// promises the bar changes (refuseHidden); a reset promises only that the
// written layer stops holding what it held, which a layer above cannot hide.
function commit(
  store: EditStore,
  into: Seen,
  before: string | null,
  after: string,
  refuse: (into: Seen, was: Was, will: LoadedChain) => void,
): DslConfig {
  const will = loadOrRefuse(into, after);
  // [LAW:one-source-of-truth] The file before the click is loaded at most
  // once, and only by a refusal that reads it; every refusal judges against
  // that one load.
  let held: { readonly chain: LoadedChain | null } | undefined;
  const was: Was = () => (held ??= { chain: loadedOrNull(into, before) }).chain;
  refuseNewDrops(into, was, will);
  refuse(into, was, will);
  store.record(into.path, before, after);
  return will.config;
}

// The chain the file before a click loads to, loaded when first asked; null
// when that file does not load.
type Was = () => LoadedChain | null;

// A write the written layer takes and a layer above hides would change the file and
// not the bar — refused, naming the layer that holds it.
function refuseHidden(into: Seen, was: Was, will: LoadedChain): void {
  const hidden = hiddenBy(into, was(), will);
  if (hidden.length > 0) {
    throw new BadVerbArgs(
      `refused: ${into.above.map((l) => l.path).join(", ")} sets ${hidden.join(", ")} over ${into.path}, so this click would change nothing on the bar — write it to that layer instead`,
    );
  }
}

const releases = (): void => {};

// [LAW:no-silent-failure] A structural read finds only what the written layer and the
// layers beneath it declare; what it misses may be a layer above's, which a
// write to that layer edits — the refusal says so rather than calling the bar
// stale.
function writtenOnly<T>(into: Seen, read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (!(e instanceof BadVerbArgs) || into.above.length === 0) throw e;
    throw new BadVerbArgs(
      `${e.message} — or it is declared by ${into.above.map((l) => l.path).join(", ")}, above it: write to that layer instead`,
    );
  }
}

// What the written layer's change would say that the chain above it would not draw.
// [LAW:types-are-the-program] A written layer that does not load now drew nothing a
// click could hide — the bar runs on its last good load — so a click that
// repairs it compares against no prior chain and hides nothing.
function hiddenBy(
  into: Seen,
  was: LoadedChain | null,
  will: LoadedChain,
): string[] {
  if (was === null) return [];
  const drawn = new Set(changedPaths(topConfig(was), topConfig(will)));
  return changedPaths(
    writtenConfig(into, was),
    writtenConfig(into, will),
  ).filter((p) => !drawn.has(p));
}

function loadedOrNull(into: Seen, text: string | null): LoadedChain | null {
  try {
    return chainOver(into, text);
  } catch (e) {
    if (e instanceof ConfigError) return null;
    throw e;
  }
}

// What the written file inherits: the merge of every layer beneath it, which
// each of its by-name reads looks through when the file itself is silent.
// [LAW:no-silent-failure] A layer beneath that does not load refuses the
// click, naming why, as the written file's own failure to load does.
function inheritedOf(into: Seen): DslConfig {
  try {
    return inheritedConfig(
      heldSnapshot(into, into.below),
      into.home,
      DEFAULT_DSL_CONFIG,
    );
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    throw new BadVerbArgs(
      `refused: a layer beneath ${into.path} does not load — ${e.message}`,
    );
  }
}

// The chain the written layer's text — or its absence — loads to, between
// the layers the click holds, exactly as discovery orders it: an existing
// file is a layer whatever it holds. The written text keeps the definitions
// discovery read for its layer, so a `plugins` entry discovery did not read
// for it refuses the write, naming the entry, until discovery has read it.
function chainOver(into: Seen, text: string | null): LoadedChain {
  const layers = [
    ...into.below,
    ...(text !== null ? [heldLayer(into, text)] : []),
    ...into.above,
  ];
  return loadSnapshot(
    heldSnapshot(into, layers),
    into.home,
    DEFAULT_DSL_CONFIG,
    { warned: () => {} },
  );
}

// The chain merged up to the written layer: each loaded layer is merged over
// the ones under it, and those are the same on both sides of a write, so a
// difference between two of these is the written layer's alone.
function writtenConfig(into: Seen, chain: LoadedChain): DslConfig {
  const upTo = new Set([...into.below.map((l) => l.path), into.path]);
  return (
    chain.layers.filter((l) => upTo.has(l.path)).at(-1)?.config ?? chain.base
  );
}

// An absent written layer reads as the chain's base — installed plugins included —
// never the bare bundled default, or an installed plugin's names would read
// as a change the written layer's write is hidden behind.
function topConfig(chain: LoadedChain): DslConfig {
  return chain.layers.at(-1)?.config ?? chain.base;
}

// [LAW:dataflow-not-control-flow] The dotted paths at which two configs
// differ, down to the first level where one side is not a plain object —
// one walk over the data, total over any pair.
function changedPaths(a: unknown, b: unknown, at = ""): string[] {
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
  }
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
    changedPaths(a[k], b[k], at === "" ? k : `${at}.${k}`),
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// [LAW:single-enforcer] The gate a text no verb loaded passes before a click
// writes it (a history step's, between the files as the step leaves them):
// the gate every write passes.
export function proveLoads(
  layer: WriteLayer,
  text: string | null,
  read: (file: string) => LayerContent,
): void {
  loadOrRefuse(seenBy(layer, read), text);
}

// The config `text` loads to as the written layer, or the click's refusal naming why
// it does not load.
function loadOrRefuse(into: Seen, text: string | null): LoadedChain {
  try {
    return chainOver(into, text);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    throw new BadVerbArgs(
      `refused: the config file would not load after this click — ${e.message}`,
    );
  }
}

// [LAW:no-silent-failure] The bar draws past a placement of a segment nothing
// declares, but a click never writes one: a write whose result drops a
// placement the file before it did not is refused with the loader's own
// diagnosis. A drop the file already held is the author's, and refusing every
// click over it would lock the bar's own controls. A file that does not load
// now has drops nobody can know — the bar runs on its last good load, as
// hiddenBy reads it — so a click that repairs it is not blamed for them.
function refuseNewDrops(into: Seen, was: Was, will: LoadedChain): void {
  if (will.dropped.length === 0) return;
  const prior = was();
  if (prior === null) return;
  const issuesOf = (chain: LoadedChain) =>
    chain.dropped.flatMap((e) =>
      e.issues.map((issue) => ({ file: e.file, issue })),
    );
  const held = new Set(
    issuesOf(prior).map(({ file, issue }) => `${file}\0${issue.message}`),
  );
  const added = issuesOf(will).filter(
    ({ file, issue }) => !held.has(`${file}\0${issue.message}`),
  );
  if (added.length > 0) {
    throw new BadVerbArgs(
      `refused: this click would leave a placement of a segment nothing declares — ${added.map(({ file, issue }) => new ConfigError(file, [issue]).message).join("\n")}`,
    );
  }
}

/** The scalar the file declares at a value target, or undefined. */
export function readValue(
  text: string | null,
  key: string,
): string | number | boolean | undefined {
  const target = requireValueTarget(key);
  const doc = docOf(text ?? "");
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
  into: WriteLayer,
  pairs: ReadonlyArray<readonly [key: string, raw: string]>,
): void {
  writeDrafts(store, into, pairs, []);
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
  layer: WriteLayer,
  pairs: ReadonlyArray<readonly [key: string, raw: string]>,
  placements: readonly PlacementValue[],
): void {
  const into = seenBy(layer, (file) => store.read(file));
  const before = requireLayerText(into.path, store.read(into.path));
  const under = inheritedOf(into);
  const valued = pairs.reduce(
    (text, [key, raw]) =>
      setValue(
        text,
        valuePathOf(docOf(text), under, requireValueTarget(key)),
        persistValueText(key, raw),
        JSON5_DIALECT,
      ),
    before ?? "",
  );
  commit(
    store,
    into,
    before,
    writtenOnly(into, () =>
      withPlacements(valued, under, into.path, placements, (text) => text),
    ),
    refuseHidden,
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
  under: DslConfig,
  file: string,
  placements: readonly PlacementValue[],
  own: (text: string, under: DslConfig, preset: string, id: string) => string,
): string {
  return placements.reduce((prior, { preset, id, setting, value }) => {
    const acc = own(prior, under, preset, id);
    const placement = layoutPlacementOf(docOf(acc), under, preset, id);
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
// when a layer other presets share supplies it — the file's `root` or an
// inherited row — so a value written into it is this preset's alone. A named
// row lands at `rows.<row>`, the unit the by-name cascade replaces; a whole
// tree replaces the preset's root outright.
// [LAW:no-silent-failure] A tree under a preset that already stages its own
// rows cannot be copied without discarding them: refused, never clobbered.
function ownRow(
  text: string,
  under: DslConfig,
  preset: string,
  id: string,
): string {
  const doc = docOf(text);
  const own: ConfigPath = ["presets", preset, "root"];
  for (const [row, { path, unit, node }] of cascadeOf(doc, under, preset)) {
    if (!hasSegmentRef(node, id)) continue;
    if (own.every((key, i) => path[i] === key)) return text;
    const rowText =
      unit === null ? movableTextOf(text, node) : json5Text(unit.value);
    if (row !== TREE_BLOCK) {
      return setValue(text, [...own, "rows", row], rowText, JSON5_DIALECT);
    }
    if (presetLayer(doc, under, preset) !== null) {
      throw new BadVerbArgs(
        `cannot give preset "${preset}" its own copy of ${path.join(".")}: it already stages rows of its own over that tree`,
      );
    }
    return setValue(text, own, rowText, JSON5_DIALECT);
  }
  return text;
}

// [LAW:one-source-of-truth] A preset this file authored is declared by its
// name alone — `presets.mine: {}` still offers `mine` — so a reset that empties
// it keeps the name; under a name the file inherits the entry is a delta, and
// an empty one prunes so the name tracks the inherited preset again.
function deleteAtPath(
  text: string,
  under: DslConfig,
  path: ConfigPath,
): string {
  const ownPreset =
    path[0] === "presets" &&
    path.length > 2 &&
    under.presets[path[1]!] === undefined;
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
  layer: WriteLayer,
  keys: readonly string[],
): void {
  const into = seenBy(layer, (file) => store.read(file));
  const targets = keys.map(requireTarget);
  const before = requireLayerText(into.path, store.read(into.path));
  if (before === null) return;
  const under = inheritedOf(into);
  const after = targets.reduce(
    (text, target) =>
      deleteAtPath(text, under, resetPathOf(docOf(text), under, target)),
    before,
  );
  if (after === before) return;
  commit(store, into, before, after, releases);
}

const SAVED_PRESET_PREFIX = "custom-";

function presetKeys(doc: Node | null): string[] {
  const declared = doc === null ? undefined : nodeAt(doc, ["presets"]);
  return declared?.kind === "object" ? declared.entries.map((e) => e.key) : [];
}

// [LAW:single-enforcer] The name a saved preset takes: the first `custom-N`
// no preset the chain will declare already holds — every one the file
// inherits, the file's own read from the very text the write lands in, and
// every layer's above it (a name another layer holds would merge the copy
// into its preset).
function freePresetName(
  doc: Node | null,
  under: DslConfig,
  into: Seen,
): string {
  const taken = new Set([
    ...Object.keys(under.presets),
    ...presetKeys(doc),
    // Each layer above as the loader reads it (JSON5, duplicate keys and
    // all) — the editor refuses files the loader renders.
    ...into.above.flatMap((l) =>
      Object.keys((JSON5.parse(l.text) as { presets?: object }).presets ?? {}),
    ),
  ]);
  // One more candidate than there are names, so one is always free.
  return Array.from(
    { length: taken.size + 1 },
    (_, i) => `${SAVED_PRESET_PREFIX}${i + 1}`,
  ).find((candidate) => !taken.has(candidate))!;
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
  layer: WriteLayer,
  from: string,
  globals: Globals,
  picks: ReadonlyArray<readonly [field: keyof Globals, raw: string]>,
  placements: ReadonlyArray<Omit<PlacementValue, "preset">>,
): string {
  const into = seenBy(layer, (file) => store.read(file));
  const before = requireLayerText(into.path, store.read(into.path));
  const doc = docOf(before ?? "");
  const under = inheritedOf(into);
  const name = freePresetName(doc, under, into);
  const own: ConfigPath = ["presets", name];
  const staged = writtenOnly(into, () => presetLayer(doc, under, from));
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
      valuePathOf(doc, under, requireValueTarget(key)),
      persistValueText(key, raw),
    ] as const;
  });
  const after = [...copied, ...pinned].reduce(
    (text, [at, value]) => setValue(text, at, value, JSON5_DIALECT),
    setValue(before ?? "", own, "{}", JSON5_DIALECT),
  );
  // The placements the session configured, each in a row the new preset
  // owns — never in a layer the preset it was copied from renders too.
  const placed = writtenOnly(into, () =>
    withPlacements(
      after,
      under,
      into.path,
      placements.map((p) => ({ ...p, preset: name })),
      ownRow,
    ),
  );
  commit(store, into, before, placed, refuseHidden);
  return name;
}

/**
 * A theme's default look, as ONE tracked write: `themeDefaults.<theme>` set
 * whole to `look`, so the entry says exactly the look the click saw. Every
 * field is written, a field equal to the floor included: the entry is the
 * default someone chose for that theme, and a floor that moves later must not
 * move it. The values are names as the session spells them; the commit's
 * load is what proves they are a theme default the loader accepts.
 */
export function writeThemeDefault(
  store: EditStore,
  layer: WriteLayer,
  theme: string,
  look: Readonly<Record<ThemeDefaultField, string>>,
): DslConfig {
  const into = seenBy(layer, (file) => store.read(file));
  const before = requireLayerText(into.path, store.read(into.path));
  const after = setValue(
    before ?? "",
    ["themeDefaults", theme],
    json5Text(look),
    JSON5_DIALECT,
  );
  return commit(store, into, before, after, refuseHidden);
}

/**
 * Delete a preset the file authors, as ONE tracked write — and the file's
 * `globals.preset` with it when that names it, since a default naming no
 * declared preset fails the load. Never a preset the file inherits: its
 * entry there is a delta the inherited preset survives, which `reset` owns.
 * Never a name the file does not declare: the stale click. What else the file
 * says about the preset (an action targeting it) is commit's to refuse.
 */
export function deletePreset(
  store: EditStore,
  layer: WriteLayer,
  name: string,
): void {
  const into = seenBy(layer, (file) => store.read(file));
  const under = inheritedOf(into);
  if (under.presets[name] !== undefined) {
    throw new BadVerbArgs(
      `cannot delete preset "${name}": a layer beneath ${into.path} declares it — reset its settings instead`,
    );
  }
  const own: ConfigPath = ["presets", name];
  const before = requireLayerText(into.path, store.read(into.path));
  const doc = docOf(before ?? "");
  if (before === null || doc === null || nodeAt(doc, own) === undefined) {
    throw new BadVerbArgs(
      `cannot delete preset "${name}": ${into.path} declares no ${own.join(".")} — the bar you clicked is stale; it reloads on the next render`,
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
    into,
    before,
    paths.reduce((text, at) => deleteAtPath(text, under, at), before),
    releases,
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
  layer: WriteLayer,
  key: string,
  op: LayoutOp,
): { readonly placed: NewPlacement | null; readonly config: DslConfig } {
  const into = seenBy(layer, (file) => store.read(file));
  const target = requireTarget(key);
  if (target.scope !== "preset-root") {
    throw new Error(`"${key}" is not a "presets.<name>.root" target`);
  }
  const before = requireLayerText(into.path, store.read(into.path));
  const subject = op.op === "remove" ? op.target : op.anchor;
  const under = inheritedOf(into);
  const placement = writtenOnly(into, () =>
    layoutPlacementOf(docOf(before ?? ""), under, target.preset, subject),
  );
  const authored = ensureAuthored(before ?? "", placement);
  const { after, placed } = spliceOp(authored, placement.path, op, () => {
    // [LAW:no-ambient-temporal-coupling] Minted over the text this click
    // splices, never a cached render of it: a hand edit, or a click an
    // instant earlier, is in the text before any watcher reloads it.
    const config = loadOrRefuse(into, authored).config;
    return presetNames(config.presets).map(
      (preset) => presetRoot(config, preset).node,
    );
  });
  if (after === null) {
    throw new BadVerbArgs(
      `${placement.path.join(".")} in ${into.path} has no placement "${subject}" — the bar you clicked is stale (it reloads on the next render), or the action names a placement the layout never held`,
    );
  }
  return { placed, config: commit(store, into, before, after, refuseHidden) };
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
