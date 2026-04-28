import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

// [LAW:one-source-of-truth] Replaced at build time by tsdown's `define` option
// from package.json. The pinned version is what we write into settings.json so
// pnpm's content-addressable cache key changes on every release — no stale
// versions sticking around because of `@latest` resolution.
declare const __PACKAGE_VERSION__: string;
const PACKAGE_VERSION =
  typeof __PACKAGE_VERSION__ !== "undefined" ? __PACKAGE_VERSION__ : "dev";

const PACKAGE_NAME = "@promptctl/claude-powerline";
const URL_SCHEME = "cpwl";
const BUNDLE_ID = "com.claudepowerline.url-handler";
const APP_NAME = "ClaudePowerlineURLHandler";

// [LAW:one-source-of-truth] These are the renderer flags `claude-powerline
// install` writes into ~/.claude/settings.json when invoked with no args.
// To override, pass renderer flags after `install`.
const DEFAULT_INSTALL_ARGS: readonly string[] = [
  "--style=powerline",
  "--layout",
  "directory git | model context block weekly sessionId",
  "--display",
  "autoWrap=false",
  "--show",
  "git=workingTree,upstream,timeSinceCommit",
  "--segment",
  [
    "block.type=weighted",
    "sessionId.length=8",
    "sessionId.clickAction.kind=url",
    "sessionId.clickAction.scheme=cpwl",
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
    "ClaudePowerline",
  );
}

function stableScriptPath(): string {
  return path.join(supportDir(), "url-handler.mjs");
}

function appleScriptSource(nodePath: string, scriptPath: string): string {
  // [LAW:no-shared-mutable-globals] Bake absolute paths into the AppleScript
  // so click-time invocation doesn't depend on PATH, pnpm dlx cache state, or
  // a global npm install. The script path is a stable copy under
  // ~/Library/Application Support/ClaudePowerline that we own.
  const escNode = nodePath.replace(/"/g, '\\"');
  const escScript = scriptPath.replace(/"/g, '\\"');
  return [
    "on open location L",
    `\tdo shell script "'${escNode}' '${escScript}' url-handle " & quoted form of L`,
    "end open location",
  ].join("\n");
}

// [LAW:one-source-of-truth] The bundle that contains *this* function is
// the thing we need to copy to a stable location. Two invocation paths
// reach us:
//   - via the bin shim: process.argv[1] = ".../bin/claude-powerline" which
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

  const bundle = appBundlePath();
  fs.mkdirSync(path.dirname(bundle), { recursive: true });

  // If a previous handler exists, remove it so osacompile can write fresh.
  if (fs.existsSync(bundle)) {
    fs.rmSync(bundle, { recursive: true, force: true });
  }

  process.stdout.write(`Building ${bundle}\n`);
  execFileSync(
    "/usr/bin/osacompile",
    ["-o", bundle, "-e", appleScriptSource(process.execPath, stableScript)],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  const plistPath = path.join(bundle, "Contents", "Info.plist");

  for (const { key } of infoPlistPatch()) {
    // plutil errors if the key already exists; pre-delete so the operation is
    // idempotent. Ignore failures (key may not exist on a fresh build).
    spawnSync("/usr/bin/plutil", ["-remove", key, plistPath], {
      stdio: "ignore",
    });
  }

  for (const { key, xml } of infoPlistPatch()) {
    execFileSync("/usr/bin/plutil", ["-insert", key, "-xml", xml, plistPath], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  }

  process.stdout.write(`Registering ${URL_SCHEME}:// with Launch Services\n`);
  execFileSync(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", bundle],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

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
// session ids). Format: cpwl://<verb>/<value> | cpwl://<value> (verb=copy).
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

export function runUrlHandle(rawUrl: string | undefined): void {
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

  // [LAW:dataflow-not-control-flow] Verb dispatch table — each entry maps a
  // verb name to a handler that takes the parsed value. Adding a verb means
  // adding a row, not branching deeper.
  const handlers: Record<string, (value: string) => void> = {
    copy: copyToClipboard,
    "open-vscode": openInVscode,
  };
  const handler = handlers[parsed.verb];
  if (!handler) {
    process.stderr.write(`url-handle: unknown verb "${parsed.verb}"\n`);
    process.exit(1);
  }
  handler(parsed.value);
}

function copyToClipboard(text: string): void {
  const result = spawnSync("/usr/bin/pbcopy", [], { input: text });
  if (result.status !== 0) {
    process.stderr.write(
      `url-handle: pbcopy failed (status ${result.status})\n`,
    );
    process.exit(1);
  }
}

function openInVscode(target: string): void {
  // [LAW:no-shared-mutable-globals] /usr/bin/open is a stable system path; -a
  // delegates app resolution to Launch Services so we don't have to know
  // where `code` is on PATH at click time.
  const result = spawnSync("/usr/bin/open", [
    "-a",
    "Visual Studio Code",
    target,
  ]);
  if (result.status !== 0) {
    process.stderr.write(
      `url-handle: open -a "Visual Studio Code" failed (status ${result.status})\n`,
    );
    process.exit(1);
  }
}

export function runInstall(rendererArgs: string[]): void {
  ensureMacOS();

  const argsToInstall =
    rendererArgs.length > 0 ? rendererArgs : [...DEFAULT_INSTALL_ARGS];

  runInstallUrlHandler();
  updateClaudeSettings(argsToInstall);

  process.stdout.write(`✓ install complete.\n`);
  process.stdout.write(
    `  Restart Claude Code to pick up the new statusline.\n`,
  );
}

function updateClaudeSettings(rendererArgs: readonly string[]): void {
  const target = settingsJsonPath();
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
};
