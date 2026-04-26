import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const PACKAGE_NAME = "@promptctl/claude-powerline";
const URL_SCHEME = "cpwl";
const BUNDLE_ID = "com.promptctl.url-handler";
const APP_NAME = "PromptCtl URL Handler";

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
  "block.type=weighted,sessionId.length=8,sessionId.clickAction.kind=url,sessionId.clickAction.scheme=cpwl",
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
    `${PACKAGE_NAME}@latest`,
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
  return path.join(os.homedir(), "Library", "Application Support", "PromptCtl");
}

function stableScriptPath(): string {
  return path.join(supportDir(), "url-handler.mjs");
}

function appleScriptSource(nodePath: string, scriptPath: string): string {
  // [LAW:no-shared-mutable-globals] Bake absolute paths into the AppleScript
  // so click-time invocation doesn't depend on PATH, pnpm dlx cache state, or
  // a global npm install. The script path is a stable copy under
  // ~/Library/Application Support/PromptCtl that we own.
  const escNode = nodePath.replace(/"/g, '\\"');
  const escScript = scriptPath.replace(/"/g, '\\"');
  return [
    "on open location L",
    `\tdo shell script "'${escNode}' '${escScript}' url-handle " & quoted form of L`,
    "end open location",
  ].join("\n");
}

function copyDistToStableLocation(): string {
  // process.argv[1] is the running .mjs (bundled dist when published, or the
  // dlx-cached copy when invoked via `pnpm dlx`). Copy it to a stable path so
  // pnpm cache eviction doesn't break click-to-copy later.
  const source = process.argv[1];
  if (!source || !fs.existsSync(source)) {
    throw new Error(
      `install-url-handler: cannot locate the running script (process.argv[1]=${source}). The handler needs a stable copy of the bundled dist.`,
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

  if (parsed.verb === "copy") {
    copyToClipboard(parsed.value);
    return;
  }

  process.stderr.write(`url-handle: unknown verb "${parsed.verb}"\n`);
  process.exit(1);
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
