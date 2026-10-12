// [LAW:decomposition] A PLUGIN is another program's contribution to the bar:
// a DEFINITION file (json5, written once by the app's developer) naming the
// plugin, its segments, helpers and actions, and the path of a DATA file (plain
// JSON, rewritten by the running app). This module turns the paths a config
// lists under `plugins:` into one layer of the merge — bundled < plugins <
// the user's file — and nothing else.
//
// [LAW:one-type-per-behavior] A plugin is not a new kind of anything. Its data
// is the existing `file` source with `parse: { json: true }`, watched, read in
// templates as `.<plugin>.data.*`; its segments, helpers and actions are parsed
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
import { isReservedName } from "./reserved-namespace.js";
import { SYNTAX_ENGINE } from "./syntax-engine.js";
import { walkNodes } from "../dsl-types.js";
import { presetNames, presetRoot } from "../presets.js";

// A plugin that could not be loaded: the definition path it was listed as,
// the name it declares when that much could be read (a missing file names
// none), and why. The rest of the config renders without it.
export interface DroppedPlugin {
  readonly path: string;
  readonly plugin: string | undefined;
  readonly reason: string;
}

export interface PluginLayer {
  // The base with every plugin that loaded merged over it, in listed order.
  readonly config: DslConfig;
  readonly loaded: readonly string[];
  readonly dropped: readonly DroppedPlugin[];
}

// The spelling of a drop, shared by the diagnostic strip and `check`.
export function droppedPluginNotice(d: DroppedPlugin): string {
  return `plugin ${d.path} was not loaded: ${d.reason}`;
}

// [LAW:types-are-the-program] What a definition may say. Everything else is a
// load error naming the field: a definition declares no sources of its own
// (no shell), so loading one from a cloned repo runs nothing, and it never
// edits `root` — placing its segments is the user's choice.
const DEFINITION_KEYS = new Set([
  "plugin",
  "data",
  "segments",
  "helpers",
  "actions",
]);

// A plugin name prefixes every name it declares, so it is one identifier
// segment: no dot (it would forge another plugin's namespace), nothing a
// template path cannot spell.
const PLUGIN_NAME = /^[a-z][a-z0-9_]*$/;

// The variable a plugin's data file publishes, read as `.<plugin>.data.*`.
export function pluginDataVar(plugin: string): string {
  return `${plugin}.data`;
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
 * Lay every listed plugin over `base`, in order. `from` is the file that
 * lists them: a relative path resolves against its directory, `~` against the
 * home directory.
 */
export function applyPlugins(
  refs: readonly string[],
  from: string,
  base: DslConfig,
  validate: (config: DslConfig) => unknown,
): PluginLayer {
  const dir = path.dirname(from);
  // [LAW:dataflow-not-control-flow] One fold, every ref: each step either
  // merges its plugin or records why not, and the next step sees the result.
  return refs.reduce<PluginLayer>(
    (layer, ref) => {
      const file = path.resolve(dir, expandHome(ref));
      const read = attempt(() => {
        const source = fs.readFileSync(file, "utf-8");
        return { source, json: JSON5.parse(source) as unknown };
      });
      const plugin = read.ok ? namespaceOf(read.value.json) : undefined;
      const merged = read.ok
        ? attempt(() => {
            const config = mergeWithDefault(
              fragmentOf(file, read.value, layer.config),
              layer.config,
            );
            validate(config);
            return config;
          })
        : read;
      return merged.ok
        ? { ...layer, config: merged.value, loaded: [...layer.loaded, file] }
        : {
            ...layer,
            dropped: [
              ...layer.dropped,
              { path: file, plugin, reason: merged.reason },
            ],
          };
    },
    { config: base, loaded: [], dropped: [] },
  );
}

// The name a definition declares, when it declares a usable one.
function namespaceOf(json: unknown): string | undefined {
  return isPlainObject(json) &&
    typeof json.plugin === "string" &&
    PLUGIN_NAME.test(json.plugin) &&
    !isReservedName(`${json.plugin}.`)
    ? json.plugin
    : undefined;
}

/**
 * A placement of a segment no layer declares, where a dropped plugin is the
 * reason, stands in as a cell saying so rather than failing the whole config:
 * the plugin that would have declared it is under `<plugin>.`, or — when a
 * drop could not even be read for its name — under a namespace nothing
 * declares. Any other undeclared placement stays the load error it was.
 */
export function withDroppedPlacements(
  config: DslConfig,
  dropped: readonly DroppedPlugin[],
): DslConfig {
  const declaredHeads = new Set(
    Object.keys(config.segments).map((n) => n.split(".")[0]),
  );
  const causeOf = (name: string): readonly DroppedPlugin[] => {
    const head = name.includes(".") ? name.split(".")[0] : undefined;
    if (head === undefined) return [];
    const named = dropped.filter((d) => d.plugin === head);
    return named.length > 0 || declaredHeads.has(head)
      ? named
      : dropped.filter((d) => d.plugin === undefined);
  };
  const standIns = Object.fromEntries(
    presetNames(config.presets)
      .flatMap((preset) => [...walkNodes(presetRoot(config, preset).node)])
      .flatMap((node) =>
        node.kind === "segment" && !(node.name in config.segments)
          ? [node.name]
          : [],
      )
      .flatMap((name) => {
        const cause = causeOf(name);
        return cause.length === 0 ? [] : [[name, standIn(name, cause)]];
      }),
  );
  return { ...config, segments: { ...config.segments, ...standIns } };
}

function standIn(
  name: string,
  cause: readonly DroppedPlugin[],
): DslConfig["segments"][string] {
  const text = `⚠ ${name}: plugin not loaded (${cause.map((d) => d.path).join(", ")})`;
  return {
    template: `{{ ${JSON.stringify(text)} }}`,
    bg: "error",
    description: "stands in for a placed segment whose plugin did not load",
  };
}

// The raw fragment one parsed definition contributes, every name under its
// `<plugin>.` namespace. Throws on any problem; the fold above turns the throw
// into a drop.
function fragmentOf(
  file: string,
  { source, json }: { readonly source: string; readonly json: unknown },
  base: DslConfig,
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
        message: `a plugin definition may not declare "${key}". Expected only: ${[...DEFINITION_KEYS].join(", ")}`,
      });
    }
  }
  const { plugin, data } = json;
  if (typeof plugin !== "string" || !PLUGIN_NAME.test(plugin)) {
    issues.push({
      path: "plugin",
      message: `"plugin" must be a name matching ${PLUGIN_NAME} (it prefixes every name the plugin declares)`,
    });
  } else if (isReservedName(`${plugin}.`)) {
    issues.push({
      path: "plugin",
      message: `"plugin" may not be "${plugin}": the bar's own synthesized names live under "${plugin}."`,
    });
  }
  if (typeof data !== "string" || data === "") {
    issues.push({
      path: "data",
      message: `"data" must be the path of the plugin's JSON data file, relative to this definition`,
    });
  }
  if (!isPlainObject(json.segments)) {
    issues.push({
      path: "segments",
      message: `"segments" must be an object naming the plugin's segments`,
    });
  }
  if (issues.length > 0) fail();

  const ns = plugin as string;
  const dataPath = path.resolve(path.dirname(file), expandHome(data as string));
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
    Object.entries(decls).map(([name, d]) => [`${ns}.${name}`, d]),
  );
}
