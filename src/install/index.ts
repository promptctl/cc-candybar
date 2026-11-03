import {
  ATTACH_DIR,
  ATTACH_PRELOAD,
  attachPreloadOf,
} from "../attach-launcher.js";
import { sourceCheckoutOf } from "../daemon/build-currency.js";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { locations } from "../daemon/paths";
import type { Host, World } from "../host";
import { writeAtomic } from "../utils/atomic-write";
import { tryClickViaDaemon } from "../daemon/client";
import type {
  FailureOutcome,
  PermanentOutcome,
} from "../daemon/client-transport";
import { obtainDaemonKick } from "../daemon/acquire";
import { parseHandlerUrl, URL_SCHEME } from "../click/wire";
import { DOOR_GLYPH } from "../config/disclosure";
import { PACKAGE_VERSION } from "../version";
import { shellWord, singleQuoted } from "../shell-word";
import {
  claudeConfigDir,
  claudeSettingsPath,
  detectClaudeConfigDir,
  isJsonObject,
  readClaudeSettings,
  readClaudeSettingsText,
} from "../claude-settings";
import { JSON_DIALECT, setValue } from "../config/json5-edit";
import {
  assessCurrency,
  currencyReport,
  fetchLatestVersion,
  PACKAGE_NAME,
  REGISTRY_URL,
} from "./currency";
import { PLATFORM_PACKAGES } from "./platforms";

const BUNDLE_ID = "com.cccandybar.url-handler";
const APP_NAME = "CCCandybarURLHandler";
// The forwarder binary's name in a darwin platform package's `bin/`, as
// .github/workflows/release.yml stages it.
const FORWARDER_BIN = "cc-candybar-url-handler";

// [LAW:one-source-of-truth] `install` writes no renderer flags into
// ~/.claude/settings.json. All authoring lives in `.cc-candybar.json5` or
// `.cc-candybar.json` (see resolveDslConfig — both extensions accepted,
// .json5 preferred); the install command's job is staging the runtime,
// wiring the URL handler, and pointing settings at the staged entry.
const DEFAULT_INSTALL_ARGS: readonly string[] = [];

function buildStatusLineCommand(
  binPath: string,
  rendererArgs: readonly string[],
): string {
  return [binPath, ...rendererArgs].map(shellWord).join(" ");
}

function appBundlePath(host: Host): string {
  return path.join(host.home, "Applications", `${APP_NAME}.app`);
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
function supportDir(host: Host): string {
  if (process.platform === "darwin") {
    return path.join(host.home, "Library", "Application Support", "CCCandybar");
  }
  return path.join(locations(host).dataHome, "cc-candybar");
}

function stagedBinPath(dir: string): string {
  return path.join(dir, "bin", "cc-candybar");
}

function stagedDistPath(dir: string): string {
  return path.join(dir, "dist", "index.mjs");
}

// The attach preload a user can keep typing across upgrades: a checkout's
// own build, else the staged runtime's — never a package manager's store
// path, which an upgrade removes.
export function stableAttachPreload(runningBundle: string, host: Host): string {
  const checkout = sourceCheckoutOf(runningBundle);
  return attachPreloadOf(
    checkout === null
      ? stagedDistPath(supportDir(host))
      : path.join(checkout, "dist", "index.mjs"),
  );
}

// [LAW:one-source-of-truth] Where the forwarder's executable sits inside the
// app bundle install assembles, kept beside the writer: the doctor reads it to
// tell the forwarder from an applet an older install registered.
export function forwarderExecutable(app: string): string {
  return path.join(app, "Contents", "MacOS", APP_NAME);
}

// The forwarder binary: a checkout's own build (`just install-url-handler`),
// or the one the darwin platform package ships, by the running bundle's
// provenance — the same reading the update notice and the doctor make
// (sourceCheckoutOf). [LAW:no-silent-failure] Neither present is an error
// naming the path and how to make it exist; no applet is built in its place.
function resolveForwarder(sourceDist: string): string {
  const checkout = sourceCheckoutOf(sourceDist);
  if (checkout !== null) {
    const built = path.join(checkout, "bin", "cc-candybar-url-handler-native");
    if (!fs.existsSync(built)) {
      throw new Error(
        `install: the URL handler app is not built at ${built}. Run \`just install-url-handler\` in the checkout.`,
      );
    }
    return built;
  }
  const shipped = platformPackageFile(sourceDist, `bin/${FORWARDER_BIN}`);
  switch (shipped.kind) {
    case "found":
      return shipped.path;
    case "no-package":
      throw new Error(
        `install: no URL handler app ships for ${shipped.platform}; the scheme is macOS-only.`,
      );
    case "missing":
      throw new Error(
        `install: the URL handler app was not found in ${shipped.pkgName} (bin/${FORWARDER_BIN}). The optional platform package is missing or older than this release: reinstall the package.`,
      );
  }
}

// [LAW:one-source-of-truth] One lookup of a file the running platform's
// package ships, for everything install stages from it: the package is named
// by platform and arch (PLATFORM_PACKAGES) and resolved from the installed
// bundle's own node_modules, where the optional dependency lives — anchored
// to the bundle's real location, not this module's compiled form (which
// ts-jest loads as CJS where import.meta is illegal).
type PlatformPackageFile =
  | { kind: "found"; path: string }
  | { kind: "no-package"; platform: string }
  | { kind: "missing"; pkgName: string };

function platformPackageFile(
  sourceDist: string,
  file: string,
): PlatformPackageFile {
  const platform = `${process.platform}-${process.arch}`;
  const pkgName = PLATFORM_PACKAGES[platform];
  if (pkgName === undefined) return { kind: "no-package", platform };
  try {
    return {
      kind: "found",
      path: createRequire(sourceDist).resolve(`${pkgName}/${file}`),
    };
  } catch {
    return { kind: "missing", pkgName };
  }
}

// The staged render entry: the prebuilt native binary when this platform has
// one, else the node bin shim. Same contract either way — read hookData on
// stdin, resolve ../dist/index.mjs by adjacency — so downstream code never
// cares which flavor was staged. [LAW:one-type-per-behavior]
type RenderEntry =
  | { kind: "native"; sourcePath: string }
  | { kind: "node-shim"; sourcePath: string };

function resolveRenderEntry(sourceDist: string): RenderEntry {
  const shipped = platformPackageFile(sourceDist, "bin/cc-candybar");
  if (shipped.kind === "found") {
    return { kind: "native", sourcePath: shipped.path };
  }
  // No package for this platform, or the optional dependency absent (pruned
  // optionals): the node shim — announced by the caller, never silent.
  // [LAW:no-silent-failure]
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

// A directory staged whole: the previous stage's files are removed first, so
// none of them outlives the launcher it belonged to.
function stageDir(source: string, dest: string): void {
  if (path.resolve(source) === path.resolve(dest)) return;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(source, dest, { recursive: true });
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
// bundle), dist/cc-extra (the attach launcher), dist/attach-preload.cjs (its
// one-variable start) and bin/cc-candybar (render
// entry) as adjacent files. Adjacency IS
// the contract — every entry flavor locates the bundle via ../dist/index.mjs.
// `sourceDist` is the bundle this process runs, as its entry names it; `dir`
// is where it is staged — the user's stable path (`supportDir`), or a test's
// own.
export function runStageRuntime(
  sourceDist: string,
  dir: string,
): StagedRuntime {
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

  const attach = path.join(path.dirname(sourceDist), ATTACH_DIR);
  if (!fs.existsSync(attach)) {
    throw new Error(
      `install: the attach launcher was not found at ${attach}. Reinstall the package.`,
    );
  }

  const preload = path.join(path.dirname(sourceDist), ATTACH_PRELOAD);
  if (!fs.existsSync(preload)) {
    throw new Error(
      `install: the attach preload was not found at ${preload}. Reinstall the package.`,
    );
  }

  const distPath = stagedDistPath(dir);
  const binPath = stagedBinPath(dir);
  fs.mkdirSync(path.dirname(distPath), { recursive: true });
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  stageFile(sourceDist, distPath);
  stageDir(attach, path.join(path.dirname(distPath), ATTACH_DIR));
  stageFile(preload, path.join(path.dirname(distPath), ATTACH_PRELOAD));
  stageFile(entry.sourcePath, binPath);
  fs.chmodSync(binPath, 0o755);

  // The pre-1.21 layout kept a second copy of the bundle as url-handler.mjs;
  // dist/index.mjs is the one staged bundle now. Remove the stale copy so it
  // can't drift. [LAW:one-source-of-truth]
  fs.rmSync(path.join(dir, "url-handler.mjs"), { force: true });

  const stagedKind = stagedEntryKind(binPath);
  process.stdout.write(
    `Staged cc-candybar v${PACKAGE_VERSION} runtime at ${dir}\n` +
      (stagedKind === "native"
        ? `  render entry: native binary (${process.platform}-${process.arch})\n`
        : `  render entry: node shim (no native binary for ${process.platform}-${process.arch}; renders are correct but pay node startup)\n`),
  );
  return {
    binPath,
    distPath,
    entryKind: stagedKind,
  };
}

// The app's Info.plist, whole: an agent app (no Dock icon, no menu bar) that
// claims the scheme. [LAW:one-source-of-truth] The scheme and the bundle id
// are spelled here, from the constants the rest of the code reads; the Swift
// source spells neither.
function infoPlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleIdentifier</key>",
    `  <string>${BUNDLE_ID}</string>`,
    "  <key>CFBundleName</key>",
    `  <string>${APP_NAME}</string>`,
    // The name macOS puts on the notification-authorization prompt the app
    // raises on its first lost click; the user knows the product, not the
    // bundle.
    "  <key>CFBundleDisplayName</key>",
    "  <string>cc-candybar</string>",
    "  <key>CFBundleExecutable</key>",
    `  <string>${APP_NAME}</string>`,
    "  <key>CFBundlePackageType</key>",
    "  <string>APPL</string>",
    "  <key>CFBundleVersion</key>",
    `  <string>${PACKAGE_VERSION}</string>`,
    "  <key>CFBundleShortVersionString</key>",
    `  <string>${PACKAGE_VERSION}</string>`,
    "  <key>LSMinimumSystemVersion</key>",
    "  <string>12.0</string>",
    "  <key>LSUIElement</key>",
    "  <true/>",
    "  <key>CFBundleURLTypes</key>",
    "  <array>",
    "    <dict>",
    "      <key>CFBundleURLName</key>",
    "      <string>cc-candybar click</string>",
    "      <key>CFBundleURLSchemes</key>",
    "      <array>",
    `        <string>${URL_SCHEME}</string>`,
    "      </array>",
    "    </dict>",
    "  </array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

// Callers establish the macOS precondition ([LAW:single-enforcer] — the
// subcommand entry checks before any side effect; runInstall reaches here
// only through its darwin dispatch).
//
// The app is assembled around the prebuilt forwarder: the bundle is written
// fresh, ad-hoc signed (Launch Services registers a signed bundle; nothing
// here passes through Gatekeeper, since no package manager quarantines what it
// unpacks), the instance a previous install left resident is quit, and the
// scheme is registered. [LAW:no-ambient-temporal-coupling] The quit is
// install's: Launch Services never relaunches a running app, so without it a
// reinstall would leave the old forwarder delivering until logout.
function installUrlHandlerFrom(sourceDist: string, world: World): void {
  installUrlHandler(resolveForwarder(sourceDist), world);
}

// The app assembled around a forwarder binary already resolved: install
// resolves it first, as a precondition, so a checkout with no build or a
// package with no binary fails with nothing staged. [LAW:effects-at-boundaries]
function installUrlHandler(forwarder: string, { host, launcher }: World): void {
  const bundle = appBundlePath(host);

  // [LAW:effects-at-boundaries] The app is assembled and signed beside its
  // place, then renamed over the old one: a copy or a sign that fails leaves
  // the handler the user had, registered and whole, not a half bundle.
  const staging = `${bundle}.installing`;
  const executable = forwarderExecutable(staging);
  process.stdout.write(`Building ${bundle}\n`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(forwarder, executable);
    fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(staging, "Contents", "Info.plist"), infoPlist());

    const signed = launcher.launchSync({
      bin: "/usr/bin/codesign",
      args: ["--force", "--sign", "-", staging],
      category: "install.codesign",
    });
    if (!signed.ok) {
      process.stderr.write(signed.stderr);
      throw new Error(`codesign failed (${signed.reason})`);
    }
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.renameSync(staging, bundle);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  // killall exits 1 when no process matches, which is the other legal state
  // here: the app is only ever ours, in our own home, so no other exit 1 cause
  // (another user's process) applies.
  const quit = launcher.launchSync({
    bin: "/usr/bin/killall",
    args: [APP_NAME],
    category: "install.killall",
  });
  if (!quit.ok && quit.exitCode !== 1) {
    process.stderr.write(quit.stderr);
    throw new Error(`killall ${APP_NAME} failed (${quit.reason})`);
  }
  process.stdout.write(
    quit.ok
      ? `Quit the running ${APP_NAME}; the next click starts the new one\n`
      : `${APP_NAME} was not running\n`,
  );

  process.stdout.write(`Registering ${URL_SCHEME}:// with Launch Services\n`);
  const lsr = launcher.launchSync({
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

export function runInstallUrlHandler(bundle: string, world: World): void {
  // Precondition before any side effect: on a non-mac this fails with zero
  // files written, not after staging the runtime.
  ensureMacOS();
  const forwarder = resolveForwarder(bundle);
  runStageRuntime(bundle, supportDir(world.host));
  installUrlHandler(forwarder, world);
}

// [LAW:single-enforcer] url-handle is a thin IPC shim: parse the URL, send
// the click request to the daemon, exit. There is NO in-process verb
// dispatch and NO direct disk mutation. The daemon is the only writer of
// click-side state ([LAW:one-source-of-truth] for SessionState); kicking a
// daemon on a transient failure is the only recovery, and it's
// fire-and-forget so the next click hits a warm daemon. The tmux status
// line's click binding runs it (src/daemon/tmux-status.ts), with a command
// the daemon composes from its own bundle, so it cannot go stale; a link
// click in a terminal never comes this way, since the URL handler app forwards
// the raw link to the daemon itself.
//
// A `permanent` daemon outcome (BAD_REQUEST for an unknown verb,
// VERSION_MISMATCH against a future daemon) exits non-zero with the daemon's
// error message so the failure is visible — never silently swallowed by a
// local fallback that would diverge from the daemon's truth.
export async function runUrlHandle(
  rawUrl: string | undefined,
  world: World,
): Promise<void> {
  if (!rawUrl) {
    process.stderr.write("url-handle: missing URL argument.\n");
    process.exit(1);
  }

  const parsed = parseHandlerUrl(rawUrl);
  if (!parsed.ok) {
    process.stderr.write(`url-handle: ${parsed.problem}\n`);
    process.exit(1);
  }

  const outcome = await tryClickViaDaemon(world, parsed.verb, parsed.value);
  if (outcome.kind === "ok") {
    process.exit(0);
  }

  const plan = urlHandlePlan(outcome);
  // [LAW:dataflow-not-control-flow] Fire-and-forget kick; the user's click
  // is lost (no daemon answered it), but the next click hits a warm daemon.
  // Mirrors the render-path's transient recovery.
  if (plan.kick) obtainDaemonKick(world);
  process.stderr.write(plan.stderr);
  process.exit(plan.code);
}

// [LAW:effects-at-boundaries] What a failed click does, as data: the stderr
// line, the exit code, and whether to kick a daemon. runUrlHandle performs it.
export interface UrlHandlePlan {
  readonly stderr: string;
  readonly code: 0 | 1;
  readonly kick: boolean;
}

export function urlHandlePlan(outcome: FailureOutcome): UrlHandlePlan {
  switch (outcome.kind) {
    // A daemon holds the socket. Kicking would respawn a live daemon
    // mid-click. A non-zero exit is an error dialog from the handler app, so
    // it follows whether the click got to the listener (`phase`): sent
    // ("deadline"), it runs or is refused as stale and the daemon's log says
    // which — exit 0, as the click may well have landed; never written
    // ("connect"), nothing will run it — exit 1, so the user is told.
    case "busy":
      return {
        stderr: `url-handle: daemon busy (${outcome.message})\n`,
        code: outcome.phase === "connect" ? 1 : 0,
        kick: false,
      };
    case "transient":
      return {
        stderr: `url-handle: daemon unavailable (${outcome.cause}: ${outcome.message})\n`,
        code: 1,
        kick: true,
      };
    // [LAW:dataflow-not-control-flow] Format each permanent cause from its
    // own typed payload, not by probing for "message" on a generic outcome.
    // The PermanentOutcome union already discriminates by `cause`; the switch
    // mirrors that discriminator one-to-one and pulls the right fields.
    case "permanent":
      return { stderr: formatPermanent(outcome) + "\n", code: 1, kick: false };
  }
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
    case "switched_off":
      return `url-handle: daemon rejected click (switched off: ${outcome.message})`;
    case "malformed_response":
      return `url-handle: daemon rejected click (malformed response: ${outcome.message})`;
  }
}

// [LAW:effects-at-boundaries] Pure string builder — runInstall performs the
// actual write. Kept separate so the message content is testable without
// driving the full (fs + Launch Services) install side effects.
// [LAW:one-source-of-truth] The door's glyph comes from config/disclosure.ts,
// the same constant the bar's own settings door renders with, so this tip
// can't drift from what the bar actually shows.
function installSuccessMessage(): string {
  return (
    `✓ install complete.\n` +
    `  Restart Claude Code to pick up the new statusline.\n` +
    `  Tip: every bar carries a settings menu — click it (${DOOR_GLYPH} by\n` +
    `  default) for quick actions, preset switching, edit mode, and clickable\n` +
    `  theme/style/variation/shade/endcaps/wrap/padding controls.\n`
  );
}

export async function runInstall(
  rendererArgs: readonly string[],
  bundle: string,
  world: World,
): Promise<void> {
  const force = rendererArgs.includes("--force");
  const filteredArgs = rendererArgs.filter((a) => a !== "--force");

  const argsToInstall =
    filteredArgs.length > 0 ? filteredArgs : [...DEFAULT_INSTALL_ARGS];

  // Preconditions before any side effect: the forwarder must exist before
  // the runtime is staged, so a failed install leaves nothing half done.
  const forwarder =
    process.platform === "darwin" ? resolveForwarder(bundle) : null;
  const staged = runStageRuntime(bundle, supportDir(world.host));

  if (forwarder !== null) {
    installUrlHandler(forwarder, world);
  } else {
    process.stdout.write(
      "Skipping URL handler (cmd-click verbs are macOS-only).\n",
    );
  }

  updateClaudeSettings(staged.binPath, argsToInstall, force, world.host);

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
      await fetchLatestVersion(PACKAGE_NAME, fetch, REGISTRY_URL, world.clock),
    ),
  );
  process[report.stream].write(report.text);
}

// One value spliced at one key path of settings.json.
type SettingsEdit = readonly [keyPath: readonly string[], value: unknown];

function updateClaudeSettings(
  binPath: string,
  rendererArgs: readonly string[],
  force: boolean,
  host: Host,
  overridePath?: string,
): void {
  // The CLI runs in the user's own shell, so its CLAUDE_CONFIG_DIR is the one
  // the Claude Code they launch from it reads.
  const target =
    overridePath ??
    claudeSettingsPath(
      claudeConfigDir(
        detectClaudeConfigDir(host.env, process.cwd()),
        host.home,
      ),
    );
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const statusLine = readClaudeSettings(target).statusLine;
  const existing = isJsonObject(statusLine) ? statusLine.command : undefined;
  // [LAW:one-source-of-truth] Detection: a command we (or a prior version of
  // us) wrote either starts with the legacy `pnpm dlx` form (an open prefix —
  // a version suffix follows) or has the staged bin path — quoted or bare —
  // as its entire first token. Any other value is a user customization we
  // must not silently destroy.
  // [LAW:types-are-the-program] Token, not prefix: a bare startsWith(binPath)
  // would also claim `<binPath>-backup …` as ours and overwrite it.
  // Any single-quoting of the path is ours too: a version whose quoter left
  // fewer characters bare wrote the path quoted where shellWord leaves it bare.
  const managedTokens = [binPath, shellWord(binPath), singleQuoted(binPath)];
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

  // [LAW:one-source-of-truth] Splices through the editor the doctor's fixes
  // use, not a rewrite, so every byte install does not own survives.
  // [LAW:types-are-the-program] What it owns depends on the shape it finds: a
  // statusLine object is amended — its other keys, the `refreshInterval` the
  // doctor sets among them, survive an upgrade — and anything else (none, or a
  // value Claude Code runs nothing from) is replaced whole.
  const command = buildStatusLineCommand(binPath, rendererArgs);
  const edits: readonly SettingsEdit[] = isJsonObject(statusLine)
    ? [
        [["statusLine", "type"], "command"],
        [["statusLine", "command"], command],
      ]
    : [[["statusLine"], { type: "command", command }]];
  writeAtomic(
    target,
    edits.reduce(
      (text, [keyPath, value]) =>
        setValue(text, keyPath, JSON.stringify(value, null, 2), JSON_DIALECT),
      readClaudeSettingsText(target),
    ),
  );
  process.stdout.write(`Updated ${target}\n`);
}

// Exports for testing
export const __test__ = {
  buildStatusLineCommand,
  infoPlist,
  installUrlHandlerFrom,
  DEFAULT_INSTALL_ARGS,
  updateClaudeSettings,
  resolveRenderEntry,
  stageFile,
  stagedEntryKind,
  installSuccessMessage,
};
