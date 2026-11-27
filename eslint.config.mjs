import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import globals from "globals";
import fs from "node:fs";
import * as nodeModule from "node:module";
import * as nodeProcess from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CODE_GLOB, JS_GLOB, mayImport, mayLoadRendererModule, NO_ZONE, packageZoneOf, TEST_ROOTS, withoutExtension, TS_GLOB, ZONE_IMPORTS, zoneOf } from "./scripts/import-zones.mjs";

// [LAW:single-enforcer] (kz8.2) src/proc/spawner.ts is the only file allowed to
// import node:child_process directly. Every other spawn site routes through a
// Launcher, which reaches the OS through that Spawner. This rule keeps the
// invariant load-bearing: a future regression fails lint, not just a manual grep.
const SPAWNER_FILE = "src/proc/spawner.ts";
// [LAW:effects-at-boundaries] [LAW:single-enforcer] The real clock, the timer
// globals and the loop's turn are read in src/time.ts alone; everything else is
// handed a Timekeeper. Global and property checks use the same diagnostic as
// the clock module ownership at the import boundary.
const CLOCK_FILE = "src/time.ts";
const CLOCK_MESSAGE =
  "Take the clock you are handed (src/time.ts): it alone reads the real one. [LAW:effects-at-boundaries]";
const CLOCK_PROPERTIES = [
  { object: "Date", property: "now", message: CLOCK_MESSAGE },
  { object: "performance", property: "now", message: CLOCK_MESSAGE },
  { object: "process", property: "hrtime", message: CLOCK_MESSAGE },
  { object: "process", property: "uptime", message: CLOCK_MESSAGE },
  { object: "AbortSignal", property: "timeout", message: CLOCK_MESSAGE },
];
// [LAW:single-enforcer] A signal sent to a pid or its group, or signal 0 asking
// whether it is there, is read of the process table: src/proc/spawner.ts owns
// it for a launch's groups and the ProcessProbe for a pid. The two files
// below are exceptions, each owned by the ticket that gives its program a port;
// the list may shrink and no other file joins it.
//   src/daemon/lane-edge.ts  SIGTERM to Claude Code (candybar-testing-ihvy.dcv)
//   src/daemon/server.ts     the daemon's own SIGKILL (the Lifetime piece)
const KILL_EXCEPTIONS = [
  "src/daemon/lane-edge.ts",
  "src/daemon/server.ts",
];
const KILL_OWNERS = [
  "src/proc/spawner.ts",
  "src/daemon/process-fingerprint.ts",
  ...KILL_EXCEPTIONS,
];
const KILL_PROPERTY = {
  object: "process",
  property: "kill",
  message:
    "Signals and liveness reads go through a Spawner (a launch's group) or a ProcessProbe (a pid). [LAW:single-enforcer]",
};
const CLOCK_SYNTAX = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: CLOCK_MESSAGE,
  },
  {
    selector:
      "NewExpression[callee.name='Date'][arguments.length=1] > Identifier[name='undefined']",
    message: CLOCK_MESSAGE,
  },
  { selector: "CallExpression[callee.name='Date']", message: CLOCK_MESSAGE },
];
const CLOCK_GLOBALS = [
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
].map((name) => ({ name, message: CLOCK_MESSAGE }));
// [LAW:effects-at-boundaries] [LAW:single-enforcer] The environment, the home
// directory (`os.homedir` reads `HOME`) and the temporary directory
// (`os.tmpdir` reads `TMPDIR`) are read once, by `processWorld` in
// src/host.ts, and handed down as a `Host`. The preload's main runs apart from
// the rest of src and reads its own. Every other file takes what it is given.
const HOST_READERS = ["src/host.ts", "src/attach-preload-exec.ts"];
const HOST_READ_MESSAGE =
  "Take the Host you are handed: src/host.ts reads the process once. [LAW:effects-at-boundaries]";
const HOST_PROPERTIES = [
  { object: "process", property: "env", message: HOST_READ_MESSAGE },
  { object: "os", property: "homedir", message: HOST_READ_MESSAGE },
  { object: "os", property: "tmpdir", message: HOST_READ_MESSAGE },
];
// [LAW:single-enforcer] Ownership is keyed by resolved module and export.
// File globs and the spelling of the edge do not identify the resource it grants.
const inApp = (file) => file.startsWith("src/");
const outsideProc = (file) => inApp(file) && !file.startsWith("src/proc/");
const except =
  (scope, ...owners) =>
  (file) =>
    scope(file) && !owners.includes(file);
const composition = "src/daemon/production-adapters.ts";
const launcher = "src/proc/system-launcher";
const paths = "src/daemon/paths";
const nativeLauncherMessage =
  "Script the program on a fake launcher (scripts/lib/draw-fixtures/fake-launcher.ts), or test the adapter under test/integration. [LAW:effects-at-boundaries]";
const owned = (modules, names, applies, message) => ({
  modules,
  names,
  applies,
  message,
});
const named = (module, names, message, ...owners) =>
  owned(
    [module],
    names,
    except(outsideProc, ...owners),
    `${message} [LAW:single-enforcer]`,
  );
export const moduleOwnership = {
  app: [
    owned(
      ["node:child_process"],
      null,
      except(inApp, SPAWNER_FILE),
      "Launch through a Launcher from src/proc/launch instead. [LAW:single-enforcer] (kz8.2)",
    ),
    owned(
      ["node:timers", "node:timers/promises", "node:perf_hooks"],
      null,
      except(inApp, CLOCK_FILE),
      CLOCK_MESSAGE,
    ),
    owned(
      ["node:fs", "node:fs/promises"],
      null,
      (file) => file.startsWith("src/renderer/"),
      "The renderer opens no file: what it reads is handed in (config snapshots, world state). [LAW:effects-at-boundaries]",
    ),
    owned(
      ["node:fs", "node:fs/promises"],
      null,
      (file) => file === "src/daemon/daemon.ts",
      "Take the disk from the daemon's inputs.",
    ),
    owned(
      ["src/proc/spawner-fake", "src/daemon/process-probe-fake"],
      null,
      inApp,
      "A fake is a test's: src never imports one. [LAW:single-enforcer]",
    ),
    owned(
      ["node:os"],
      ["homedir", "tmpdir"],
      except(inApp, ...HOST_READERS),
      HOST_READ_MESSAGE,
    ),
    owned(
      ["node:process"],
      ["env"],
      except(inApp, ...HOST_READERS),
      HOST_READ_MESSAGE,
    ),
    owned(
      ["src/time"],
      ["systemTimers"],
      except(inApp, "src/host.ts"),
      "The process world (src/host.ts) builds its clock over src/time.ts's machine timers: take the clock you are given. [LAW:single-enforcer]",
    ),
    named(
      launcher,
      ["systemOneShotLauncher"],
      "The process has its one-shot launcher: take the one you are given.",
      "src/host.ts",
    ),
    named(
      launcher,
      ["systemLauncher"],
      "A Launcher is an owner's: take the one you are handed.",
      composition,
    ),
    named(
      "src/proc/launch",
      ["createLauncher", "createOneShotLauncher"],
      "A launcher over the machine is system-launcher's to build.",
    ),
    ...[
      ["src/claude-input/edge", "productionClaudeInputEdge"],
      ["src/daemon/lane-edge", "productionBarPaneEdge"],
      ["src/daemon/limits", "realLimitsDeps"],
      ["src/daemon/file-storage", "fileStorage"],
      ["src/daemon/cache/pricing-fetch", "fetchPricing"],
    ].map(([module, name]) =>
      named(
        module,
        [name],
        "A daemon is handed its adapters (production-adapters.ts).",
        composition,
      ),
    ),
    named(
      "src/daemon/link-key",
      ["linkKeyFromFile"],
      "A daemon is handed its link signer (production-adapters.ts).",
      composition,
    ),
    named(
      paths,
      ["daemonPaths"],
      "A daemon is handed its paths: take the value you are given.",
      "src/daemon/server.ts",
      "src/renderer-process.ts",
    ),
    named(
      paths,
      [
        "stateDir",
        "cacheDir",
        "logPath",
        "sessionStatePath",
        "settingsHistoryPath",
        "daemonRegistryDir",
        "watchProbeDir",
      ],
      "A daemon is handed its paths: take the value you are given.",
    ),
    named(
      paths,
      ["socketPath", "defaultSocketPath"],
      "Only a client of the daemon reads its socket from the environment.",
      "src/frames-cli.ts",
      "src/ssh-cli.ts",
      "src/bar-pane/index.ts",
      "src/bar-window/index.ts",
      "src/daemon/client-transport.ts",
      "src/daemon/acquire.ts",
    ),
    named(
      paths,
      ["daemonDir", "spawnLockPath", "spawnCooldownPath", "spawnBackoffPath"],
      "Only the client that spawns a daemon reads these.",
      "src/daemon/acquire.ts",
    ),
  ],
  // The suite config applies this policy outside its native launcher adapters.
  suite: [
    ["test/helpers/host", ["processLauncher", "fixtureLauncher"]],
    [launcher, ["systemLauncher", "systemOneShotLauncher"]],
    ["src/proc/spawner", ["systemSpawner"]],
  ].map(([module, names]) =>
    owned([module], names, () => true, nativeLauncherMessage),
  ),
};

// [LAW:one-source-of-truth] Why an edge is refused, by what it reaches: what
// the zone it imports holds decides it, whichever zone imports it.
const REFUSAL = {
  renderer: "The renderer is reached only through its start (src/renderer/main.ts).",
  start: "Renderer construction is the host's and the renderer process's: shared code loads in both and imports neither side.",
  "renderer-process": "The renderer process is an entry of its own, which only the CLI starts.",
  rest: "Host code stays out of the renderer and shared code, which consume the shared contract.",
  root: "The CLI's entry dispatches to every process, and nothing imports it.",
  lib: "scripts/lib is what the tools and the tests share, and the app imports nothing from it.",
  tools: "A tool runs by hand: the app and scripts/lib import nothing from one, and what it shares lives in scripts/lib.",
  test: "The test suite runs under Jest: code that runs outside it imports nothing from test/ or from Jest, and what a tool and a test share lives in scripts/lib.",
  [NO_ZONE]: "A path no row of scripts/import-zones.mjs names is in no zone: give its root a row there, saying which side of Jest it runs on.",
  "outside the repo": "A module outside the repo is in no zone.",
};
// [LAW:no-silent-failure] Every zone an edge can be refused into has its
// reason, or the config refuses to load.
const unexplained = [...Object.keys(ZONE_IMPORTS), NO_ZONE, "outside the repo"].filter(
  (to) =>
    Object.values(ZONE_IMPORTS).some((allowed) => !allowed.includes(to)) &&
    !(to in REFUSAL),
);
if (unexplained.length > 0)
  throw new Error(`eslint.config.mjs: no refusal message for imports of ${unexplained.join(", ")}`);

// A module's key is its repo-relative path without its extension, so
// `../time.js`, `./time` and `src/time.ts` are one module, and a directory's
// import (`../verbs`) is its index's. Relative to this file, not ESLint's cwd,
// so an editor or runner started in a subdirectory keys the same modules.
const REPO_ROOT = fs.realpathSync(import.meta.dirname);
// The caller and its target use the same physical checkout. For an emitted
// extension or an unsaved editor buffer, resolve the nearest existing ancestor.
const physicalPath = (file) =>
  fs.existsSync(file)
    ? fs.realpathSync(file)
    : path.join(physicalPath(path.dirname(file)), path.basename(file));
const moduleKey = (file) =>
  withoutExtension(path.relative(REPO_ROOT, physicalPath(file)));

// Node exposes its native default through named exports too (notably Module).
// Derive namespace projections from the public objects the runtime supplies.
const selfExports = (namespace) =>
  new Set(
    Object.keys(namespace).filter(
      (name) => namespace[name] === namespace.default,
    ),
  );
const moduleSelf = selfExports(nodeModule);
const processSelf = selfExports(nodeProcess);

const CLOCK_KEY = withoutExtension(CLOCK_FILE);
// Whether an import brings in types alone, which carry no clock.
const typeOnly = (node) =>
  node.type === "TSImportType" ||
  (node.type === "TSExternalModuleReference" &&
    node.parent.importKind === "type") ||
  node.importKind === "type" ||
  node.exportKind === "type" ||
  (node.specifiers?.length > 0 &&
    node.specifiers.every(
      (s) => s.importKind === "type" || s.exportKind === "type",
    ));

const importDirection = {
  meta: { type: "problem", schema: [{ enum: ["suite"] }] },
  create(context) {
    const filename = physicalPath(path.resolve(context.filename));
    const dir = path.dirname(filename);
    const file = path.relative(REPO_ROOT, filename);
    const from = withoutExtension(file);
    const policy = context.options[0] ?? "app";
    const directions = policy !== "suite";
    const ownedHere = moduleOwnership[policy].filter((rule) =>
      rule.applies(file),
    );
    // [LAW:no-silent-failure] A key outside the repo is in no zone, so the rule
    // refuses it rather than calling it rest and passing every edge.
    const outside = (key) => key.startsWith("..") || path.isAbsolute(key);
    if (outside(from)) {
      return {
        Program: (node) =>
          context.report({
            node,
            message: `${context.filename} is outside ${REPO_ROOT}, so it is in no zone. [LAW:one-way-deps]`,
          }),
      };
    }
    const fromZone = zoneOf(from);
    if (fromZone === NO_ZONE) {
      return {
        Program: (node) =>
          context.report({
            node,
            message: `${from}: ${REFUSAL[NO_ZONE]} [LAW:one-way-deps]`,
          }),
      };
    }
    const rendering =
      fromZone === "renderer" ||
      fromZone === "start" ||
      fromZone === "renderer-process";
    // Where an edge's source leads: a package, whose zone is the one that
    // owns it or none; a path in the repo, whose zone is its row's; or a path
    // outside the repo, which is in no zone.
    const targetOf = (source, base, esm) => {
      const fileURL = esm && /^file:/i.test(source);
      const relative = /^(?:\.\.?)(?:\/|$)/.test(source);
      if (!fileURL && !relative && !path.isAbsolute(source))
        return { kind: "package", name: source, zone: packageZoneOf(source) };
      if (relative && base === null) return null;
      let filename;
      if (esm) {
        // URL resolution strips query/fragment and decodes the pathname
        // only on ESM edges. The same characters name literal files in CJS.
        try {
          filename = fileURLToPath(
            new URL(source, pathToFileURL((base ?? dir) + path.sep)),
          );
        } catch {
          return null;
        }
      } else filename = path.resolve(base ?? dir, source);
      const key = moduleKey(filename);
      return {
        kind: "path",
        name: key,
        zone: outside(key) ? "outside the repo" : zoneOf(key),
      };
    };
    // `base` is the directory a relative source resolves from: this file's,
    // or null for a loader built on a base no lint can read.
    const check = (node, source, base = dir, esm = false) => {
      if (source === null) {
        context.report({
          node,
          message: `An import whose source is computed is in no zone. [LAW:one-way-deps]`,
        });
        return;
      }
      const to = targetOf(source, base, esm);
      if (to === null) {
        context.report({
          node,
          message:
            base === null
              ? `A loader whose base is computed loads ${source} from no place a lint can read. [LAW:one-way-deps]`
              : `The module URL ${source} resolves to no readable file. [LAW:one-way-deps]`,
        });
        return;
      }
      const module =
        to.kind === "path"
          ? to.name
          : nodeModule.isBuiltin(source)
            ? `node:${source.replace(/^node:/, "")}`
            : null;
      const rules = ownedHere.filter((rule) => rule.modules.includes(module));
      const loaders = nativeLoaders[module];
      if (rules.length || loaders) {
        const names = exportNames(node, to.kind === "package", loaders);
        const refused = rules.filter(
          (rule) =>
            rule.names === null ||
            names.has(null) ||
            rule.names.some((name) => names.has(name)),
        );
        for (const message of new Set(refused.map((r) => r.message)))
          context.report({ node, message: `${source}: ${message}` });
      }
      if (!directions) return;
      // [LAW:one-way-deps] One judgment of every edge, a package's as a
      // path's: Jest's packages are the test zone's.
      if (to.zone !== null && !mayImport(fromZone, to.zone)) {
        context.report({
          node,
          message: `${fromZone} ${from} imports ${to.zone} ${to.name}. ${REFUSAL[to.zone]} [LAW:one-way-deps]`,
        });
      }
      if (!rendering || typeOnly(node)) return;
      if (
        to.kind === "package" &&
        !mayLoadRendererModule(source, fromZone === "renderer-process")
      ) {
        context.report({
          node,
          message: `The renderer cannot load ${source} from ${from}. [LAW:one-way-deps]`,
        });
      }
      // [LAW:effects-at-boundaries] The renderer reads no clock and sets no
      // timer: its time is the readings each input carries, and what it holds
      // for later waits for a `due`. It may name the clock's types.
      if (to.kind === "path" && to.name === CLOCK_KEY) {
        context.report({
          node,
          message: `${from} imports the clock. The renderer's time is its turn's (src/renderer/turn-time.ts). [LAW:effects-at-boundaries]`,
        });
      }
    };
    // A source is a string literal or a template with nothing interpolated;
    // anything else is computed.
    const sourceOf = (node) =>
      node.type === "Literal" && typeof node.value === "string"
        ? node.value
        : node.type === "TemplateLiteral" && node.expressions.length === 0
          ? node.quasis[0].value.cooked
          : null;
    const fromSource = (node) => {
      if (!node.source) return;
      const source = staticLocation(node.source);
      check(node, source instanceof URL ? source.href : source, dir, true);
    };
    // [LAW:one-way-deps] What a loader Node hands code loads is an edge like
    // an import's: `require`, `module.require`, `process.getBuiltinModule`,
    // and the loader `createRequire` makes, under whatever name it is bound
    // to. A loader it reads is used by a call with its source, which is
    // judged, or by `.resolve`, which locates and loads nothing. Any other use
    // (such as `.call` or an export) carries it where no lint follows, so it
    // is refused. Namespace projections follow their lexical bindings.
    // Reflection and evaluation of assembled code are outside this rule.
    const refuseUse = (node, what) =>
      context.report({
        node,
        message: `${what} is used other than by a call with its source, so what it loads no lint can place. [LAW:one-way-deps]`,
      });
    // Each read of a variable a declaration binds, by its name in the
    // declaration.
    const readsOf = (declaration, name, valuesOnly = false) =>
      context.sourceCode
        .getDeclaredVariables(declaration)
        .filter((variable) => variable.name === name)
        .flatMap((variable) => variable.references)
        .filter(
          (reference) =>
            !reference.init &&
            (!valuesOnly || reference.isValueReference !== false),
        )
        .map((reference) => reference.identifier);
    const calledAs = (node) =>
      node.parent.type === "CallExpression" && node.parent.callee === node;
    const exportedBinding = (declaration) =>
      declaration.type === "VariableDeclarator"
        ? declaration.parent.parent.type === "ExportNamedDeclaration"
        : declaration.parent.type === "ExportNamedDeclaration";
    // An exported binding escapes this file and may still be used within it.
    // Visit each lexical read once, even when a var aliases itself.
    const followLoader = (start, what, use) => {
      const reads = new Set([start]);
      for (const node of reads) {
        const declaration = node.parent;
        if (
          declaration.type === "VariableDeclarator" &&
          declaration.init === node &&
          declaration.id.type === "Identifier"
        ) {
          if (exportedBinding(declaration)) refuseUse(node, what);
          for (const read of readsOf(declaration, declaration.id.name, true))
            reads.add(read);
        } else use(node);
      }
    };
    // An expression whose value is a loader, judged where it stands.
    const loaderUse = (start, base, what, builtinsOnly = false) =>
      followLoader(start, what, (node) => {
        const { parent } = node;
        if (calledAs(node)) {
          const source = parent.arguments[0]
            ? sourceOf(parent.arguments[0])
            : null;
          // getBuiltinModule returns undefined for file and package specifiers.
          if (!builtinsOnly || source === null || nodeModule.isBuiltin(source))
            check(parent, source, base);
          return;
        }
        if (
          parent.type === "MemberExpression" &&
          parent.object === node &&
          !parent.computed &&
          parent.property.name === "resolve" &&
          calledAs(parent)
        )
          return;
        refuseUse(node, what);
      });
    // A createRequire loader resolves relative sources from the declared
    // file or directory when its path or file URL is known.
    const isGlobal = (node, name) => {
      if (node?.type !== "Identifier" || node.name !== name) return false;
      for (
        let scope = context.sourceCode.getScope(node);
        scope;
        scope = scope.upper
      ) {
        const variable = scope.set.get(name);
        if (variable)
          return variable.scope.type === "global" && variable.defs.length === 0;
      }
      return true;
    };
    const staticLocation = (node) => {
      if (!node) return null;
      const literal = sourceOf(node);
      if (literal !== null) return literal;
      if (isGlobal(node, "__filename"))
        return path.join(dir, path.basename(file));
      if (
        node.type === "MemberExpression" &&
        node.object.type === "MetaProperty" &&
        node.object.meta.name === "import" &&
        node.object.property.name === "meta" &&
        keyOf(node.property, node.computed) === "url"
      )
        return pathToFileURL(path.join(dir, path.basename(file)));
      if (
        node.type === "NewExpression" &&
        isGlobal(node.callee, "URL") &&
        node.arguments.length <= 2
      ) {
        const [where, from] = node.arguments;
        const input = staticLocation(where),
          parent = staticLocation(from);
        if (input === null || (from && parent === null)) return null;
        try {
          return new URL(input, parent ?? undefined);
        } catch {
          return null;
        }
      }
      return null;
    };
    const baseOf = (call) => {
      const value = staticLocation(call.arguments[0]);
      if (value === null) return null;
      let filename;
      if (typeof value === "string" && path.isAbsolute(value)) filename = value;
      else {
        try {
          filename = fileURLToPath(value);
        } catch {
          return null;
        }
      }
      return filename.endsWith(path.sep) ? filename : path.dirname(filename);
    };
    const makerUse = (start) =>
      followLoader(start, "`createRequire`", (node) => {
        if (calledAs(node))
          loaderUse(
            node.parent,
            baseOf(node.parent),
            "A `createRequire` loader",
          );
        else refuseUse(node, "`createRequire`");
      });
    const builtinUse = (node) =>
      loaderUse(node, dir, "`getBuiltinModule`", true);
    // A key's name: an identifier's, or a string's when computed.
    const keyOf = (key, computed) =>
      !computed && key.type === "Identifier" ? key.name : sourceOf(key);
    // [LAW:parse-dont-validate] Every loader yields the same resource: its
    // module namespace. Observe literal projections through lexical bindings.
    // Passing a namespace on grants all its exports; an awaited dynamic import
    // grants the namespace, while passing its promise on does the same.
    const exportNames = (edge, builtin, native) => {
      const names = new Set();
      const seen = new Set();
      const all = () => names.add(null);
      const escape = (value) => {
        all();
        if (native && !typeOnly(edge))
          for (const name of Object.keys(native.methods))
            refuseUse(value, `\`${name}\``);
      };
      const binding = (declaration, id, promise = false) => {
        if (exportedBinding(declaration)) escape(id);
        const reads = readsOf(declaration, id.name);
        if (!reads.length) all();
        for (const read of reads) use(read, promise);
      };
      const select = (name, next, access) => {
        if (access && native && Object.hasOwn(native.methods, name))
          access(native.methods[name]);
        if (builtin && (name === "default" || native?.self.has(name))) next();
        else names.add(name);
      };
      const pattern = (id, declaration, promise) => {
        if (id.type === "Identifier") return binding(declaration, id, promise);
        if (promise || id.type !== "ObjectPattern") return escape(id);
        for (const property of id.properties) {
          if (property.type !== "Property") escape(property);
          else
            select(
              keyOf(property.key, property.computed),
              () => pattern(property.value, declaration, false),
              (act) => {
                if (property.value.type !== "Identifier")
                  return refuseUse(
                    property,
                    `\`${keyOf(property.key, property.computed)}\``,
                  );
                if (exportedBinding(declaration))
                  refuseUse(
                    property,
                    `\`${keyOf(property.key, property.computed)}\``,
                  );
                for (const read of readsOf(
                  declaration,
                  property.value.name,
                  true,
                ))
                  act(read);
              },
            );
        }
      };
      const use = (value, promise = false) => {
        if (seen.has(value)) return;
        seen.add(value);
        const parent = value.parent;
        // Loading only for side effects names no export, as in a bare ESM import.
        if (
          parent.type === "ExpressionStatement" ||
          (parent.type === "UnaryExpression" &&
            ["void", "typeof"].includes(parent.operator))
        )
          return;
        if (
          parent.type === "AwaitExpression" ||
          [
            "ChainExpression",
            "TSAsExpression",
            "TSTypeAssertion",
            "TSNonNullExpression",
            "TSSatisfiesExpression",
          ].includes(parent.type)
        )
          return use(parent, parent.type !== "AwaitExpression" && promise);
        if (parent.type === "VariableDeclarator" && parent.init === value)
          return pattern(parent.id, parent, promise);
        if (
          !promise &&
          parent.type === "MemberExpression" &&
          parent.object === value
        )
          return select(
            keyOf(parent.property, parent.computed),
            () => use(parent),
            (act) => act(parent),
          );
        if (
          !promise &&
          parent.type === "TSQualifiedName" &&
          parent.left === value
        )
          return select(parent.right.name, () => use(parent));
        if (
          !promise &&
          parent.type === "TSTypeQuery" &&
          parent.exprName === value
        )
          return use(parent);
        if (
          !promise &&
          parent.type === "TSIndexedAccessType" &&
          parent.objectType === value
        ) {
          const key = parent.indexType;
          return select(
            key.type === "TSLiteralType" ? keyOf(key.literal, true) : null,
            () => use(parent),
          );
        }
        // An opaque consumer of an object may read any owned export. Only a
        // statically selected loader, or a namespace granted across a module
        // boundary, proves the file passed on a native loader.
        if (
          parent.type === "ExportDefaultDeclaration" ||
          (parent.type === "ExportSpecifier" &&
            !typeOnly(parent) &&
            !typeOnly(parent.parent))
        )
          escape(value);
        else all();
      };
      if (edge.type === "ImportDeclaration") {
        for (const spec of edge.specifiers) {
          if (spec.type === "ImportNamespaceSpecifier")
            binding(spec, spec.local);
          else {
            const name =
              spec.type === "ImportDefaultSpecifier"
                ? "default"
                : keyOf(spec.imported, false);
            select(
              name,
              () => binding(spec, spec.local),
              (act) => {
                if (typeOnly(edge) || spec.importKind === "type") return;
                for (const read of readsOf(spec, spec.local.name, true))
                  act(read);
              },
            );
          }
        }
      } else if (edge.type === "ExportNamedDeclaration") {
        for (const spec of edge.specifiers) {
          const erased = typeOnly(edge) || typeOnly(spec);
          select(
            keyOf(spec.local, false),
            () => (erased ? all() : escape(spec)),
            (act) => {
              if (!erased) act(spec.local);
            },
          );
        }
      } else if (edge.type === "TSImportType") {
        let qualifier = edge.qualifier;
        while (qualifier?.type === "TSQualifiedName")
          qualifier = qualifier.left;
        if (qualifier) select(qualifier.name, () => use(qualifier));
        else use(edge);
      } else if (edge.type === "TSExternalModuleReference") {
        const declaration = edge.parent;
        binding(declaration, declaration.id);
      } else if (
        edge.type === "Identifier" ||
        edge.type === "CallExpression" ||
        edge.type === "ImportExpression"
      ) {
        use(edge, edge.type === "ImportExpression");
      } else {
        if (edge.type === "ExportAllDeclaration" && !typeOnly(edge))
          escape(edge);
        else all(); // Type-only re-export or triple-slash reference.
      }
      return names;
    };
    // Native loader identity flows from Node's namespace through its
    // projections and lexical bindings. A same-named method on data is data.
    const nativeLoaders = {
      "node:module": { self: moduleSelf, methods: { createRequire: makerUse } },
      "node:process": {
        self: processSelf,
        methods: { getBuiltinModule: builtinUse },
      },
    };
    // The spellings of an edge it reads: `import`, `export … from`,
    // `import()`, the type `import("…").T`, `import x = require("…")`, a
    // triple-slash reference to types or a path, and a loader's call.
    return {
      Program: () => {
        for (const comment of context.sourceCode.getAllComments()) {
          const reference =
            /^\/\s*<reference\s+(types|path)\s*=\s*["']([^"']+)["']/.exec(
              comment.value,
            );
          if (comment.type !== "Line" || reference === null) continue;
          const [, kind, source] = reference;
          // A path reference is relative whether or not it says so.
          check(
            comment,
            kind === "path" &&
              !source.startsWith(".") &&
              !path.isAbsolute(source)
              ? `./${source}`
              : source,
          );
        }
        // Node's `require` and `module`, wherever this file reads them.
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const { identifier, resolved } of scope.references) {
            if (
              resolved &&
              (resolved.scope.type !== "global" || resolved.defs.length)
            )
              continue;
            if (identifier.name === "process")
              exportNames(identifier, true, nativeLoaders["node:process"]);
            if (identifier.name === "require")
              loaderUse(identifier, dir, "`require`");
            const { parent } = identifier;
            if (
              identifier.name === "module" &&
              parent.type === "MemberExpression" &&
              parent.object === identifier &&
              keyOf(parent.property, parent.computed) === "require"
            )
              loaderUse(parent, dir, "`module.require`");
          }
        }
      },
      ImportDeclaration: fromSource,
      ExportNamedDeclaration: fromSource,
      ExportAllDeclaration: fromSource,
      ImportExpression: fromSource,
      TSImportType: (node) => {
        const source = sourceOf(node.source);
        check(node, source, dir, true);
        const annotation =
          node.parent.type === "TSTypeQuery" ? node.parent.parent : node.parent;
        const pattern =
          annotation.type === "TSTypeAnnotation" && annotation.parent;
        const loaders = nativeLoaders["node:" + source?.replace(/^node:/, "")];
        if (loaders && pattern?.type === "ObjectPattern") {
          for (const prop of pattern.properties) {
            if (prop.type !== "Property") continue;
            const name = keyOf(prop.key, prop.computed);
            if (Object.hasOwn(loaders.methods, name) || loaders.self.has(name))
              refuseUse(prop, `\`${name}\``);
          }
        }
      },
      TSExternalModuleReference: (node) =>
        check(node, sourceOf(node.expression)),
    };
  },
};

// The one import-direction rule: src's config runs it, and so does the tools'
// (eslint.tools.config.mjs). [LAW:single-enforcer]
export const zonesPlugin = { rules: { "import-direction": importDirection } };

export default [
  js.configs.recommended,
  {
    files: [TS_GLOB],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: "latest",
      sourceType: "module",
      // Node's globals, as src's JavaScript reads them, and the names only
      // TypeScript's types declare.
      globals: {
        ...globals.node,
        NodeJS: "readonly",
        BufferEncoding: "readonly",
        // The build stamp tsdown bakes (src/build-stamps.d.ts).
        __SOURCE_DIGEST__: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      prettier: prettierPlugin,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // tsc refuses a name declared twice, and this rule reads each overload
      // signature of a function as one.
      "no-redeclare": "off",
      "no-console": "off",
      "prefer-const": "warn",
      "no-var": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-case-declarations": "off",
      "prettier/prettier": "error",
      curly: "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // [LAW:one-way-deps] Jest's globals are the test zone's: an editor linting a
  // test with this config knows them, and the suite's own fixture hook
  // (test/helpers/fixture-environment.cjs). Everywhere else each is
  // undefined.
  {
    files: TEST_ROOTS.map((root) => `${root}${CODE_GLOB}`),
    languageOptions: {
      globals: { ...globals.jest, releaseTestFixture: "readonly" },
    },
  },
  // [LAW:one-way-deps] The app's environment is closed: a name it reads is
  // one Node, the browser page or the bundle provides, `typeof` included, so
  // nothing reaches for a global only a test's environment installs.
  {
    files: [`src/${TS_GLOB}`],
    rules: { "no-undef": ["error", { typeof: true }] },
  },
  {
    files: [`src/${JS_GLOB}`],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    rules: { "no-undef": ["error", { typeof: true }] },
  },
  prettierConfig,
  // [LAW:no-silent-failure] A promise nobody awaits is a task: the clock's
  // `detach` runs it and reports what it throws, so `void` is no way out, and
  // a promise handed where a callback's return is dropped is refused too.
  {
    files: [`src/${TS_GLOB}`],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: [`src/${CODE_GLOB}`],
    plugins: { zones: zonesPlugin },
    rules: { "zones/import-direction": "error" },
  },
  // The property rule also catches the destructured spelling (`const { env } = process`); an
  // alias of `process` itself is the one it cannot see.
  {
    files: [`src/${TS_GLOB}`],
    ignores: [...HOST_READERS, CLOCK_FILE, ...KILL_OWNERS],
    rules: {
      "no-restricted-properties": [
        "error",
        ...HOST_PROPERTIES,
        ...CLOCK_PROPERTIES,
        KILL_PROPERTY,
      ],
    },
  },
  {
    files: KILL_OWNERS,
    rules: {
      "no-restricted-properties": [
        "error",
        ...HOST_PROPERTIES,
        ...CLOCK_PROPERTIES,
      ],
    },
  },
  {
    files: HOST_READERS,
    rules: {
      "no-restricted-properties": ["error", ...CLOCK_PROPERTIES, KILL_PROPERTY],
    },
  },
  {
    files: [CLOCK_FILE],
    rules: {
      "no-restricted-properties": ["error", ...HOST_PROPERTIES, KILL_PROPERTY],
    },
  },
  // Every file but the clock's: the timer globals, and `new Date()` with no
  // argument. The blocks after this one repeat CLOCK_SYNTAX and CLOCK_GLOBALS
  // beside their own, because a later block replaces the rule.
  {
    files: [`src/${TS_GLOB}`],
    ignores: [CLOCK_FILE],
    rules: {
      "no-restricted-globals": ["error", ...CLOCK_GLOBALS],
      "no-restricted-syntax": ["error", ...CLOCK_SYNTAX],
    },
  },
  // [LAW:verifiable-goals] A path the daemon serves holds its loop if it
  // launches synchronously, so these cannot name the way to. Goes with the
  // launchSync half when `Launcher` drops it (candybar-launch-q7o7.4em).
  // server.ts is the shell: it alone names `runTmux`, for the at-exit handle.
  {
    files: [
      "src/daemon/**/*.ts",
      "src/renderer/**/*.ts",
      "src/claude-input/**/*.ts",
      "src/segments/**/*.ts",
      "src/var-system/**/*.ts",
    ],
    ignores: ["src/daemon/server.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='launchSync']",
          message: "A path the daemon serves awaits `launch`.",
        },
        {
          selector: "Identifier[name='runTmux']",
          message: "A path the daemon serves awaits `runTmuxAsync`.",
        },
        ...CLOCK_SYNTAX,
      ],
    },
  },
  // [LAW:effects-at-boundaries] `createDaemon` reaches the machine through its
  // inputs (DaemonAdapters): neither the network nor the disk is named in it.
  {
    files: ["src/daemon/daemon.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Take `fetch` from the daemon's inputs." },
        ...CLOCK_GLOBALS,
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='launchSync']",
          message: "A path the daemon serves awaits `launch`.",
        },
        {
          selector: "Identifier[name='runTmux']",
          message: "A path the daemon serves awaits `runTmuxAsync`.",
        },
        ...CLOCK_SYNTAX,
      ],
    },
  },
  {
    files: ["src/daemon/server.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='launchSync']",
          message: "A path the daemon serves awaits `launch`.",
        },
        ...CLOCK_SYNTAX,
      ],
    },
  },
  {
    ignores: [
      "node_modules/",
      "dist/",
      "**/*.d.ts",
      "**/*.js",
      "!src/**/*.js",
      "!eslint.config.mjs",
    ],
  },
];
