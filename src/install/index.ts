import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchSync } from "../proc/launch";
import { tryClickViaDaemon } from "../daemon/client";
import type { PermanentOutcome } from "../daemon/client";
import { obtainDaemonKick } from "../daemon/acquire";
import { URL_SCHEME, VERB_COPY } from "../click/wire";

// [LAW:one-source-of-truth] Replaced at build time by tsdown's `define` option
// from package.json. The pinned version is what we write into settings.json so
// pnpm's content-addressable cache key changes on every release — no stale
// versions sticking around because of `@latest` resolution.
declare const __PACKAGE_VERSION__: string;
const PACKAGE_VERSION =
  typeof __PACKAGE_VERSION__ !== "undefined" ? __PACKAGE_VERSION__ : "dev";

const PACKAGE_NAME = "@promptctl/cc-candybar";
const BUNDLE_ID = "com.cccandybar.url-handler";
const APP_NAME = "CCCandybarURLHandler";

// [LAW:one-source-of-truth] `install` writes no renderer flags into
// ~/.claude/settings.json. The previous CLI override apparatus (--layout,
// --tray, --display, --show, --segment) is gone (bzh.2). All authoring now
// lives in `.cc-candybar.json5` or `.cc-candybar.json` (see
// resolveDslConfigPath — both extensions are accepted, .json5 preferred);
// the install command's job is just to wire the URL handler and the daemon
// entry. To customize, users edit a config file at one of the resolution
// paths or copy src/demo/statusline.json5 as a starting point.
const DEFAULT_INSTALL_ARGS: readonly string[] = [];

function shellEscape(arg: string): string {
  // Safe characters that don't need quoting in any reasonable shell.
  if (/^[A-Za-z0-9_./=,:-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function buildStatusLineCommand(rendererArgs: readonly string[]): string {
  return [
    "pnpm",
    "dlx",
    `${PACKAGE_NAME}@${PACKAGE_VERSION}`,
    ...rendererArgs.map(shellEscape),
  ].join(" ");
}

function appBundlePath(): string {
  return path.join(os.homedir(), "Applications", `${APP_NAME}.app`);
}

function settingsJsonPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function ensureMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      `URL handler installation requires macOS (found platform: ${process.platform}).`,
    );
  }
}

function supportDir(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "CCCandybar",
  );
}

function stableScriptPath(): string {
  return path.join(supportDir(), "url-handler.mjs");
}

function appleScriptSource(
  nodePath: string,
  scriptPath: string,
  nodeModulesPath: string,
): string {
  // [LAW:no-shared-mutable-globals] Bake absolute paths into the AppleScript
  // so click-time invocation doesn't depend on PATH, pnpm dlx cache state, or
  // a global npm install. The script path is a stable copy under
  // ~/Library/Application Support/CCCandybar that we own. NODE_PATH
  // points at the project's node_modules so the handler can resolve deps
  // (rich-js etc.) without being co-located with a package.json.
  const escNode = nodePath.replace(/"/g, '\\"');
  const escScript = scriptPath.replace(/"/g, '\\"');
  const escModules = nodeModulesPath.replace(/"/g, '\\"');
  return [
    "on open location L",
    `\tdo shell script "NODE_PATH='${escModules}' '${escNode}' '${escScript}' url-handle " & quoted form of L`,
    "end open location",
  ].join("\n");
}

// [LAW:one-source-of-truth] The bundle that contains *this* function is
// the thing we need to copy to a stable location. Two invocation paths
// reach us:
//   - via the bin shim: process.argv[1] = ".../bin/cc-candybar" which
//     does `import '../dist/index.mjs'`. Copying the shim itself would
//     break — its relative import wouldn't resolve from the new location.
//     So resolve to the sibling dist/index.mjs.
//   - direct node:      process.argv[1] = ".../dist/index.mjs". Use as-is.
export function locateBundledDist(argv1: string | undefined): string {
  if (!argv1) {
    throw new Error("install-url-handler: process.argv[1] not set");
  }
  if (argv1.endsWith(".mjs") || argv1.endsWith(".js")) {
    return argv1;
  }
  // Treat argv[1] as a bin shim and assume sibling dist/index.mjs.
  return path.resolve(path.dirname(argv1), "..", "dist", "index.mjs");
}

function copyDistToStableLocation(): string {
  const source = locateBundledDist(process.argv[1]);
  if (!fs.existsSync(source)) {
    throw new Error(
      `install-url-handler: bundled dist not found at ${source}. Reinstall the package.`,
    );
  }
  fs.mkdirSync(supportDir(), { recursive: true });
  const dest = stableScriptPath();
  fs.copyFileSync(source, dest);
  return dest;
}

function infoPlistPatch(): Array<{ key: string; xml: string }> {
  return [
    {
      key: "CFBundleIdentifier",
      xml: `<string>${BUNDLE_ID}</string>`,
    },
    {
      key: "CFBundleURLTypes",
      xml: [
        "<array>",
        "  <dict>",
        "    <key>CFBundleURLName</key>",
        `    <string>Claude Powerline Click Action</string>`,
        "    <key>CFBundleURLSchemes</key>",
        "    <array>",
        `      <string>${URL_SCHEME}</string>`,
        "    </array>",
        "  </dict>",
        "</array>",
      ].join("\n"),
    },
  ];
}

export function runInstallUrlHandler(): void {
  ensureMacOS();

  const stableScript = copyDistToStableLocation();
  process.stdout.write(`Copied dist to ${stableScript}\n`);

  // [LAW:one-source-of-truth] Derive node_modules from the source dist path
  // (dist/index.mjs → ../node_modules). The stable copy lives elsewhere but
  // needs the same node_modules to resolve deps at click time.
  const sourceDist = locateBundledDist(process.argv[1]);
  const nodeModules = path.join(path.dirname(sourceDist), "..", "node_modules");
  if (!fs.existsSync(nodeModules)) {
    throw new Error(
      `install-url-handler: node_modules not found at ${nodeModules}. Install deps first.`,
    );
  }

  const bundle = appBundlePath();
  fs.mkdirSync(path.dirname(bundle), { recursive: true });

  // If a previous handler exists, remove it so osacompile can write fresh.
  if (fs.existsSync(bundle)) {
    fs.rmSync(bundle, { recursive: true, force: true });
  }

  process.stdout.write(`Building ${bundle}\n`);
  const osa = launchSync({
    bin: "/usr/bin/osacompile",
    args: [
      "-o",
      bundle,
      "-e",
      appleScriptSource(process.execPath, stableScript, nodeModules),
    ],
    category: "install.osacompile",
  });
  if (!osa.ok) {
    process.stderr.write(osa.stderr);
    throw new Error(`osacompile failed (${osa.reason})`);
  }

  const plistPath = path.join(bundle, "Contents", "Info.plist");

  for (const { key } of infoPlistPatch()) {
    // plutil errors if the key already exists; pre-delete so the operation is
    // idempotent. Ignore failures (key may not exist on a fresh build).
    launchSync({
      bin: "/usr/bin/plutil",
      args: ["-remove", key, plistPath],
      category: "install.plutil",
    });
  }

  for (const { key, xml } of infoPlistPatch()) {
    const r = launchSync({
      bin: "/usr/bin/plutil",
      args: ["-insert", key, "-xml", xml, plistPath],
      category: "install.plutil",
    });
    if (!r.ok) {
      process.stderr.write(r.stderr);
      throw new Error(`plutil -insert ${key} failed (${r.reason})`);
    }
  }

  process.stdout.write(`Registering ${URL_SCHEME}:// with Launch Services\n`);
  const lsr = launchSync({
    bin: "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    args: ["-f", bundle],
    category: "install.lsregister",
  });
  if (!lsr.ok) {
    process.stderr.write(lsr.stderr);
    throw new Error(`lsregister failed (${lsr.reason})`);
  }

  process.stdout.write(`✓ ${APP_NAME}.app installed and registered.\n`);
  process.stdout.write(
    `  Test: open '${URL_SCHEME}://hello-world' && pbpaste\n`,
  );
}

interface ParsedUrl {
  verb: string;
  value: string;
}

// [LAW:dataflow-not-control-flow] Parse the URL into a {verb, value} pair
// without using `new URL`, which lowercases hosts (would mangle case-sensitive
// session ids). Format: cc-candybar://<verb>/<tail> | cc-candybar://<verb>?<query>
// | cc-candybar://<value> (bare → copy). The verb ends at the first `/` (path
// tail) or `?` (query, used by the `dispatch` effect list).
//
// [LAW:single-enforcer] Only the VERB is decoded here. The value is passed RAW
// to the daemon; each verb's handler decodes its own segments at its boundary
// (the verb that owns the structure owns its decode). A whole-value decode here
// would un-escape structural separators inside a nested value — the exact hazard
// that made compound clicks unrepresentable — so it is deliberately absent.
export function parseHandlerUrl(
  rawUrl: string,
  scheme: string = URL_SCHEME,
): ParsedUrl {
  const prefix = `${scheme}://`;
  if (!rawUrl.startsWith(prefix)) {
    throw new Error(`expected ${prefix} scheme, got: ${rawUrl}`);
  }
  const rest = rawUrl.slice(prefix.length);
  const delim = rest.search(/[/?]/);
  if (delim === -1) {
    return { verb: VERB_COPY, value: rest };
  }
  return {
    verb: decodeURIComponent(rest.slice(0, delim)),
    value: rest.slice(delim + 1),
  };
}

// [LAW:single-enforcer] url-handle is a thin IPC shim: parse the URL, send
// the click request to the daemon, exit. There is NO in-process verb
// dispatch and NO direct disk mutation. The daemon is the only writer of
// click-side state ([LAW:one-source-of-truth] for SessionState); kicking a
// daemon on a transient failure is the only recovery, and it's
// fire-and-forget so the next click hits a warm daemon.
//
// A `permanent` daemon outcome (BAD_REQUEST for an unknown verb,
// VERSION_MISMATCH against a future daemon) exits non-zero with the daemon's
// error message so the failure is visible — never silently swallowed by a
// local fallback that would diverge from the daemon's truth.
export async function runUrlHandle(rawUrl: string | undefined): Promise<void> {
  if (!rawUrl) {
    process.stderr.write("url-handle: missing URL argument.\n");
    process.exit(1);
  }

  let parsed: ParsedUrl;
  try {
    parsed = parseHandlerUrl(rawUrl);
  } catch (err) {
    process.stderr.write(
      `url-handle: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const outcome = await tryClickViaDaemon(parsed.verb, parsed.value);
  if (outcome.kind === "ok") {
    process.exit(0);
  }

  if (outcome.kind === "transient") {
    // [LAW:dataflow-not-control-flow] Fire-and-forget kick; the user's click
    // is lost (the daemon couldn't service it), but the next click hits a
    // warm daemon. Mirrors the render-path's transient recovery.
    obtainDaemonKick();
    process.stderr.write(
      `url-handle: daemon unavailable (${outcome.cause}: ${outcome.message})\n`,
    );
    process.exit(1);
  }

  // [LAW:dataflow-not-control-flow] Format each permanent cause from its
  // own typed payload, not by probing for "message" on a generic outcome.
  // The PermanentOutcome union already discriminates by `cause`; the switch
  // mirrors that discriminator one-to-one and pulls the right fields.
  process.stderr.write(formatPermanent(outcome) + "\n");
  process.exit(1);
}

// [LAW:single-enforcer] One place that turns a PermanentOutcome into a
// human-readable diagnostic. Each cause carries its own payload (version
// mismatch carries the protocol numbers; everything else carries a
// message); the formatter consumes exactly the fields the cause defines.
function formatPermanent(outcome: PermanentOutcome): string {
  switch (outcome.cause) {
    case "version_mismatch":
      return `url-handle: daemon rejected click (version mismatch: client v${outcome.clientV} ≠ daemon v${outcome.daemonV})`;
    case "bad_request":
      return `url-handle: daemon rejected click (bad request: ${outcome.message})`;
    case "render_failed":
      return `url-handle: daemon rejected click (handler failed: ${outcome.message})`;
    case "malformed_response":
      return `url-handle: daemon rejected click (malformed response: ${outcome.message})`;
  }
}

export function runInstall(rendererArgs: string[]): void {
  ensureMacOS();

  const force = rendererArgs.includes("--force");
  const filteredArgs = rendererArgs.filter((a) => a !== "--force");

  const argsToInstall =
    filteredArgs.length > 0 ? filteredArgs : [...DEFAULT_INSTALL_ARGS];

  runInstallUrlHandler();
  updateClaudeSettings(argsToInstall, force);

  process.stdout.write(`✓ install complete.\n`);
  process.stdout.write(
    `  Restart Claude Code to pick up the new statusline.\n`,
  );
}

function updateClaudeSettings(
  rendererArgs: readonly string[],
  force: boolean,
  overridePath?: string,
): void {
  const target = overridePath ?? settingsJsonPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let settings: Record<string, any> = {};
  if (fs.existsSync(target)) {
    try {
      settings = JSON.parse(fs.readFileSync(target, "utf-8"));
    } catch (err) {
      throw new Error(
        `Could not parse ${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const existing = settings.statusLine?.command as string | undefined;
  // [LAW:one-source-of-truth] Detection: if the existing command starts with
  // our package prefix, we (or a prior version of us) wrote it. Any other
  // value is a user customization we must not silently destroy.
  const managedPrefix = `pnpm dlx ${PACKAGE_NAME}@`;
  const isOurs =
    typeof existing === "string" && existing.startsWith(managedPrefix);

  if (existing && !isOurs && !force) {
    process.stderr.write(
      `Skipping settings.json update: existing statusLine.command appears customized.\n` +
        `  Current: ${existing}\n` +
        `  To overwrite, re-run with --force.\n`,
    );
    return;
  }

  settings.statusLine = {
    type: "command",
    command: buildStatusLineCommand(rendererArgs),
  };

  fs.writeFileSync(target, JSON.stringify(settings, null, 2));
  process.stdout.write(`Updated ${target}\n`);
}

// Exports for testing
export const __test__ = {
  shellEscape,
  buildStatusLineCommand,
  DEFAULT_INSTALL_ARGS,
  updateClaudeSettings,
};
