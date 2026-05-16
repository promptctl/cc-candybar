import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { launchSync } from "../proc/launch";
import { tryClickViaDaemon } from "../daemon/client";
import { obtainDaemonKick } from "../daemon/acquire";

// [LAW:one-source-of-truth] Replaced at build time by tsdown's `define` option
// from package.json. The pinned version is what we write into settings.json so
// pnpm's content-addressable cache key changes on every release — no stale
// versions sticking around because of `@latest` resolution.
declare const __PACKAGE_VERSION__: string;
const PACKAGE_VERSION =
  typeof __PACKAGE_VERSION__ !== "undefined" ? __PACKAGE_VERSION__ : "dev";

const PACKAGE_NAME = "@promptctl/cc-candybar";
const URL_SCHEME = "cc-candybar";
const BUNDLE_ID = "com.cccandybar.url-handler";
const APP_NAME = "CCCandybarURLHandler";

// [LAW:one-source-of-truth] These are the renderer flags `cc-candybar
// install` writes into ~/.claude/settings.json when invoked with no args.
// To override, pass renderer flags after `install`.
//
// Note: theme/style/display.style are intentionally absent so the user
// inherits DEFAULT_CONFIG ("random" for all three) — installs get a fresh
// per-session look out of the box. Pass --style=<name> to lock it.
const DEFAULT_INSTALL_ARGS: readonly string[] = [
  "--layout",
  "directory git | model context block weekly sessionId tray",
  "--tray",
  // ▸ toggles the panel (3rd row). Future tray items: notification icons,
  // status indicators, more menu-expand buttons.
  "▸{toolbar-toggle(session.id)}",
  "--display",
  "autoWrap=false",
  "--show",
  "git=workingTree,upstream,timeSinceCommit",
  "--segment",
  [
    "block.type=weighted",
    "sessionId.length=8",
    "sessionId.clickAction.kind=url",
    "sessionId.clickAction.scheme=cc-candybar",
    // First action wraps the visible session id text (no glyph): copy.
    "sessionId.clickAction.actions.0.verb=copy",
    "sessionId.clickAction.actions.0.source=sessionId",
    // Second action: open the session JSONL transcript in VSCode.
    "sessionId.clickAction.actions.1.verb=open-vscode",
    "sessionId.clickAction.actions.1.source=transcriptPath",
    "sessionId.clickAction.actions.1.glyph=📄",
    // Third action: open the project working directory in VSCode.
    "sessionId.clickAction.actions.2.verb=open-vscode",
    "sessionId.clickAction.actions.2.source=projectDir",
    "sessionId.clickAction.actions.2.glyph=📂",
  ].join(","),
];

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
    category: "install.plutil",
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
    category: "install.plutil",
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
// session ids). Format: cc-candybar://<verb>/<value> | cc-candybar://<value> (verb=copy).
export function parseHandlerUrl(
  rawUrl: string,
  scheme: string = URL_SCHEME,
): ParsedUrl {
  const prefix = `${scheme}://`;
  if (!rawUrl.startsWith(prefix)) {
    throw new Error(`expected ${prefix} scheme, got: ${rawUrl}`);
  }
  const rest = rawUrl.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    return { verb: "copy", value: decodeURIComponent(rest) };
  }
  return {
    verb: decodeURIComponent(rest.slice(0, slash)),
    value: decodeURIComponent(rest.slice(slash + 1)),
  };
}

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

  // [LAW:dataflow-not-control-flow] Route through daemon first; local fallback
  // only when daemon is unreachable. Same pattern as render path: daemon-first
  // with graceful degradation.
  await runUrlHandleAsync(parsed);
}

async function runUrlHandleAsync(parsed: ParsedUrl): Promise<void> {
  const outcome = await tryClickViaDaemon(parsed.verb, parsed.value);
  if (outcome.ok) {
    process.exit(0);
  }

  // Daemon unavailable — fall back to local handlers so user clicks never
  // silently fail. Synchronously kick a daemon so the *next* click hits one.
  obtainDaemonKick();

  // [LAW:dataflow-not-control-flow] Verb dispatch table — each entry maps a
  // verb name to a handler that takes the parsed value. Adding a verb means
  // adding a row, not branching deeper.
  const handlers: Record<string, (value: string) => void> = {
    copy: copyToClipboard,
    "open-vscode": openInVscode,
    "toolbar-toggle": toggleToolbarExpanded,
    "theme-cycle": () => {},
    "style-cycle": () => {},
  };
  const handler = handlers[parsed.verb];
  if (!handler) {
    process.stderr.write(`url-handle: unknown verb "${parsed.verb}"\n`);
    process.exit(1);
  }
  handler(parsed.value);
  process.exit(0);
}

function copyToClipboard(text: string): void {
  const result = launchSync({
    bin: "/usr/bin/pbcopy",
    stdinInput: text,
    category: "install.pbcopy",
  });
  if (!result.ok) {
    process.stderr.write(`url-handle: pbcopy failed (${result.reason})\n`);
    process.exit(1);
  }
}

// Toggle the per-session flag at ~/.claude/.toolbar-state/<sessionId>.
// The value is the session id (passed via the cc-candybar:// URL by the toolbar
// item, e.g. `▸{toolbar-toggle(session.id)}`). Renderer reads this on the
// next refresh to decide whether to show `?`-prefixed extras for that session.
function toggleToolbarExpanded(sessionId: string): void {
  if (!sessionId) {
    process.stderr.write("toolbar-toggle: empty session id (ignored)\n");
    return;
  }
  // Reject path traversal — sessionId comes from a URL, treat as untrusted.
  if (sessionId.includes("/") || sessionId.includes("..")) {
    process.stderr.write(`toolbar-toggle: invalid session id "${sessionId}"\n`);
    return;
  }
  const dir = path.join(os.homedir(), ".claude", ".toolbar-state");
  const flagPath = path.join(dir, sessionId);
  if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(flagPath, "");
  }
}

function openInVscode(target: string): void {
  // [LAW:no-shared-mutable-globals] /usr/bin/open is a stable system path; -a
  // delegates app resolution to Launch Services so we don't have to know
  // where `code` is on PATH at click time.
  const result = launchSync({
    bin: "/usr/bin/open",
    args: ["-a", "Visual Studio Code", target],
    category: "install.open",
  });
  if (!result.ok) {
    process.stderr.write(
      `url-handle: open -a "Visual Studio Code" failed (${result.reason})\n`,
    );
    process.exit(1);
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
