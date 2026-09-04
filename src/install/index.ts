import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { launchSync } from "../proc/launch";
import { tryClickViaDaemon } from "../daemon/client";
import type { PermanentOutcome } from "../daemon/client-transport";
import { obtainDaemonKick } from "../daemon/acquire";
import { URL_SCHEME, VERB_COPY } from "../click/wire";
import { DISCLOSURE_GLYPH_CLOSED } from "../config/disclosure";
import { PACKAGE_VERSION } from "../version";
import { assessCurrency, currencyReport, fetchLatestVersion } from "./currency";

const PACKAGE_NAME = "@promptctl/cc-candybar";
const BUNDLE_ID = "com.cccandybar.url-handler";
const APP_NAME = "CCCandybarURLHandler";

// [LAW:one-source-of-truth] `install` writes no renderer flags into
// ~/.claude/settings.json. All authoring lives in `.cc-candybar.json5` or
// `.cc-candybar.json` (see resolveDslConfigPath — both extensions accepted,
// .json5 preferred); the install command's job is staging the runtime,
// wiring the URL handler, and pointing settings at the staged entry.
const DEFAULT_INSTALL_ARGS: readonly string[] = [];

// [LAW:one-type-per-behavior] One platform → one package name; the render
// entry is the same contract everywhere, only the artifact differs.
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

// [LAW:one-source-of-truth] The staged runtime lives at ONE stable path per
// platform, outside any package manager's store — pnpm cache pruning or a
// version bump can never yank the files the statusline and daemon run from.
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
  // Bake absolute paths into the AppleScript so click-time invocation doesn't
  // depend on PATH or install-time cache state. The dist bundle is fully
  // self-contained (tsdown noExternal), so no NODE_PATH is needed.
  const escNode = nodePath.replace(/"/g, '\\"');
  const escScript = scriptPath.replace(/"/g, '\\"');
  return [
    "on open location L",
    `\tdo shell script "'${escNode}' '${escScript}' url-handle " & quoted form of L`,
    "end open location",
  ].join("\n");
}

// [LAW:one-source-of-truth] The bundle that contains *this* function is
// the thing we need to stage. Two invocation paths reach us:
//   - via the bin shim: process.argv[1] = ".../bin/cc-candybar" which
//     dynamically imports ../dist/index.mjs — resolve the sibling dist.
//   - direct node:      process.argv[1] = ".../dist/index.mjs". Use as-is.
export function locateBundledDist(argv1: string | undefined): string {
  if (!argv1) {
    throw new Error("install: process.argv[1] not set");
  }
  if (argv1.endsWith(".mjs") || argv1.endsWith(".js")) {
    return argv1;
  }
  // Treat argv[1] as a bin shim and assume sibling dist/index.mjs.
  return path.resolve(path.dirname(argv1), "..", "dist", "index.mjs");
}

// The staged render entry: the prebuilt native binary when this platform has
// one, else the node bin shim. Same contract either way — read hookData on
// stdin, resolve ../dist/index.mjs by adjacency — so downstream code never
// cares which flavor was staged. [LAW:one-type-per-behavior]
type RenderEntry =
  | { kind: "native"; sourcePath: string }
  | { kind: "node-shim"; sourcePath: string };

function resolveRenderEntry(sourceDist: string): RenderEntry {
  const key = `${process.platform}-${process.arch}`;
  const pkgName = PLATFORM_PACKAGES[key];
  if (pkgName) {
    // Anchored to the bundle's real location, not this module's compiled
    // form (which ts-jest loads as CJS where import.meta is illegal) — the
    // platform package lives in node_modules beside the installed dist.
    const require = createRequire(sourceDist);
    try {
      return {
        kind: "native",
        sourcePath: require.resolve(`${pkgName}/bin/cc-candybar`),
      };
    } catch {
      // Optional dependency absent (unsupported install, pruned optionals).
      // Falls through to the node shim — announced by the caller, never
      // silent. [LAW:no-silent-failure]
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
  // Re-running install FROM the staged runtime makes source === dest;
  // copyFileSync would truncate the file onto itself. Identity is "already
  // staged", not an error.
  if (path.resolve(source) === path.resolve(dest)) return;
  fs.copyFileSync(source, dest);
}

// [LAW:one-source-of-truth] The staged file is the authority on what got
// staged. resolveRenderEntry's kind describes the *source lookup*, and on a
// re-run from the staged runtime that lookup resolves the identity path
// (source === dest), preserving whatever is on disk — possibly a native
// binary from a prior install that the lookup couldn't see. So the announced
// kind derives from the artifact itself: both flavors are ours, and the node
// shim is a "#!" script while the native binary is Mach-O/ELF.
function stagedEntryKind(binPath: string): RenderEntry["kind"] {
  const fd = fs.openSync(binPath, "r");
  try {
    const magic = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, magic, 0, 2, 0);
    // [LAW:no-silent-failure] Under 2 bytes neither flavor exists — the file
    // is a corrupt artifact (a crashed prior copy preserved by the identity
    // path), not a native binary.
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

// Stage the full runtime at the stable path: dist/index.mjs (daemon + CLI
// bundle) and bin/cc-candybar (render entry) as adjacent files. Adjacency IS
// the contract — every entry flavor locates the bundle via ../dist/index.mjs.
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

  // The pre-1.21 layout kept a second copy of the bundle as url-handler.mjs;
  // dist/index.mjs is the one staged bundle now. Remove the stale copy so it
  // can't drift. [LAW:one-source-of-truth]
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

// Callers establish the macOS precondition ([LAW:single-enforcer] — the
// subcommand entry checks before any side effect; runInstall reaches here
// only through its darwin dispatch).
function installUrlHandlerFrom(stagedDist: string): void {
  const bundle = appBundlePath();
  fs.mkdirSync(path.dirname(bundle), { recursive: true });

  // If a previous handler exists, remove it so osacompile can write fresh.
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

export function runInstallUrlHandler(): void {
  // Precondition before any side effect: on a non-mac this fails with zero
  // files written, not after staging the runtime.
  ensureMacOS();
  const staged = runStageRuntime();
  installUrlHandlerFrom(staged.distPath);
}

interface ParsedUrl {
  verb: string;
  value: string;
}

// [LAW:dataflow-not-control-flow] Parse the URL into a {verb, value} pair
// without using `new URL`, which lowercases hosts (would mangle case-sensitive
// session ids). Format: cc-candybar://<verb>/<tail> | cc-candybar://<value>
// (bare → copy). The verb ends at the FIRST `/`; everything after is the raw
// value. The dispatch effect list rides as `dispatch/e=…&e=…`, so its query-
// style payload is just the tail — `?` is NOT a delimiter, it is ordinary data
// in a bare-copy value (`cc-candybar://hello?world` copies "hello?world").
//
// [LAW:single-enforcer] Only the VERB is decoded here. The value is passed RAW
// to the daemon; each verb's handler decodes its own value at its boundary (the
// verb that owns the structure owns its decode). A whole-value decode here would
// un-escape structural separators inside a nested value — the exact hazard that
// made compound clicks unrepresentable — so it is deliberately absent.
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

// [LAW:effects-at-boundaries] Pure string builder — runInstall performs the
// actual write. Kept separate so the message content is testable without
// driving the full (fs + Launch Services) install side effects.
// [LAW:one-source-of-truth] The disclosure glyph comes from config/disclosure.ts,
// the same constant the theme/look picker itself renders with, so this tip
// can't drift from what the bundled default bar actually shows.
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

  // Last: a stale-version warning is the final thing on screen, and the
  // lookup starts only after the synchronous work above — spawnSync blocks
  // the event loop, so a fetch started earlier could not progress and would
  // burn its timeout budget idle. [LAW:no-ambient-temporal-coupling] The
  // staged runtime works either way; the verdict informs, it never fails the
  // install. [LAW:no-silent-failure]
  const report = currencyReport(
    PACKAGE_NAME,
    assessCurrency(
      PACKAGE_VERSION,
      await fetchLatestVersion(PACKAGE_NAME, fetch),
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
  // [LAW:one-source-of-truth] Detection: a command we (or a prior version of
  // us) wrote either starts with the legacy `pnpm dlx` form (an open prefix —
  // a version suffix follows) or has the staged bin path — quoted or bare —
  // as its entire first token. Any other value is a user customization we
  // must not silently destroy.
  // [LAW:types-are-the-program] Token, not prefix: a bare startsWith(binPath)
  // would also claim `<binPath>-backup …` as ours and overwrite it.
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

  fs.writeFileSync(target, JSON.stringify(settings, null, 2));
  process.stdout.write(`Updated ${target}\n`);
}

// Exports for testing
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
