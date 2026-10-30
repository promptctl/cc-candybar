// [LAW:decomposition] A PLUGIN is another program's contribution to the bar:
// a DEFINITION file (json5, written once by the app's developer) declaring the
// plugin's variables, segments, helpers and actions, and the path of a DATA
// file (plain JSON, rewritten by the running app). This module turns the paths
// a config lists under `plugins:` into one layer of the merge — bundled <
// plugins < the user's file — and nothing else.
//
// [LAW:one-type-per-behavior] A plugin is not a new kind of anything. Its data
// is the existing `file` source with `parse: { json: true }`, watched, read in
// templates as `.<scope>.<plugin>.data.*`; its variables, segments, helpers and
// actions are parsed by the same validators a config's are; it joins the
// config through the same `mergeWithDefault` the user's file does.
//
// [LAW:no-silent-failure] A definition that does not load drops ONLY that
// plugin, and the drop is a typed fact on the result (`dropped`), which the
// daemon offers as a message beside the settings door and `cc-candybar check`
// fails on.

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import {
  hasCacheField,
  mapVariableTemplates,
  variableTemplates,
  type DslConfig,
  type RawDslConfig,
  type RawSegmentDecl,
  type SourceVarDecl,
  type VariableDecl,
} from "../dsl-types.js";
import {
  actionTemplates,
  mapActionTemplates,
  type ActionDecl,
} from "../action.js";
import { listResolvablePaletteNames } from "../../themes/policy.js";
import { ConfigError, type ConfigIssue } from "./diagnostics.js";
import { resolveUserPath } from "../../utils/user-path.js";
import { type Checkout } from "../../utils/git-root.js";
import type { ApprovedRepo } from "./repo-gate.js";
import {
  isPlainObject,
  describeType,
  type ValidateCtx,
} from "./validate-core.js";
import { mergeWithDefault } from "./merge.js";
import { validateSegments } from "./segments.js";
import { validateHelpers } from "./helpers.js";
import { validateActions } from "./actions.js";
import { validateVariables } from "./variables.js";
import { SYNTAX_ENGINE } from "./syntax-engine.js";
import {
  walkNodes,
  type SegmentNode,
  type SettingDecl,
  type SettingValue,
} from "../dsl-types.js";
import { presetNames, presetRoot } from "../presets.js";
import {
  bindSelf,
  templateActionRefs,
  templateHelperCalls,
  templateReads,
} from "./refs.js";
import {
  ownedBy,
  PLUGIN_SCOPES,
  pluginNs,
  scopeOf,
  SELF,
  type NamedDefinition,
  type PluginId,
  type PluginScope,
} from "./plugin-scope.js";

// A plugin that could not be loaded: its definition, and why. The rest of
// the config renders without it.
export type DroppedPlugin = PluginDefinition & { readonly reason: string };

export interface PluginLayer {
  // The base with every plugin that loaded merged over it, in listed order,
  // and a tombstone for every named one that did not.
  readonly config: DslConfig;
  readonly loaded: readonly PluginDefinition[];
  readonly dropped: readonly DroppedPlugin[];
  // Each plugin namespace the config renders, and the definition rendering it —
  // the layers beneath this one included, a nearer load or drop replacing a
  // farther one.
  readonly rendering: ReadonlyMap<string, NamedDefinition>;
}

// What a list of definitions lays itself over: a config, and the plugins it
// already renders.
export interface PluginBase {
  readonly config: DslConfig;
  readonly rendering: ReadonlyMap<string, NamedDefinition>;
}

// Why a name under a plugin scope names nothing: a drop, by its definition's path
// (its identity), and the notice a stand-in shows.
export interface DropCause {
  readonly definition: string;
  readonly notice: string;
}

// What a definition's paths resolve against beyond its own directory.
export interface PluginContext {
  // The session's project, once the user approved it: where the plugins it
  // ships live. Null where none is known or approved.
  readonly repo: ApprovedRepo | null;
  // The checkout the session works in, for a `data: { checkout }` path; null
  // where no session is known.
  readonly checkout: Checkout | null;
}

// The spelling of a drop, shared by the bar's diagnostics and `check`.
export function droppedPluginNotice(d: DroppedPlugin): string {
  return `plugin ${d.path} was not loaded: ${d.reason}`;
}

// [LAW:types-are-the-program] What a definition may say, every key optional.
// Everything else is a load error naming the field: a definition never edits
// `root` — placing its segments is the user's choice.
const DEFINITION_KEYS = new Set([
  "data",
  "sources",
  "variables",
  "segments",
  "helpers",
  "actions",
]);

// The file a plugin folder holds its definition in.
export const DEFINITION_FILE = "plugin.json5";

// A plugin name prefixes every name it declares, so it is one identifier
// segment: no dot (it would forge another plugin's namespace), nothing a
// template path cannot spell.
const PLUGIN_NAME = /^[a-z][a-z0-9_]*$/;

// A definition, named (plugin-scope.ts) or not: its name is undefined when its
// folder's name cannot be a plugin's.
export type PluginDefinition =
  | NamedDefinition
  | {
      readonly path: string;
      readonly scope: PluginScope;
      readonly name: undefined;
    };

// [LAW:single-enforcer] The one place a plugin's identity is minted. Its name
// is the name of the folder its definition sits in — installed or listed
// alike — so even a definition that cannot be read has one, and nothing
// inside the file can disagree with it; its scope is decided where the root
// or the listing config was found, and arrives here as data.
export function pluginDefinition(
  definition: string,
  scope: PluginScope,
): PluginDefinition {
  const name = path.basename(path.dirname(definition));
  return PLUGIN_NAME.test(name)
    ? { path: definition, scope, name }
    : { path: definition, scope, name: undefined };
}

// The variable a plugin's data file publishes, read as `.<ns>.data.*`.
export function pluginDataVar(ns: string): string {
  return `${ns}.data`;
}

// The folder a plugin's managed storage lives in: its program writes
// `<folder>/<session id>.json` there.
export const STORAGE_FOLDER = "session";

// [LAW:one-source-of-truth] The name of a session's file in a storage folder:
// the loader names it in its errors, the storage owner reads it.
export function sessionFileName(sessionId: string): string {
  return `${sessionId}.json`;
}

type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function attempt<T>(run: () => T): Attempt<T> {
  try {
    return { ok: true, value: run() };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

// A validator's message usually names its own path already; prefixing it
// again would print it twice.
function reasonOf(err: unknown): string {
  if (err instanceof ConfigError) {
    return err.issues
      .map((i) =>
        i.path === "" || i.message.includes(i.path)
          ? i.message
          : `${i.path}: ${i.message}`,
      )
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The definition paths a config lists under `plugins:`, absolute: a relative
 * path resolves against the directory of `from`, the file listing it, and `~`
 * against the home directory.
 */
export function listedPlugins(
  refs: readonly string[],
  from: string,
  scope: PluginScope,
): readonly PluginDefinition[] {
  return refs.map((ref) =>
    pluginDefinition(resolveUserPath(path.dirname(from), ref), scope),
  );
}

/**
 * Lay every definition over `base`, in order. A plugin replaces whatever a
 * layer beneath it declared under its namespace — a listed plugin replaces an
 * installed one of the same scope — so the nearest declaration wins whole and
 * two copies never merge; within one list a namespace is taken once.
 */
export function applyPlugins(
  definitions: readonly PluginDefinition[],
  ctx: PluginContext,
  base: PluginBase,
  // `replaces`: the layer held declarations under this plugin's namespace.
  validate: (config: DslConfig, ns: string, replaces: boolean) => unknown,
): PluginLayer {
  // [LAW:dataflow-not-control-flow] One fold, every definition: each step
  // either merges its plugin or records why not, and the next step sees the
  // result.
  const taken = new Map<string, string>();
  return definitions.reduce<PluginLayer>(
    (layer, definition) => {
      const file = definition.path;
      const ns =
        definition.name === undefined ? undefined : pluginNs(definition);
      const drop = (reason: string, config: DslConfig): PluginLayer => {
        const rendering = new Map(layer.rendering);
        if (ns !== undefined && config !== layer.config) rendering.delete(ns);
        return {
          ...layer,
          config,
          rendering,
          dropped: [...layer.dropped, { ...definition, reason }],
        };
      };
      if (path.basename(file) !== DEFINITION_FILE) {
        const reason = `a plugin is a folder holding its ${DEFINITION_FILE}, and the folder's name is the plugin's: move this file to <dir>/<name>/${DEFINITION_FILE} and list that`;
        // Named by its folder like any drop, so it tombstones its namespace.
        return drop(
          reason,
          ns === undefined
            ? layer.config
            : tombstone(withoutPlugin(layer.config, ns), ns, {
                ...definition,
                reason,
              }),
        );
      }
      if (definition.name === undefined || ns === undefined) {
        return drop(
          `its folder "${path.basename(path.dirname(file))}" is not a plugin name (one matching ${PLUGIN_NAME}: it prefixes every name the plugin declares)`,
          layer.config,
        );
      }
      const first = taken.get(ns);
      if (first !== undefined) {
        return drop(
          `plugin "${definition.name}" is already listed, from ${first}`,
          layer.config,
        );
      }
      taken.set(ns, file);
      const under = withoutPlugin(layer.config, ns);
      const merged = attempt(() => {
        const source = fs.readFileSync(file, "utf-8");
        const config = mergeWithDefault(
          fragmentOf(
            file,
            definition,
            { source, json: JSON5.parse(source) as unknown },
            ctx,
          ),
          under,
        );
        requireOneSourcePerFile(file, ns, config);
        validate(config, ns, under !== layer.config);
        return config;
      });
      if (merged.ok) {
        return {
          ...layer,
          config: merged.value,
          loaded: [...layer.loaded, definition],
          rendering: new Map([...layer.rendering, [ns, definition]]),
        };
      }
      const dropped = { ...definition, reason: merged.reason };
      return drop(merged.reason, tombstone(under, ns, dropped));
    },
    { config: base.config, rendering: base.rendering, loaded: [], dropped: [] },
  );
}

// The config with nothing of the plugin's left.
// The config itself when it held nothing there, so a caller can tell.
function withoutPlugin(config: DslConfig, plugin: string): DslConfig {
  const owned = ownedBy(plugin);
  const keep = <T>(r: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(Object.entries(r).filter(([name]) => !owned(name)));
  const held = [
    config.variables,
    config.segments,
    config.helpers,
    config.actions,
  ].some((r) => Object.keys(r).some(owned));
  if (!held) return config;
  return {
    ...config,
    variables: keep(config.variables),
    segments: keep(config.segments),
    helpers: keep(config.helpers),
    actions: keep(config.actions),
  };
}

// [LAW:no-silent-failure] A dropped plugin still owns its namespace: the
// namespace is a document that IS the drop, declared at the namespace itself
// [LAW:one-source-of-truth], so every read under it — its data, its sources,
// its variables, the user's own, a stand-in's — renders ⚠ naming why.
function tombstone(
  config: DslConfig,
  ns: string,
  dropped: DroppedPlugin,
): DslConfig {
  return {
    ...config,
    variables: {
      ...config.variables,
      [ns]: {
        kind: "dropped",
        reason: droppedPluginNotice(dropped),
        definition: dropped.path,
      },
    },
  };
}

// The tombstone a name falls under, with the namespace it stands at: matched
// against the namespaces the config holds a tombstone at, never parsed out of
// the name. [LAW:dataflow-not-control-flow] Every scope reads alike, and none
// falls back to another: a missing `repo.lit.x` never resolves through
// `plugins.lit`.
function tombstonesOf(
  config: DslConfig,
): (name: string) => (DropCause & { readonly ns: string }) | undefined {
  const tombstones = Object.entries(config.variables).flatMap(([ns, v]) =>
    v.kind === "dropped"
      ? [{ ns, definition: v.definition, notice: v.reason }]
      : [],
  );
  return (name) => tombstones.find(({ ns }) => ownedBy(ns)(name));
}

// Why a name under a plugin scope names nothing: the drop notice of the plugin
// whose namespace it is — its tombstone — or, when no plugin of that scope
// renders that namespace, every drop of the same scope that has no name (a
// folder whose name is not a plugin's). A name outside every plugin scope, or
// under a plugin that loaded, belongs to no drop.
export function dropsOwning(
  layer: PluginLayer,
  // Every drop of the layers beneath this one. A named one's tombstone is
  // already in `layer`; the unnamed ones (a folder whose name is not a
  // plugin's) are known only from here.
  beneath: readonly DroppedPlugin[],
): (name: string) => readonly DropCause[] {
  const tombstoned = tombstonesOf(layer.config);
  const rendering = [...layer.rendering.keys()].map(ownedBy);
  // [LAW:one-source-of-truth] An unnamed drop carries the scope it was found
  // in, so it answers only for names in that scope.
  const unnamed = [...beneath, ...layer.dropped].filter(
    (d) => d.name === undefined,
  );
  return (name) => {
    const scope = scopeOf(name);
    if (scope === undefined) return [];
    const cause = tombstoned(name);
    if (cause !== undefined)
      return [{ definition: cause.definition, notice: cause.notice }];
    if (rendering.some((owns) => owns(name))) return [];
    return unnamed
      .filter((d) => d.scope === scope)
      .map((d) => ({ definition: d.path, notice: droppedPluginNotice(d) }));
  };
}

/**
 * Every segment of a dropped plugin the config still names — a placement, or
 * a by-field retune — stands in as a cell saying the plugin did not load,
 * rather than failing the whole config. The stand-in declares each setting
 * its placements set, so they still validate; it is re-derived on every
 * layer, so a nearer layer's placement widens it. An action or helper of a
 * dropped plugin the config reaches — a template's binding or call, a `do`
 * member — stands in the same way. `reached` is the definition path of every
 * drop a stand-in stands for: the drops this config actually asks for.
 */
export function withDroppedPlacements(
  config: DslConfig,
  owning: (name: string) => readonly DropCause[],
  // [LAW:one-type-per-behavior] The segments the layer's own `insert` cells
  // place: a placement like any in a tree, so a dropped plugin's cell stands
  // in and reaches its drop the same way. A lower layer's cells reach theirs
  // on that layer, and its stand-ins carry up through `segments`.
  inserted: readonly string[],
): { readonly config: DslConfig; readonly reached: ReadonlySet<string> } {
  const placements = presetNames(config.presets)
    .flatMap((preset) => [...walkNodes(presetRoot(config, preset).node)])
    .flatMap((node) => (node.kind === "segment" ? [node] : []));
  const names = new Set([
    ...placements.map((n) => n.name),
    ...inserted,
    ...Object.keys(config.segments),
  ]);
  // A name a drop owns has no declaration but a stand-in (the drop removed
  // the plugin's own), so each layer derives it afresh.
  const caused = [...names]
    .map((name) => ({ name, cause: owning(name) }))
    .filter(({ cause }) => cause.length > 0);
  const standIns = Object.fromEntries(
    caused.map(({ name, cause }) => [
      name,
      standIn(
        name,
        cause.map((c) => c.notice),
        placements.filter((n) => n.name === name),
      ),
    ]),
  );
  const tombstoned = tombstonesOf(config);
  // No tombstone, nothing to stand in for — the common load skips the walk.
  const anyTombstone = Object.values(config.variables).some(
    (v) => v.kind === "dropped",
  );
  const templates = anyTombstone
    ? Object.values(config.segments).flatMap((seg) =>
        SEGMENT_TEMPLATE_FIELDS.flatMap((f) =>
          seg[f] === undefined ? [] : [seg[f]],
        ),
      )
    : [];
  const doMembers = anyTombstone
    ? Object.values(config.actions).flatMap((a) => ("do" in a ? [...a.do] : []))
    : [];
  const missing = (
    names: readonly string[],
    declared: Readonly<Record<string, unknown>>,
  ): ReadonlyArray<readonly [string, DropCause & { readonly ns: string }]> =>
    [...new Set(names)].flatMap((name) => {
      const cause = name in declared ? undefined : tombstoned(name);
      return cause === undefined ? [] : [[name, cause] as const];
    });
  const actionStandIns = missing(
    [
      ...templates.flatMap((t) =>
        templateActionRefs(t, config.helpers).map((r) => r.name),
      ),
      ...doMembers,
    ],
    config.actions,
  );
  const helperStandIns = missing(
    templates.flatMap((t) => [...templateHelperCalls(t, config.helpers)]),
    config.helpers,
  );
  // [LAW:dataflow-not-control-flow] A run's `refreshes` naming a dropped
  // plugin's source loses that name: the plugin brings no source this load,
  // so the click has nothing of it to make stale, and the run is still the
  // config's own.
  const lowered = Object.entries(config.actions).flatMap(([name, a]) => {
    if (!("run" in a)) return [];
    const gone = new Map(missing(a.refreshes, config.variables));
    return gone.size === 0
      ? []
      : [
          {
            name,
            action: {
              ...a,
              refreshes: a.refreshes.filter((r) => !gone.has(r)),
            },
            causes: [...gone.values()],
          },
        ];
  });
  const reached = new Set([
    ...caused.flatMap(({ cause }) => cause.map((c) => c.definition)),
    ...[...actionStandIns, ...helperStandIns].map(([, c]) => c.definition),
    ...lowered.flatMap(({ causes }) => causes.map((c) => c.definition)),
  ]);
  return {
    config: {
      ...config,
      segments: { ...config.segments, ...standIns },
      // An action's copy reads the tombstone: the cell binding it renders ⚠
      // with the drop.
      actions: {
        ...config.actions,
        ...Object.fromEntries(
          lowered.map(({ name, action }) => [name, action]),
        ),
        ...Object.fromEntries(
          actionStandIns.map(([name, { ns }]) => [
            name,
            { copy: `{{ .${ns} }}` },
          ]),
        ),
      },
      // A helper is called with the caller's dot, so its stand-in cannot
      // read the tombstone by path: the drop's notice is baked in.
      helpers: {
        ...config.helpers,
        ...Object.fromEntries(
          helperStandIns.map(([name, c]) => [
            name,
            `{{ fail ${JSON.stringify(c.notice)} }}`,
          ]),
        ),
      },
    },
    reached,
  };
}

function standIn(
  name: string,
  cause: readonly string[],
  placements: readonly SegmentNode[],
): DslConfig["segments"][string] {
  const text = `⚠ ${name}: ${cause.join("; ")}`;
  const values = new Map<string, NonEmpty<SettingValue>>();
  for (const n of placements) {
    for (const [key, value] of Object.entries(n.settings ?? {})) {
      const prev = values.get(key);
      values.set(key, prev === undefined ? [value] : [...prev, value]);
    }
  }
  const settings = Object.fromEntries(
    [...values].map(([key, vs]) => [key, settingFor(key, vs)]),
  );
  return {
    template: `{{ ${JSON.stringify(text)} }}`,
    bg: "error",
    description: "stands in for a segment whose plugin did not load",
    settings,
  };
}

type NonEmpty<T> = readonly [T, ...T[]];

// The narrowest declaration every value the placements set is a member of,
// typed by the first; a placement setting another type still fails the load.
function settingFor(
  label: string,
  values: NonEmpty<SettingValue>,
): SettingDecl {
  const [first] = values;
  const numbers = values.filter((v) => typeof v === "number");
  return typeof first === "boolean"
    ? { label, domain: "bool", default: first }
    : typeof first === "number"
      ? {
          label,
          domain: {
            min: Math.min(...numbers),
            max: Math.max(...numbers),
            step: 1,
          },
          default: first,
        }
      : {
          label,
          domain: [...new Set(values.map(String))],
          default: first,
        };
}

// The raw fragment one parsed definition contributes, every name under its
// `<plugin>.` namespace. Throws on any problem; the fold above turns the throw
// into a drop.
function fragmentOf(
  file: string,
  id: PluginId,
  { source, json }: { readonly source: string; readonly json: unknown },
  { checkout }: PluginContext,
): RawDslConfig {
  const ns = pluginNs(id);
  const issues: ConfigIssue[] = [];
  const fail = (): never => {
    throw new ConfigError(file, issues);
  };
  if (!isPlainObject(json)) {
    issues.push({
      path: "",
      message: `a plugin definition must be an object, got ${describeType(json)}`,
    });
    return fail();
  }
  for (const key of Object.keys(json)) {
    if (!DEFINITION_KEYS.has(key)) {
      issues.push({
        path: key,
        message:
          key === "plugin"
            ? `a plugin definition does not name itself: its name is its folder's ("${path.basename(path.dirname(file))}") — remove "plugin"`
            : `a plugin definition may not declare "${key}". Expected only: ${[...DEFINITION_KEYS].join(", ")}`,
      });
    }
  }
  // [LAW:types-are-the-program] `data` is optional: a definition without it
  // declares no data variable.
  const dataPath =
    json.data === undefined
      ? undefined
      : dataPathOf(json.data, file, checkout, issues);
  const sources =
    json.sources === undefined ? {} : sourcesOf(json.sources, file, issues);
  if (issues.length > 0) return fail();

  const ctx: ValidateCtx = {
    source,
    issues,
    allowedPalettes: new Set(listResolvablePaletteNames()),
    groups: [],
    unplaced: [],
    inherited: [],
  };
  // [LAW:one-source-of-truth] The data variable is parsed by the validator
  // every `file` source goes through, from the declaration a user would write.
  // Its `{}` default is what a missing data file reads as: no fields, which a
  // segment gates on (`hasKey`); malformed data is not a missing file and
  // reads as the failure (⚠).
  const data =
    dataPath === undefined
      ? {}
      : validateVariables(ctx, "data", {
          [pluginDataVar(ns)]: {
            kind: "file",
            path: dataPath,
            parse: { json: true },
            cache: { watch_file: dataPath },
            default: {},
          },
        });
  // [LAW:one-type-per-behavior] A plugin's variables are a user config's
  // `variables:`, parsed by the same validator, named under its namespace.
  const variables = validateVariables(ctx, "variables", json.variables);
  // [LAW:one-source-of-truth] `.<ns>.data` is the data file's,
  // whether or not `data` is declared.
  for (const [table, names] of [
    ["variables", Object.keys(variables)],
    ["sources", Object.keys(sources)],
  ] as const) {
    if (names.includes("data")) {
      issues.push({
        path: `${table}.data`,
        message: `"data" names the plugin's data file (.${pluginDataVar(ns)}), declared by the definition's own "data" key: give this ${table === "sources" ? "source" : "variable"} another name`,
      });
    }
  }
  // [LAW:one-source-of-truth] A source's name is its variable's: one name
  // under `<ns>.` is one declaration.
  for (const name of Object.keys(sources)) {
    if (Object.hasOwn(variables, name)) {
      issues.push({
        path: `sources.${name}`,
        message: `source "${name}" and variable "${name}" are one name (.${ns}.${name}): give one of them another name`,
      });
    }
  }
  // The definition as written: its own names spelled `self`.
  const authored: RawDslConfig = {
    variables: {
      ...data,
      ...prefixed(ns, sources),
      ...prefixed(
        ns,
        Object.fromEntries(
          Object.entries(variables).map(([name, decl]) => [
            name,
            stateKeyUnder(ns, decl),
          ]),
        ),
      ),
    },
    segments: prefixed(
      ns,
      stateKeysUnder(ns, validateSegments(ctx, json.segments, new Set())),
    ),
    helpers: prefixed(ns, validateHelpers(ctx, json.helpers)),
    // [LAW:one-source-of-truth] A plugin's `run` runs in its folder, the
    // real path its storage is resolved under.
    actions: prefixed(
      ns,
      setKeysUnder(
        ns,
        validateActions(ctx, json.actions, {
          dir: fs.realpathSync(path.dirname(file)),
        }),
      ),
    ),
  };
  issues.push(...wrongScopeRefs(authored, id));
  const fragment = boundToSelf(ns, authored);
  // [LAW:single-enforcer] Template syntax is otherwise first parsed by the
  // compile, after every plugin has merged — too late to drop just this one.
  for (const [where, template] of fragmentTemplates(fragment)) {
    try {
      SYNTAX_ENGINE.parse(template);
    } catch (e) {
      issues.push({
        path: where,
        message: `Template parse error in ${where}: ${(e as Error).message}`,
      });
    }
  }
  if (issues.length > 0) fail();
  return fragment;
}

// [LAW:one-source-of-truth] A plugin names itself `self` — `.self.data`,
// `{{ template "self.state" }}`, `do: ["self.close"]` — and the loader binds
// that to the namespace it loads under, exactly as it binds its bare session
// keys and `refreshes`: so one definition loads alike from a repository
// (`repo.<name>`) and from an install (`plugins.<name>`), and `plugin
// install` copying a repository's plugin into the user's root changes
// nothing about it. Bound on the declarations' own template fields and `do`
// names, each template through the reference lexer every load question asks.
function boundToSelf(ns: string, fragment: RawDslConfig): RawDslConfig {
  const bind = (template: string): string => bindSelf(template, SELF, ns);
  const named = (name: string): string =>
    ownedBy(SELF)(name) ? `${ns}${name.slice(SELF.length)}` : name;
  const each = <T>(
    table: Readonly<Record<string, T>> | undefined,
    f: (value: T) => T,
  ): Record<string, T> =>
    Object.fromEntries(
      Object.entries(table ?? {}).map(([name, value]) => [name, f(value)]),
    );
  return {
    ...fragment,
    variables: each(fragment.variables, (v) =>
      selfDepends(mapVariableTemplates(v, bind), named),
    ),
    segments: each(fragment.segments, (seg) => ({
      ...seg,
      ...Object.fromEntries(
        SEGMENT_TEMPLATE_FIELDS.flatMap((f) =>
          seg[f] === undefined ? [] : [[f, bind(seg[f])]],
        ),
      ),
      ...(seg.vars !== undefined && {
        vars: each(seg.vars, (v) =>
          selfDepends(mapVariableTemplates(v, bind), named),
        ),
      }),
    })),
    helpers: each(fragment.helpers, bind),
    actions: each(fragment.actions, (a) =>
      mapActionNames(mapActionTemplates(a, bind), named),
    ),
  };
}

// A variable's `cache.depends_on` names variables, so `self` binds there as
// it does in a `do` list.
function selfDepends(
  v: VariableDecl,
  named: (name: string) => string,
): VariableDecl {
  return hasCacheField(v) && "depends_on" in v.cache
    ? ({
        ...v,
        cache: { depends_on: v.cache.depends_on.map(named) },
      } as VariableDecl)
    : v;
}

// [LAW:one-source-of-truth] Every field of an action that names an action or
// a segment — a `do` member, a layout edit's segment and anchor, a persist
// path into `segments.` — mapped through `f`: `self` binds there, and the
// wrong-scope check reads the same fields.
function mapActionNames(
  a: ActionDecl,
  f: (name: string, field: string) => string,
): ActionDecl {
  const seg = "segments.";
  const out: Record<string, unknown> = { ...a };
  if ("do" in a) out.do = a.do.map((m) => f(m, "do"));
  for (const field of ["removeSegment", "insertSegment", "anchor"] as const)
    if (field in a)
      out[field] = f((a as Record<string, string>)[field]!, field);
  if ("persist" in a && a.persist.startsWith(seg))
    out.persist = seg + f(a.persist.slice(seg.length), "persist");
  return out as ActionDecl;
}

// The template fields a segment declaration carries.
const SEGMENT_TEMPLATE_FIELDS = ["template", "bg", "fg", "when"] as const;

// [LAW:no-silent-failure] A plugin that spells its own name under the scope
// it did not load in — a repository's `lit` reading `.plugins.lit.data` —
// would read nothing, or another plugin's names. Its load says so, naming the
// scope-free spelling that loads in both.
function wrongScopeRefs(
  fragment: RawDslConfig,
  id: PluginId,
): readonly ConfigIssue[] {
  const helpers = fragment.helpers ?? {};
  const elsewhere = PLUGIN_SCOPES.filter((s) => s !== id.scope).map(
    (scope) => ({ scope, ns: pluginNs({ scope, name: id.name }) }),
  );
  const issues = new Map<string, ConfigIssue>();
  const check = (where: string, ref: string, read: boolean): void => {
    const other = elsewhere.find(({ ns }) => ownedBy(ns)(ref));
    if (other === undefined) return;
    const dot = read ? "." : "";
    issues.set(`${where}\0${ref}`, {
      path: where,
      message: `${where} names ${dot}${ref}, this plugin under "${other.scope}", but it loads as ${pluginNs(id)}: a plugin names itself without its scope — write ${dot}${SELF}${ref.slice(other.ns.length)}`,
    });
  };
  const templates: Array<readonly [string, string]> = [
    ...[...fragmentTemplates(fragment)].filter(
      ([where]) => !where.startsWith("helpers."),
    ),
    ...Object.entries(helpers).map(
      ([name, body]) => [`helpers.${name}`, body] as const,
    ),
  ];
  // A read or binding a helper's body spells is reported at that helper.
  for (const [where, template] of templates) {
    for (const [ref, via] of templateReads(template, helpers))
      if (via === null) check(where, ref, true);
    for (const { name, via } of templateActionRefs(template, helpers))
      if (via === null) check(where, name, false);
    // Its own calls only: a call inside a helper's body is that helper's.
    for (const name of templateHelperCalls(template, {}))
      check(where, name, false);
  }
  for (const [name, a] of Object.entries(fragment.actions ?? {})) {
    mapActionNames(a, (ref, field) => {
      check(`actions.${name}.${field}`, ref, false);
      return ref;
    });
  }
  const variables = [
    ...Object.entries(fragment.variables ?? {}).map(
      ([name, v]) => [`variables.${name}`, v] as const,
    ),
    ...Object.entries(fragment.segments ?? {}).flatMap(([seg, decl]) =>
      Object.entries(decl.vars ?? {}).map(
        ([name, v]) => [`segments.${seg}.vars.${name}`, v] as const,
      ),
    ),
  ];
  for (const [where, v] of variables) {
    if (hasCacheField(v) && "depends_on" in v.cache)
      for (const d of v.cache.depends_on)
        check(`${where}.cache.depends_on`, d, false);
  }
  return [...issues.values()];
}

function* fragmentTemplates(
  fragment: RawDslConfig,
): IterableIterator<readonly [string, string]> {
  for (const [name, v] of Object.entries(fragment.variables ?? {})) {
    for (const [field, t] of variableTemplates(v)) {
      yield [`variables.${name}.${field}`, t];
    }
  }
  for (const [name, seg] of Object.entries(fragment.segments ?? {})) {
    for (const field of SEGMENT_TEMPLATE_FIELDS) {
      const t = seg[field];
      if (t !== undefined) yield [`segments.${name}.${field}`, t];
    }
    for (const [varName, v] of Object.entries(seg.vars ?? {})) {
      for (const [field, t] of variableTemplates(v)) {
        yield [`segments.${name}.vars.${varName}.${field}`, t];
      }
    }
  }
  for (const [name, body] of Object.entries(fragment.helpers ?? {})) {
    yield [`helpers.${name}`, `{{ define "${name}" }}${body}{{ end }}`];
  }
  for (const [name, a] of Object.entries(fragment.actions ?? {})) {
    for (const [field, source] of actionTemplates(a)) {
      yield [`actions.${name}.${field}`, source];
    }
  }
}

function prefixed<T>(
  ns: string,
  decls: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(decls).map(([name, d]) => [`${ns}.${name}`, d]),
  );
}

// [LAW:one-source-of-truth] A plugin's SESSION keys live under its namespace
// exactly as its NAMES do: the `key` of every `state` variable it or its
// segments declare and the `set` of every action, so a `set` can neither clash
// with a session key the user's file or another plugin declares (a kind clash
// there would fail the whole load, not drop the plugin) nor write one the bar
// owns (`edit.mode`, `candybar.tab`). The author writes the bare key on both
// sides and the two meet under `<ns>.`; a `set` outside the namespace is
// unrepresentable, not refused. A `persist`'s or `reset`'s target is a path in
// the user's config file, not a session key, and is left as written.
function keyUnder(ns: string, key: string): string {
  return `${ns}.${key}`;
}

function stateKeyUnder(ns: string, decl: VariableDecl): VariableDecl {
  return decl.kind === "state"
    ? { ...decl, key: keyUnder(ns, decl.key) }
    : decl;
}

function stateKeysUnder(
  ns: string,
  segments: Readonly<Record<string, RawSegmentDecl>>,
): Record<string, RawSegmentDecl> {
  return Object.fromEntries(
    Object.entries(segments).map(([name, seg]) => [
      name,
      seg.vars === undefined
        ? seg
        : {
            ...seg,
            vars: Object.fromEntries(
              Object.entries(seg.vars).map(([v, decl]) => [
                v,
                stateKeyUnder(ns, decl),
              ]),
            ),
          },
    ]),
  );
}

// [LAW:one-source-of-truth] A `run`'s `refreshes` name the plugin's own
// sources bare, and meet them under the namespace the same way: a plugin's
// run can refresh only its own sources.
function setKeysUnder(
  ns: string,
  actions: Readonly<Record<string, ActionDecl>>,
): Record<string, ActionDecl> {
  return Object.fromEntries(
    Object.entries(actions).map(([name, a]) => [
      name,
      "set" in a
        ? { ...a, set: keyUnder(ns, a.set) }
        : "run" in a
          ? { ...a, refreshes: a.refreshes.map((r) => keyUnder(ns, r)) }
          : a,
    ]),
  );
}

// A source's name is one identifier, like a plugin's: `<scope>.<plugin>.<source>`
// is then its full name and its payload path.
const SOURCE_NAME = PLUGIN_NAME;

// [LAW:types-are-the-program] The one source the API builds: a session's
// document, re-read when its file changes, read from the plugin's managed
// storage. Each field is spelled exactly as authored, so anything else — a
// scope, trigger or reader the design names but this build lacks, a `file`
// with a path — is refused naming the field and what is built.
const BUILT_SOURCE = {
  scope: "session",
  refresh: { watch: true },
  read: { file: { json: true } },
} as const;

// [LAW:parse-dont-validate] A definition's `sources:`, each lowered to the
// variable that reads it: a session's document in the plugin's managed
// storage, the folder `<plugin folder real path>/session`. The real path, so a
// linked plugin folder replaced by an install is another folder.
function sourcesOf(
  sources: unknown,
  file: string,
  issues: ConfigIssue[],
): Record<string, SourceVarDecl> {
  if (!isPlainObject(sources)) {
    issues.push({
      path: "sources",
      message: `"sources" must be an object of named sources, got ${describeType(sources)}`,
    });
    return {};
  }
  const storage = path.join(
    fs.realpathSync(path.dirname(file)),
    STORAGE_FOLDER,
  );
  const built = JSON.stringify(BUILT_SOURCE);
  const lowered: Record<string, SourceVarDecl> = {};
  for (const [name, source] of Object.entries(sources)) {
    const at = `sources.${name}`;
    if (!SOURCE_NAME.test(name)) {
      issues.push({
        path: at,
        message: `source name "${name}" is not one identifier (one matching ${SOURCE_NAME}: it is the last segment of .<scope>.<plugin>.${name})`,
      });
      continue;
    }
    const wrong = unbuilt(source, BUILT_SOURCE, at);
    for (const { field, is } of wrong) {
      issues.push({
        path: field,
        message: `${field} ${is}: what is built is a source ${built} — a session's JSON file in the plugin's managed storage, re-read when it changes`,
      });
    }
    if (wrong.length === 0) lowered[name] = { kind: "source", storage };
  }
  return lowered;
}

// [LAW:one-source-of-truth] [LAW:types-are-the-program] A session's file in a
// storage folder is one document, so it has one name. Sources that would read
// the same file — two of one plugin's, or another plugin's whose folder is the
// same real folder — drop the plugin that brings the second name, naming every
// source and the file. The rule is over the file each source resolves to, not
// a count per plugin.
function requireOneSourcePerFile(
  file: string,
  plugin: string,
  config: DslConfig,
): void {
  const readers = Object.entries(config.variables).reduce(
    (byFile, [name, v]) => {
      if (v.kind !== "source") return byFile;
      const read = sourceFileOf(v);
      return byFile.set(read, [...(byFile.get(read) ?? []), name]);
    },
    new Map<string, readonly string[]>(),
  );
  const owned = ownedBy(plugin);
  const issues = [...readers]
    .filter(([, names]) => names.length > 1 && names.some(owned))
    .map(([read, names]) => ({
      path: `sources.${names.find(owned)!.slice(`${plugin}.`.length)}`,
      message: `sources ${names.map((n) => `.${n}`).join(" and ")} read the same file, ${read}: a session's file is one document, read by one source`,
    }));
  if (issues.length > 0) throw new ConfigError(file, issues);
}

// The file a source reads, spelled for any session.
function sourceFileOf(source: SourceVarDecl): string {
  return path.join(source.storage, sessionFileName("<session id>"));
}

// Every field where `authored` departs from `built`, at its deepest: a field
// the build has no such thing as, one it lacks, or another value.
function unbuilt(
  authored: unknown,
  built: unknown,
  at: string,
): ReadonlyArray<{ readonly field: string; readonly is: string }> {
  if (!isPlainObject(built) || !isPlainObject(authored)) {
    return JSON.stringify(authored) === JSON.stringify(built)
      ? []
      : [{ field: at, is: `is ${JSON.stringify(authored)}` }];
  }
  return [
    ...new Set([...Object.keys(built), ...Object.keys(authored)]),
  ].flatMap((key) => {
    const field = `${at}.${key}`;
    if (!Object.hasOwn(built, key)) return [{ field, is: "is not built" }];
    if (!Object.hasOwn(authored, key)) return [{ field, is: "is missing" }];
    return unbuilt(authored[key], built[key], field);
  });
}

// [LAW:types-are-the-program] Where a plugin's data lives: a path relative to
// its definition (an app that keeps one state file), or `{ checkout }`, a path
// relative to the root of the git checkout the session works in — one
// installed definition, a data file per checkout (lit writes
// `<checkout>/.lit/statusline.json`). A linked worktree is its own checkout,
// so a worktree session reads the worktree's file, not the main repo's: the
// session's project is the repo it was opened in, which for a worktree is the
// main checkout. A working directory in no checkout is its own root.
function dataPathOf(
  data: unknown,
  file: string,
  checkout: Checkout | null,
  issues: ConfigIssue[],
): string | undefined {
  if (typeof data === "string" && data !== "") {
    return resolveUserPath(path.dirname(file), data);
  }
  if (
    isPlainObject(data) &&
    Object.keys(data).length === 1 &&
    typeof data.checkout === "string" &&
    data.checkout !== ""
  ) {
    // Inside the checkout, always: one installed definition reads every
    // checkout's own file, never a path that leaves it.
    const rel = data.checkout;
    if (
      path.isAbsolute(rel) ||
      rel.startsWith("~") ||
      path.normalize(rel).split(path.sep)[0] === ".."
    ) {
      issues.push({
        path: "data.checkout",
        message: `data.checkout "${rel}" must be a path inside the checkout, relative to its root (like ".lit/statusline.json"): no absolute path, "~" or ".."`,
      });
      return undefined;
    }
    if (checkout === null) {
      issues.push({
        path: "data.checkout",
        message: `data is read from the session's checkout, and this load has no session`,
      });
      return undefined;
    }
    return path.resolve(checkout.root, rel);
  }
  // [LAW:no-silent-failure] `{ project }` was this field's spelling until
  // `{ checkout }` replaced it (brandon-plugins-ktag.d6f).
  if (isPlainObject(data) && "project" in data) {
    issues.push({
      path: "data.project",
      message: `data: { project } is now data: { checkout }: the same path, relative to the root of the git checkout the session works in (a linked worktree is its own checkout)`,
    });
    return undefined;
  }
  issues.push({
    path: "data",
    message: `"data" must be the path of the plugin's JSON data file relative to this definition, or { checkout: "<path>" } relative to the root of the session's checkout`,
  });
  return undefined;
}
