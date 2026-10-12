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

// A plugin that could not be loaded: the definition path it was listed as,
// and why. The rest of the config renders without it.
export interface DroppedPlugin {
  readonly path: string;
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
      try {
        const config = mergeWithDefault(
          loadPlugin(file, layer.config),
          layer.config,
        );
        validate(config);
        return { ...layer, config, loaded: [...layer.loaded, file] };
      } catch (err) {
        const reason =
          err instanceof ConfigError
            ? err.issues
                .map((i) =>
                  i.path === "" ? i.message : `${i.path}: ${i.message}`,
                )
                .join("; ")
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          ...layer,
          dropped: [...layer.dropped, { path: file, reason }],
        };
      }
    },
    { config: base, loaded: [], dropped: [] },
  );
}

// Read and parse one definition into the raw fragment it contributes, every
// name under its `<plugin>.` namespace. Throws on any problem; the fold above
// turns the throw into a drop.
function loadPlugin(file: string, base: DslConfig): RawDslConfig {
  const source = fs.readFileSync(file, "utf-8");
  const json: unknown = JSON5.parse(source);
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
  if (issues.length > 0) fail();
  return fragment;
}

function prefixed<T>(
  ns: string,
  decls: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(decls).map(([name, d]) => [`${ns}.${name}`, d]),
  );
}
