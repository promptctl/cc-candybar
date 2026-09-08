import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { launchSync } from "../proc/launch";
import { writeAtomic } from "../utils/atomic-write";
import { tryClickViaDaemon } from "../daemon/client";
import type { PermanentOutcome } from "../daemon/client-transport";
import { obtainDaemonKick } from "../daemon/acquire";
import { URL_SCHEME, VERB_COPY } from "../click/wire";
import { DISCLOSURE_GLYPH_CLOSED } from "../config/disclosure";
import { PACKAGE_VERSION } from "../version";
import { claudeSettingsPath } from "../claude-settings";
import {
  assessCurrency,
  currencyReport,
  fetchLatestVersion,
  PACKAGE_NAME,
  REGISTRY_URL,
} from "./currency";

const BUNDLE_ID = "com.cccandybar.url-handler";
const APP_NAME = "CCCandybarURLHandler";

// [LAW:one-source-of-truth] Install writes no renderer flags to settings.json.
const DEFAULT_INSTALL_ARGS: readonly string[] = [];

const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@promptctl/cc-candybar-darwin-arm64",
  "darwin-x64": "@promptctl/cc-candybar-darwin-x64",
  "linux-x64": "@promptctl/cc-candybar-linux-x64",
  "linux-arm64": "@promptctl/cc-candybar-linux-arm64",
};

function shellEscape(arg: string): string {
  // Safe characters that don't need quoting in any reasonable shell.
  if (/^[A-Za-z0-9_./=,:-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function buildStatusLineCommand(
  binPath: string,
  rendererArgs: readonly string[],
): string {
  return [binPath, ...rendererArgs].map(shellEscape).join(" ");
}

function appBundlePath(): string {
  return path.join(os.homedir(), "Applications", `${APP_NAME}.app`);
}

function ensureMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      `URL handler installation requires macOS (found platform: ${process.platform}).`,
    );
  }
}

// [LAW:one-source-of-truth] ONE stable path per platform, outside any store.
function supportDir(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "CCCandybar",
    );
  }
  const xdgData =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, "cc-candybar");
}

function stagedBinPath(): string {
  return path.join(supportDir(), "bin", "cc-candybar");
}

function stagedDistPath(): string {
  return path.join(supportDir(), "dist", "index.mjs");
}

function appleScriptSource(nodePath: string, scriptPath: string): string {
  // Bake absolute paths in so click-time invocation does not depend on PATH.
  const escNode = nodePath.replace(/"/g, '\\"');
  const escScript = scriptPath.replace(/"/g, '\\"');
  return [
    "on open location L",
    `\tdo shell script "'${escNode}' '${escScript}' url-handle " & quoted form of L`,
    "end open location",
  ].join("\n");
}

// [LAW:one-source-of-truth] The bundle containing THIS function is what stages.
export function locateBundledDist(argv1: string | undefined): string {
  if (!argv1) {
    throw new Error("install: process.argv[1] not set");
  }
  if (argv1.endsWith(".mjs") || argv1.endsWith(".js")) {
    return argv1;
  }
  return path.resolve(path.dirname(argv1), "..", "dist", "index.mjs");
}

// [LAW:one-type-per-behavior] Same contract either way; only the artifact differs.
type RenderEntry =
  | { kind: "native"; sourcePath: string }
  | { kind: "node-shim"; sourcePath: string };

function resolveRenderEntry(sourceDist: string): RenderEntry {
  const key = `${process.platform}-${process.arch}`;
  const pkgName = PLATFORM_PACKAGES[key];
  if (pkgName) {
    // Anchored to the bundle's real location, not this module's compiled form.
    const require = createRequire(sourceDist);
    try {
      return {
        kind: "native",
        sourcePath: require.resolve(`${pkgName}/bin/cc-candybar`),
      };
    } catch {
      // [LAW:no-silent-failure] Optional dep absent; the caller announces it.
    }
  }
  return {
    kind: "node-shim",
    sourcePath: path.resolve(
      path.dirname(sourceDist),
      "..",
      "bin",
      "cc-candybar",
    ),
  };
}

function stageFile(source: string, dest: string): void {
  // Identity is "already staged": copyFileSync would truncate onto itself.
  if (path.resolve(source) === path.resolve(dest)) return;
  fs.copyFileSync(source, dest);
}

// [LAW:one-source-of-truth] The staged file is the authority: a re-run's
// identity path can preserve a native binary the source lookup cannot see.
function stagedEntryKind(binPath: string): RenderEntry["kind"] {
  const fd = fs.openSync(binPath, "r");
  try {
    const magic = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, magic, 0, 2, 0);
    if (bytesRead < 2) {
      throw new Error(
        `install: staged render entry at ${binPath} is truncated ` +
          `(${bytesRead} byte(s)). Re-run: pnpm dlx ${PACKAGE_NAME}@latest install`,
      );
    }
    return magic.toString("latin1") === "#!" ? "node-shim" : "native";
  } finally {
    fs.closeSync(fd);
  }
}

export interface StagedRuntime {
  binPath: string;
  distPath: string;
  entryKind: RenderEntry["kind"];
}

// Adjacency IS the contract: every entry flavor locates ../dist/index.mjs.
export function runStageRuntime(): StagedRuntime {
  const sourceDist = locateBundledDist(process.argv[1]);
  if (!fs.existsSync(sourceDist)) {
    throw new Error(
      `install: bundled dist not found at ${sourceDist}. Reinstall the package.`,
    );
  }

  const entry = resolveRenderEntry(sourceDist);
  if (!fs.existsSync(entry.sourcePath)) {
    throw new Error(
      `install: render entry not found at ${entry.sourcePath}. Reinstall the package.`,
    );
  }

  fs.mkdirSync(path.dirname(stagedDistPath()), { recursive: true });
  fs.mkdirSync(path.dirname(stagedBinPath()), { recursive: true });
  stageFile(sourceDist, stagedDistPath());
  stageFile(entry.sourcePath, stagedBinPath());
  fs.chmodSync(stagedBinPath(), 0o755);

  fs.rmSync(path.join(supportDir(), "url-handler.mjs"), { force: true });

  const stagedKind = stagedEntryKind(stagedBinPath());
  process.stdout.write(
    `Staged cc-candybar v${PACKAGE_VERSION} runtime at ${supportDir()}\n` +
      (stagedKind === "native"
        ? `  render entry: native binary (${process.platform}-${process.arch})\n`
        : `  render entry: node shim (no native binary for ${process.platform}-${process.arch}; renders are correct but pay node startup)\n`),
  );
  return {
    binPath: stagedBinPath(),
    distPath: stagedDistPath(),
    entryKind: stagedKind,
  };
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

function installUrlHandlerFrom(stagedDist: string): void {
  const bundle = appBundlePath();
  fs.mkdirSync(path.dirname(bundle), { recursive: true });

  if (fs.existsSync(bundle)) {
    fs.rmSync(bundle, { recursive: true, force: true });
  }

  process.stdout.write(`Building ${bundle}\n`);
  const osa = launchSync({
    bin: "/usr/bin/osacompile",
    args: ["-o", bundle, "-e", appleScriptSource(process.execPath, stagedDist)],
    category: "install.osacompile",
  });
  if (!osa.ok) {
    process.stderr.write(osa.stderr);
    throw new Error(`osacompile failed (${osa.reason})`);
  }

  const plistPath = path.join(bundle, "Contents", "Info.plist");

  for (const { key } of infoPlistPatch()) {
    // plutil errors if the key exists; pre-delete so this is idempotent.
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

export function runInstallUrlHandler(): void {
  ensureMacOS();
  const staged = runStageRuntime();
  installUrlHandlerFrom(staged.distPath);
}

interface ParsedUrl {
  verb: string;
  value: string;
}

// [LAW:dataflow-not-control-flow] Parsed without `new URL`, which lowercases
// hosts. [LAW:single-enforcer] Only the VERB is decoded; verbs decode values.
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
    return { verb: VERB_COPY, value: rest };
  }
  return {
    verb: decodeURIComponent(rest.slice(0, slash)),
    value: rest.slice(slash + 1),
  };
}

// [LAW:single-enforcer] A thin IPC shim: the daemon is the only writer of click
// state, so a permanent outcome exits non-zero, never a local fallback.
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
    obtainDaemonKick();
    process.stderr.write(
      `url-handle: daemon unavailable (${outcome.cause}: ${outcome.message})\n`,
    );
    process.exit(1);
  }

  process.stderr.write(formatPermanent(outcome) + "\n");
  process.exit(1);
}

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

function installSuccessMessage(): string {
  return (
    `✓ install complete.\n` +
    `  Restart Claude Code to pick up the new statusline.\n` +
    `  Tip: every bar carries a settings menu — click ☰ ${DISCLOSURE_GLYPH_CLOSED} for preset\n` +
    `  switching, edit mode, and clickable theme/look/style/wrap/padding controls.\n`
  );
}

export async function runInstall(rendererArgs: string[]): Promise<void> {
  const force = rendererArgs.includes("--force");
  const filteredArgs = rendererArgs.filter((a) => a !== "--force");

  const argsToInstall =
    filteredArgs.length > 0 ? filteredArgs : [...DEFAULT_INSTALL_ARGS];

  const staged = runStageRuntime();

  if (process.platform === "darwin") {
    installUrlHandlerFrom(staged.distPath);
  } else {
    process.stdout.write(
      "Skipping URL handler (cmd-click verbs are macOS-only).\n",
    );
  }

  updateClaudeSettings(staged.binPath, argsToInstall, force);

  process.stdout.write(installSuccessMessage());

  // [LAW:no-ambient-temporal-coupling] Last: the synchronous work above blocks
  // the event loop, so a fetch started earlier would burn its budget idle.
  const report = currencyReport(
    PACKAGE_NAME,
    assessCurrency(
      PACKAGE_VERSION,
      await fetchLatestVersion(PACKAGE_NAME, fetch, REGISTRY_URL),
    ),
  );
  process[report.stream].write(report.text);
}

function updateClaudeSettings(
  binPath: string,
  rendererArgs: readonly string[],
  force: boolean,
  overridePath?: string,
): void {
  const target = overridePath ?? claudeSettingsPath();
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
  // [LAW:one-source-of-truth] Anything not ours is the user's, and stays.
  // [LAW:types-are-the-program] Token, not prefix: `<binPath>-backup` is not us.
  const managedTokens = [binPath, shellEscape(binPath)];
  const isOurs =
    typeof existing === "string" &&
    (existing.startsWith(`pnpm dlx ${PACKAGE_NAME}@`) ||
      managedTokens.some(
        (token) => existing === token || existing.startsWith(`${token} `),
      ));

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
    command: buildStatusLineCommand(binPath, rendererArgs),
  };

  writeAtomic(target, JSON.stringify(settings, null, 2));
  process.stdout.write(`Updated ${target}\n`);
}

export const __test__ = {
  shellEscape,
  buildStatusLineCommand,
  DEFAULT_INSTALL_ARGS,
  updateClaudeSettings,
  resolveRenderEntry,
  stageFile,
  stagedEntryKind,
  installSuccessMessage,
};
