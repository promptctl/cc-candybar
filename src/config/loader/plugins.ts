// [LAW:decomposition] A PLUGIN is another program's contribution to the bar:
// a DEFINITION file (json5, written once by the app's developer) naming the
// plugin, its segments, helpers and actions, and the path of a DATA file (plain
// JSON, rewritten by the running app). This module turns the paths a config
// lists under `plugins:` into one layer of the merge — bundled < plugins <
// the user's file — and nothing else.
//
// [LAW:one-type-per-behavior] A plugin is not a new kind of anything. Its data
// is the existing `file` source with `parse: { json: true }`, watched, read in
// templates as `.plugins.<plugin>.data.*`; its segments, helpers and actions are parsed
// by the same validators a config's are; it joins the config through the same
// `mergeWithDefault` the user's file does.
//
// [LAW:no-silent-failure] A definition that does not load drops ONLY that
// plugin, and the drop is a typed fact on the result (`dropped`), which the
// daemon shows on the diagnostic strip and `cc-candybar check` fails on.

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { type DslConfig, type RawDslConfig } from "../dsl-types.js";
import { listResolvablePaletteNames } from "../../themes/policy.js";
import { ConfigError, type ConfigIssue } from "./diagnostics.js";
import { expandHome } from "./discovery.js";
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
import { templateActionRefs } from "./refs.js";

// A plugin that could not be loaded: its definition's path, its name (its
// folder's, undefined when the folder's name cannot be one), and why. The rest of the config renders without it.
export interface DroppedPlugin {
  readonly path: string;
  readonly plugin: string | undefined;
  readonly reason: string;
}

export interface PluginLayer {
  // The base with every plugin that loaded merged over it, in listed order,
  // and a tombstone for every named one that did not.
  readonly config: DslConfig;
  readonly loaded: readonly string[];
  readonly dropped: readonly DroppedPlugin[];
}

// What a definition's paths resolve against beyond its own directory.
export interface PluginContext {
  // The session's project, for a `data: { project }` path; null where no
  // project is known.
  readonly projectDir: string | null;
}

// The spelling of a drop, shared by the diagnostic strip and `check`.
export function droppedPluginNotice(d: DroppedPlugin): string {
  return `plugin ${d.path} was not loaded: ${d.reason}`;
}

// [LAW:types-are-the-program] What a definition may say. Everything else is a
// load error naming the field: a definition declares no sources of its own
// (no shell), so loading one from a cloned repo runs nothing, and it never
// edits `root` — placing its segments is the user's choice.
const DEFINITION_KEYS = new Set(["data", "segments", "helpers", "actions"]);

// The file a plugin folder holds its definition in.
export const DEFINITION_FILE = "plugin.json5";

// A plugin name prefixes every name it declares, so it is one identifier
// segment: no dot (it would forge another plugin's namespace), nothing a
// template path cannot spell.
const PLUGIN_NAME = /^[a-z][a-z0-9_]*$/;

// [LAW:one-source-of-truth] A plugin's name is the name of the folder its
// definition sits in — installed or listed alike — so even a definition that
// cannot be read has one, and nothing inside the file can disagree with it.
// Undefined when the folder's name cannot be a plugin's.
export function pluginNameOf(definition: string): string | undefined {
  const name = path.basename(path.dirname(definition));
  return PLUGIN_NAME.test(name) ? name : undefined;
}

// [LAW:one-source-of-truth] Every name a plugin declares lives under
// `plugins.<plugin>.`: no plugin can collide with a name the bar or the user
// declares, and nothing outside it is ever a plugin's.
export const PLUGIN_NS = "plugins.";

// The variable a plugin's data file publishes, read as
// `.plugins.<plugin>.data.*`.
export function pluginDataVar(plugin: string): string {
  return `${PLUGIN_NS}${plugin}.data`;
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
): readonly string[] {
  return refs.map((ref) => path.resolve(path.dirname(from), expandHome(ref)));
}

/**
 * Lay every definition over `base`, in order. A plugin replaces whatever a
 * layer beneath it declared under its name — a listed plugin replaces an
 * installed one, a project's installed plugin a machine's — so the nearest
 * declaration wins whole and two copies never merge; within one list a name
 * is taken once.
 */
export function applyPlugins(
  definitions: readonly string[],
  ctx: PluginContext,
  base: DslConfig,
  validate: (config: DslConfig) => unknown,
): PluginLayer {
  // [LAW:dataflow-not-control-flow] One fold, every definition: each step
  // either merges its plugin or records why not, and the next step sees the
  // result.
  const taken = new Map<string, string>();
  return definitions.reduce<PluginLayer>(
    (layer, file) => {
      const plugin = pluginNameOf(file);
      const drop = (reason: string, config: DslConfig): PluginLayer => ({
        ...layer,
        config,
        dropped: [...layer.dropped, { path: file, plugin, reason }],
      });
      if (plugin === undefined) {
        return drop(
          `its folder "${path.basename(path.dirname(file))}" is not a plugin name (one matching ${PLUGIN_NAME}: it prefixes every name the plugin declares)`,
          layer.config,
        );
      }
      const first = taken.get(plugin);
      if (first !== undefined) {
        return drop(
          `plugin "${plugin}" is already listed, from ${first}`,
          layer.config,
        );
      }
      taken.set(plugin, file);
      const under = withoutPlugin(layer.config, plugin);
      const merged = attempt(() => {
        const source = fs.readFileSync(file, "utf-8");
        const config = mergeWithDefault(
          fragmentOf(
            file,
            plugin,
            { source, json: JSON5.parse(source) as unknown },
            under,
            ctx,
          ),
          under,
        );
        validate(config);
        return config;
      });
      if (merged.ok) {
        return {
          ...layer,
          config: merged.value,
          loaded: [...layer.loaded, file],
        };
      }
      const dropped = { path: file, plugin, reason: merged.reason };
      return drop(merged.reason, tombstone(under, plugin, dropped));
    },
    { config: base, loaded: [], dropped: [] },
  );
}

// The config with nothing left under `plugins.<plugin>.`.
function withoutPlugin(config: DslConfig, plugin: string): DslConfig {
  const prefix = `${PLUGIN_NS}${plugin}.`;
  const keep = <T>(r: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(r).filter(([name]) => !name.startsWith(prefix)),
    );
  return {
    ...config,
    variables: keep(config.variables),
    segments: keep(config.segments),
    helpers: keep(config.helpers),
    actions: keep(config.actions),
  };
}

// [LAW:no-silent-failure] A dropped plugin still owns its namespace: its data
// variable is a document that IS the drop, so a template reading it — the
// user's own, a stand-in's — renders ⚠ naming why.
function tombstone(
  config: DslConfig,
  plugin: string,
  dropped: DroppedPlugin,
): DslConfig {
  return {
    ...config,
    variables: {
      ...config.variables,
      [pluginDataVar(plugin)]: {
        kind: "dropped",
        reason: droppedPluginNotice(dropped),
      },
    },
  };
}

// The plugin a name is declared under, if any.
function pluginOf(name: string): string | undefined {
  return name.startsWith(PLUGIN_NS)
    ? name.slice(PLUGIN_NS.length).split(".")[0]
    : undefined;
}

// Why a name under `plugins.` names nothing: the drop notice of the plugin
// whose namespace it is — its tombstone — or, when no plugin owns that
// namespace at all, every drop that has no name (a folder whose name is not
// a plugin's). A name outside `plugins.`, or under a plugin that loaded,
// belongs to no drop.
export function dropsOwning(
  layer: PluginLayer,
): (name: string) => readonly string[] {
  const owners = new Set(
    [
      ...Object.keys(layer.config.variables),
      ...Object.keys(layer.config.segments),
    ].map(pluginOf),
  );
  const unnamed = layer.dropped
    .filter((d) => d.plugin === undefined)
    .map(droppedPluginNotice);
  return (name) => {
    const plugin = pluginOf(name);
    if (plugin === undefined) return [];
    const data = layer.config.variables[pluginDataVar(plugin)];
    if (data?.kind === "dropped") return [data.reason];
    return owners.has(plugin) ? [] : unnamed;
  };
}

/**
 * Every segment of a dropped plugin the user's file still names — a placement,
 * or a by-field retune — stands in as a cell saying the plugin did not load,
 * rather than failing the whole config. The stand-in declares each setting
 * its placements set, so they still validate.
 */
export function withDroppedPlacements(
  config: DslConfig,
  layer: DslConfig,
  owning: (name: string) => readonly string[],
): DslConfig {
  const placements = presetNames(config.presets)
    .flatMap((preset) => [...walkNodes(presetRoot(config, preset).node)])
    .flatMap((node) => (node.kind === "segment" ? [node] : []));
  const names = new Set([
    ...placements.map((n) => n.name),
    ...Object.keys(config.segments),
  ]);
  const standIns = Object.fromEntries(
    [...names]
      .filter((name) => !(name in layer.segments))
      .flatMap((name) => {
        const cause = owning(name);
        return cause.length === 0
          ? []
          : [
              [
                name,
                standIn(
                  name,
                  cause,
                  placements.filter((n) => n.name === name),
                ),
              ],
            ];
      }),
  );
  // An action of a dropped plugin a template binds stands in as one whose
  // copy reads the tombstone: the cell binding it renders ⚠ with the drop.
  const actionStandIns = Object.fromEntries(
    Object.values(config.segments)
      .flatMap((seg) =>
        (["template", "bg", "fg", "when"] as const).flatMap((f) =>
          seg[f] === undefined
            ? []
            : templateActionRefs(seg[f], config.helpers).map((r) => r.name),
        ),
      )
      .filter((name) => !(name in config.actions))
      .flatMap((name) => {
        const plugin = pluginOf(name);
        return plugin !== undefined &&
          config.variables[pluginDataVar(plugin)]?.kind === "dropped"
          ? [[name, { copy: `{{ .${pluginDataVar(plugin)} }}` }] as const]
          : [];
      }),
  );
  return {
    ...config,
    segments: { ...config.segments, ...standIns },
    actions: { ...config.actions, ...actionStandIns },
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
  ns: string,
  { source, json }: { readonly source: string; readonly json: unknown },
  base: DslConfig,
  { projectDir }: PluginContext,
): RawDslConfig {
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
            ? `a plugin definition does not name itself: its name is its folder's ("${ns}") — remove "plugin"`
            : `a plugin definition may not declare "${key}". Expected only: ${[...DEFINITION_KEYS].join(", ")}`,
      });
    }
  }
  const dataPath = dataPathOf(json.data, file, projectDir, issues);
  if (!isPlainObject(json.segments)) {
    issues.push({
      path: "segments",
      message: `"segments" must be an object naming the plugin's segments`,
    });
  }
  if (issues.length > 0 || dataPath === undefined) return fail();

  const ctx: ValidateCtx = {
    source,
    issues,
    allowedPalettes: new Set(listResolvablePaletteNames()),
    groups: [],
  };
  // [LAW:one-source-of-truth] The data variable is parsed by the validator
  // every `file` source goes through, from the declaration a user would write.
  // Its `{}` default is what a missing data file reads as: no fields, which a
  // segment gates on (`hasKey`); malformed data is not a missing file and
  // reads as the failure (⚠).
  const variables = validateVariables(ctx, "data", {
    [pluginDataVar(ns)]: {
      kind: "file",
      path: dataPath,
      parse: { json: true },
      cache: { watch_file: dataPath },
      default: {},
    },
  });
  // A segment's own `vars` are sources (a shell among them): a definition
  // declares none, so loading one runs nothing.
  for (const [name, seg] of Object.entries(json.segments as object)) {
    if (isPlainObject(seg) && "vars" in seg) {
      issues.push({
        path: `segments.${name}.vars`,
        message: `a plugin segment may not declare "vars": a plugin's only source is its data file`,
      });
    }
  }
  const fragment: RawDslConfig = {
    variables,
    segments: prefixed(ns, validateSegments(ctx, json.segments, new Set())),
    helpers: prefixed(ns, validateHelpers(ctx, json.helpers)),
    actions: prefixed(ns, validateActions(ctx, json.actions)),
  };
  // A plugin adds names; it never replaces one the layers under it declared.
  for (const [section, names] of [
    ["variables", Object.keys(fragment.variables ?? {})],
    ["segments", Object.keys(fragment.segments ?? {})],
    ["helpers", Object.keys(fragment.helpers ?? {})],
    ["actions", Object.keys(fragment.actions ?? {})],
  ] as const) {
    for (const name of names) {
      if (name in base[section]) {
        issues.push({
          path: section,
          message: `"${name}" is already declared by the config this plugin loads into`,
        });
      }
    }
  }
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

function* fragmentTemplates(
  fragment: RawDslConfig,
): IterableIterator<readonly [string, string]> {
  for (const [name, seg] of Object.entries(fragment.segments ?? {})) {
    for (const field of ["template", "bg", "fg", "when"] as const) {
      const t = seg[field];
      if (t !== undefined) yield [`segments.${name}.${field}`, t];
    }
  }
  for (const [name, body] of Object.entries(fragment.helpers ?? {})) {
    yield [`helpers.${name}`, `{{ define "${name}" }}${body}{{ end }}`];
  }
  for (const [name, a] of Object.entries(fragment.actions ?? {})) {
    if ("copy" in a) yield [`actions.${name}.copy`, a.copy];
    if ("open" in a) yield [`actions.${name}.open`, a.open];
    if ("preset" in a && a.preset === "delete")
      yield [`actions.${name}.name`, a.name];
  }
}

function prefixed<T>(
  ns: string,
  decls: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(decls).map(([name, d]) => [`${PLUGIN_NS}${ns}.${name}`, d]),
  );
}

// [LAW:types-are-the-program] Where a plugin's data lives: a path relative to
// its definition (an app that keeps one state file), or `{ project }`, a path
// relative to the session's project — one installed definition, a data file
// per repo (lit writes `<repo>/.lit/candybar.json`).
function dataPathOf(
  data: unknown,
  file: string,
  projectDir: string | null,
  issues: ConfigIssue[],
): string | undefined {
  if (typeof data === "string" && data !== "") {
    return path.resolve(path.dirname(file), expandHome(data));
  }
  if (
    isPlainObject(data) &&
    Object.keys(data).length === 1 &&
    typeof data.project === "string" &&
    data.project !== ""
  ) {
    if (projectDir === null) {
      issues.push({
        path: "data.project",
        message: `data is read from the session's project, and this load has none`,
      });
      return undefined;
    }
    return path.resolve(projectDir, data.project);
  }
  issues.push({
    path: "data",
    message: `"data" must be the path of the plugin's JSON data file relative to this definition, or { project: "<path>" } relative to the session's project`,
  });
  return undefined;
}
