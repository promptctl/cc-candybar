import {
  rendererAssetOf,
  rendererAssetName,
  RENDERER_DIGEST_FILE,
  type RendererAsset,
} from "./renderer-asset.js";
import { OWNER_CONTEXT, whyFailed } from "../proc/launcher.js";
import {
  ATTACH_DIR,
  ATTACH_PRELOAD,
  attachPreloadOf,
} from "../attach-launcher.js";
import { sourceCheckoutOf } from "../daemon/build-currency.js";
import fs from "node:fs";
import path from "node:path";
import { stageWindow } from "./window-runtime.js";
import {
  checkOwnedPrivateDir,
  hostBundlePath,
  locations,
  remoteSocketDir,
} from "../daemon/paths";
import type { Host, World } from "../host";
import type { OneShotLauncher } from "../proc/launch";
import { tryClickViaDaemon } from "../daemon/client";
import type { BusyPhase, FailureOutcome } from "../daemon/client-transport";
import type { PermanentOutcome } from "../daemon/foundations/protocol";
import { APP_NAME, URL_SCHEME } from "../click/wire";
import { DOOR_GLYPH } from "../config/disclosure";
import { PACKAGE_VERSION } from "../version";
import { shellWord, singleQuoted } from "../shell-word";
import {
  claudeConfigDir,
  claudeSettingsPath,
  detectClaudeConfigDir,
} from "../claude-settings";
import {
  parseClaudeSettings,
  parseStatusLine,
  readClaudeSettings,
  readClaudeSettingsText,
  type StatusLine,
} from "../claude-settings-read";
import {
  JSON_DIALECT,
  Json5EditError,
  parseDocument,
  setValue,
} from "../config/json5-edit";
import {
  assessCurrency,
  currencyReport,
  fetchLatestVersion,
  PACKAGE_NAME,
  REGISTRY_URL,
} from "./currency";
import { platformPackageFile, machinePlatform } from "./platforms";
import { recordIfInstall, statusLineRunsBundle } from "./record";
import { hostBundleRecordText } from "../daemon/host-bundle";
import { readTextIfPresent } from "../utils/regular-text";
import { changeInstallation, type InstallChanges } from "./changes";

const BUNDLE_ID = "com.cccandybar.url-handler";
// The forwarder binary's name in a darwin platform package's `bin/`, as
// .github/workflows/release.yml stages it.
const FORWARDER_BIN = "cc-candybar-url-handler";

// What an install acts on: the machine's facts, and the commands it runs to
// their end (codesign, killall, lsregister).
export interface InstallWorld {
  readonly host: Host;
  readonly launcher: Pick<OneShotLauncher, "launchSync">;
}

function appBundlePath(host: Host): string {
  return path.join(host.home, "Applications", `${APP_NAME}.app`);
}

function ensureMacOS(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new Error(
      `URL handler installation requires macOS (found platform: ${platform}).`,
    );
  }
}

// [LAW:one-source-of-truth] The staged runtime lives at ONE stable path per
// platform, outside any package manager's store — pnpm cache pruning or a
// version bump can never yank the files the statusline and daemon run from.
// The platform is the machine's, handed down by the process main.
function supportDir(host: Host, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
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
export function stableAttachPreload(
  runningBundle: string,
  host: Host,
  platform: NodeJS.Platform,
): string {
  const checkout = sourceCheckoutOf(runningBundle);
  return attachPreloadOf(
    checkout === null
      ? stagedDistPath(supportDir(host, platform))
      : path.join(checkout, "dist", "index.mjs"),
  );
}

// [LAW:one-source-of-truth] Where the forwarder's executable sits inside the
// app bundle install assembles, kept beside the writer.
export function forwarderExecutable(app: string): string {
  return path.join(app, "Contents", "MacOS", APP_NAME);
}

// The forwarder binary: a checkout's own build (`just install-url-handler`),
// or the one the darwin platform package ships, by the running bundle's
// provenance (sourceCheckoutOf). [LAW:no-silent-failure] Neither present is an error
// naming the path and how to make it exist; no applet is built in its place.
function resolveForwarder(
  sourceDist: string,
  platform: NodeJS.Platform,
  host: Host,
): string {
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
  // A re-install from the fixed runtime has no package tree beside it.
  // Its matching forwarder is the binary previously staged in the app.
  const staged = stagedDistPath(supportDir(host, platform));
  if (
    fs.existsSync(staged) &&
    fs.realpathSync(sourceDist) === fs.realpathSync(staged)
  ) {
    const executable = forwarderExecutable(appBundlePath(host));
    if (fs.existsSync(executable)) return executable;
    throw new Error(
      `install: no installed forwarder at ${executable}. Reinstall from the package.`,
    );
  }
  const shipped = platformPackageFile(
    sourceDist,
    `bin/${FORWARDER_BIN}`,
    machinePlatform(platform),
  );
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

// The staged render entry: the prebuilt native binary when this platform has
// one, else the node bin shim. Same contract either way — read hookData on
// stdin, resolve ../dist/index.mjs by adjacency — so downstream code never
// cares which flavor was staged. [LAW:one-type-per-behavior]
type RenderEntry =
  | { kind: "native"; sourcePath: string }
  | { kind: "node-shim"; sourcePath: string };

function resolveRenderEntry(sourceDist: string, platform: string): RenderEntry {
  const shipped = platformPackageFile(sourceDist, "bin/cc-candybar", platform);
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

// A file staged by a copy of its bytes and mode. The bytes are read before
// anything is replaced, so staging from the staged runtime itself copies each
// file onto a fresh one.
function stageFile(
  changes: InstallChanges,
  source: string,
  dest: string,
  mode = fs.statSync(source).mode & 0o777,
): void {
  changes.replaceFile(dest, fs.readFileSync(source), mode);
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
    // is a corrupt artifact (a re-run from the staged runtime copies its own
    // entry as it finds it), not a native binary.
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

// The package's runtime files, found before anything is staged, so a package
// missing one fails with nothing changed.
interface RuntimeSources {
  readonly renderer: RendererAsset;
  readonly dist: string;
  readonly entry: RenderEntry;
  readonly attach: string;
  readonly preload: string;
}

function runtimeSources(
  sourceDist: string,
  platform: NodeJS.Platform,
): RuntimeSources {
  if (!fs.existsSync(sourceDist)) {
    throw new Error(
      `install: bundled dist not found at ${sourceDist}. Reinstall the package.`,
    );
  }

  const entry = resolveRenderEntry(sourceDist, machinePlatform(platform));
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
  return {
    dist: sourceDist,
    renderer: rendererAssetOf(path.dirname(sourceDist)),
    entry,
    attach,
    preload,
  };
}

function stageRenderer(
  changes: InstallChanges,
  dist: string,
  asset: RendererAsset,
): void {
  const name = rendererAssetName(asset.digest);
  const manifest = path.join(dist, RENDERER_DIGEST_FILE);
  const previous = readTextIfPresent(manifest)?.trimEnd();
  changes.replaceFile(path.join(dist, name), asset.bytes, 0o644);
  changes.replaceFile(manifest, asset.digest + "\n", 0o644);
  // [LAW:no-ambient-temporal-coupling] The old and new CLI each name their
  // own immutable module. Retain the previous generation across the switch
  // so an overlapping launch can finish resolving its static imports.
  if (!previous || previous === asset.digest) return;
  const keep = rendererAssetName(previous);
  for (const file of fs.readdirSync(dist))
    if (
      /^renderer-[0-9a-f]{64}\.mjs$/.test(file) &&
      file !== keep &&
      file !== name
    )
      changes.remove(path.join(dist, file));
}

// Stage the full runtime at the stable path: dist/index.mjs (daemon + CLI
// bundle), dist/cc-extra (the attach launcher), dist/attach-preload.cjs (its
// one-variable start) and bin/cc-candybar (render
// entry) as adjacent files. Adjacency IS
// the contract — every entry flavor locates the bundle via ../dist/index.mjs.
// `dir` is where it is staged — the user's stable path (`supportDir`), or a
// test's own.
function stageRuntime(
  sources: RuntimeSources,
  dir: string,
  platform: NodeJS.Platform,
  changes: InstallChanges,
  launcher: InstallWorld["launcher"],
): StagedRuntime {
  const distPath = stagedDistPath(dir);
  const binPath = stagedBinPath(dir);
  changes.mkdir(path.dirname(distPath));
  changes.mkdir(path.dirname(binPath));
  stageRenderer(changes, path.dirname(distPath), sources.renderer);
  stageFile(changes, sources.dist, distPath);
  if (platform === "darwin") stageWindow(sources.dist, dir, changes, launcher);
  // A directory staged whole, so no file of an older launcher outlives it.
  changes.replaceDir(path.join(path.dirname(distPath), ATTACH_DIR), (staging) =>
    fs.cpSync(sources.attach, staging, { recursive: true }),
  );
  stageFile(
    changes,
    sources.preload,
    path.join(path.dirname(distPath), ATTACH_PRELOAD),
  );
  // A fresh inode in one rename, as the deploy script's stageExecutable
  // publishes it too: Darwin can keep the old inode's signature while an
  // earlier exec still has it mapped.
  stageFile(changes, sources.entry.sourcePath, binPath, 0o755);

  // The pre-1.21 layout kept a second copy of the bundle as url-handler.mjs;
  // dist/index.mjs is the one staged bundle now. Remove the stale copy so it
  // can't drift. [LAW:one-source-of-truth]
  changes.remove(path.join(dir, "url-handler.mjs"));

  const stagedKind = stagedEntryKind(sources.entry.sourcePath);
  const machine = machinePlatform(platform);
  changes.report(
    `Staged cc-candybar v${PACKAGE_VERSION} runtime at ${dir}\n` +
      (stagedKind === "native"
        ? `  render entry: native binary (${machine})\n`
        : `  render entry: node shim (no native binary for ${machine}; renders are correct but pay node startup)\n`),
  );
  return {
    binPath,
    distPath,
    entryKind: stagedKind,
  };
}

// The runtime staged on its own, as one change that stands or is put back.
function runStageRuntime(
  sourceDist: string,
  dir: string,
  platform: NodeJS.Platform,
  launcher: InstallWorld["launcher"],
): StagedRuntime {
  const sources = runtimeSources(sourceDist, platform);
  return changeInstallation(
    { host: { home: path.dirname(dir) }, launcher },
    (changes) => stageRuntime(sources, dir, platform, changes, launcher),
  );
}

// The app's Info.plist, whole: a background-only app that claims the scheme.
// Background-only, not an agent (LSUIElement): Launch Services activates an
// agent to deliver a link, and a resident app keeps the focus it was given, so
// every click took keyboard focus from the user's terminal. Nothing ever
// activates a background-only app. [LAW:one-source-of-truth] The scheme and
// the bundle id are spelled here, from the constants the rest of the code
// reads; the Swift source spells neither.
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
    "  <key>LSBackgroundOnly</key>",
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

function prepareForwardDirectory(host: Host, changes: InstallChanges): void {
  // [LAW:single-enforcer] A refused forwarding directory must leave the
  // installed app untouched. The daemon and installer share the trust check.
  const socketDir = remoteSocketDir(host.home);
  changes.mkdir(socketDir, 0o700);
  checkOwnedPrivateDir(socketDir);
}

function buildUrlHandler(
  forwarder: string,
  { host, launcher }: InstallWorld,
  changes: InstallChanges,
): void {
  const bundle = appBundlePath(host);
  process.stdout.write(`Building ${bundle}\n`);
  changes.mkdir(path.dirname(bundle));
  changes.replaceDir(bundle, (staging) => {
    const executable = forwarderExecutable(staging);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(forwarder, executable);
    fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(staging, "Contents", "Info.plist"), infoPlist());

    const signed = launcher.launchSync({
      ...OWNER_CONTEXT,
      bin: "/usr/bin/codesign",
      args: ["--force", "--sign", "-", staging],
      category: "install.codesign",
    });
    if (!signed.ok) {
      process.stderr.write(signed.stderr);
      throw new Error(`codesign failed (${whyFailed(signed)})`);
    }
  });
}

// The app in its place made the one that answers the scheme. These are the
// install's effects outside the user's files, so they run after every file
// is written: a failure here still puts the files back, and no file step
// fails after them.
function registerUrlHandler({ host, launcher }: InstallWorld): void {
  const bundle = appBundlePath(host);
  // [LAW:no-ambient-temporal-coupling] Launch Services reuses a running app,
  // so upgrading must quit the resident forwarder before registering its replacement.
  // killall exits 1 when no process matches, which is the other legal state
  // here: the app is only ever ours, in our own home, so no other exit 1 cause
  // (another user's process) applies.
  const quit = launcher.launchSync({
    ...OWNER_CONTEXT,
    bin: "/usr/bin/killall",
    args: [APP_NAME],
    category: "install.killall",
  });
  if (!quit.ok && quit.exitCode !== 1) {
    process.stderr.write(quit.stderr);
    throw new Error(`killall ${APP_NAME} failed (${whyFailed(quit)})`);
  }
  process.stdout.write(
    quit.ok
      ? `Quit the running ${APP_NAME}; the next click starts the new one\n`
      : `${APP_NAME} was not running\n`,
  );

  process.stdout.write(`Registering ${URL_SCHEME}:// with Launch Services\n`);
  const lsr = launcher.launchSync({
    ...OWNER_CONTEXT,
    bin: "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    args: ["-f", bundle],
    category: "install.lsregister",
  });
  if (!lsr.ok) {
    process.stderr.write(lsr.stderr);
    throw new Error(`lsregister failed (${whyFailed(lsr)})`);
  }

  process.stdout.write(`✓ ${APP_NAME}.app installed and registered.\n`);
  process.stdout.write(
    `  Test: open '${URL_SCHEME}://hello-world' && pbpaste\n`,
  );
}

// Both installer commands prepare the same runtime and platform-owned app.
function prepareInstallation(
  bundle: string,
  world: InstallWorld,
  platform: NodeJS.Platform,
  changes: InstallChanges,
): StagedRuntime {
  const forwarder =
    platform === "darwin"
      ? resolveForwarder(bundle, platform, world.host)
      : null;
  const sources = runtimeSources(bundle, platform);
  if (forwarder !== null) prepareForwardDirectory(world.host, changes);
  const staged = stageRuntime(
    sources,
    supportDir(world.host, platform),
    platform,
    changes,
    world.launcher,
  );
  if (forwarder !== null) {
    buildUrlHandler(forwarder, world, changes);
    changes.afterPublish(() => registerUrlHandler(world));
  } else {
    changes.report("Skipping URL handler (cmd-click verbs are macOS-only).\n");
  }
  return staged;
}

export function runInstallUrlHandler(
  bundle: string,
  world: InstallWorld,
  platform: NodeJS.Platform,
): void {
  // Preconditions before any side effect: on a non-mac this fails with zero
  // files written, not after staging the runtime.
  ensureMacOS(platform);
  changeInstallation(world, (changes) =>
    prepareInstallation(bundle, world, platform, changes),
  );
}

// [LAW:single-enforcer] The URL handler sends the raw link to the host and
// reports its outcome. Automatic startup belongs to the statusline client.
export async function runUrlHandle(
  rawUrl: string | undefined,
  world: World,
): Promise<void> {
  if (!rawUrl) {
    process.stderr.write("url-handle: missing URL argument.\n");
    process.exit(1);
  }

  // [LAW:single-enforcer] Sent as it was clicked: the host reads every link,
  // and refuses one it cannot open with the reason this prints.
  const outcome = await tryClickViaDaemon(world, rawUrl);
  if (outcome.kind === "ok") {
    process.exit(0);
  }

  const plan = urlHandlePlan(outcome);
  process.stderr.write(plan.stderr);
  process.exit(plan.code);
}

// [LAW:effects-at-boundaries] What a failed click does, as data: the stderr
// line and the exit code. runUrlHandle performs it.
export interface UrlHandlePlan {
  readonly stderr: string;
  readonly code: 0 | 1;
}

// [LAW:dataflow-not-control-flow] What a busy daemon's answer tells the reader of
// the click, by whose clock ended the wait (`BusyPhase`). A non-zero exit
// reports a failure, so it follows whether the click can have run. Two phases
// know it did not, so they exit 1 and say to click again. The third cannot say:
// our own clock ends while a click may be queued, running, done or refused, and
// a second click on one that ran can revert it. It exits 0, as the click may
// well have landed, and the text claims neither result.
// `backstop` reads a TIMEOUT as a refusal, which holds only against a daemon
// that answers a click it has read with its own outcome. A new url-handle
// against an older daemon is told wrongly for a window: that daemon's TIMEOUT
// could mean the click ran. The window is short, since the daemon restarts when
// the binary changes, and the cure, a protocol version bump, would push every
// running statusline client through VERSION_MISMATCH.
const BUSY: {
  readonly [P in BusyPhase]: { readonly why: string; readonly code: 0 | 1 };
} = {
  connect: { why: "the click was never sent; click again", code: 1 },
  backstop: {
    why: "the daemon had not read the click in time and refused it; click again",
    code: 1,
  },
  deadline: {
    why: "the click may or may not have run; check the bar before clicking again",
    code: 0,
  },
};

export function urlHandlePlan(outcome: FailureOutcome): UrlHandlePlan {
  switch (outcome.kind) {
    // A daemon holds the socket, so kicking would respawn a live daemon
    // mid-click.
    case "busy":
      return {
        stderr: `url-handle: daemon busy (${outcome.message}): ${BUSY[outcome.phase].why}\n`,
        code: BUSY[outcome.phase].code,
      };
    case "transient":
      return {
        stderr: `url-handle: daemon unavailable (${outcome.cause}: ${outcome.message})\n`,
        code: 1,
      };
    // [LAW:dataflow-not-control-flow] Format each permanent cause from its
    // own typed payload, not by probing for "message" on a generic outcome.
    // The PermanentOutcome union already discriminates by `cause`; the switch
    // mirrors that discriminator one-to-one and pulls the right fields.
    case "permanent":
      return { stderr: formatPermanent(outcome) + "\n", code: 1 };
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

// [LAW:effects-at-boundaries] The install's arguments, read before anything
// changes: `--force` alone. Everything a bar shows is authored in the
// cc-candybar config, so an argument meant for the bar has nowhere to go.
function installOptions(args: readonly string[]): { readonly force: boolean } {
  const unknown = args.filter((a) => a !== "--force");
  if (unknown.length > 0) {
    throw new Error(
      `install: ${unknown.join(" ")}: install takes only --force. The bar is configured in its config file, not by flags on the statusLine command.`,
    );
  }
  return { force: args.includes("--force") };
}

// The install, whole or not at all: every precondition is read before the
// first change, and a step that fails puts back each change before it
// (src/install/changes.ts).
export function install(
  args: readonly string[],
  bundle: string,
  world: InstallWorld,
  platform: NodeJS.Platform,
): void {
  const { force } = installOptions(args);
  changeInstallation(world, (changes) => {
    const dir = supportDir(world.host, platform);
    const settingsPath = userSettingsPath(world.host);
    const settings = planSettings(
      settingsPath,
      readClaudeSettingsText(settingsPath),
      stagedBinPath(dir),
      force,
    );
    const record = hostBundlePath(world.host);
    const recorded = readTextIfPresent(record);

    const staged = prepareInstallation(bundle, world, platform, changes);

    const { change } = settings;
    if (change.kind === "set") {
      changes.writeText(settingsPath, settings.was, change.text);
      changes.report(
        `Set the statusLine command in ${settingsPath}: ${change.command}\n`,
      );
    } else {
      changes.expectText(settingsPath, settings.was);
      process.stderr.write(
        `Skipping settings.json update: existing statusLine.command appears customized.\n` +
          `  Current: ${change.command}\n` +
          `  To overwrite, re-run with --force.\n`,
      );
    }

    // [LAW:one-source-of-truth] The install knows which bundle it staged, and
    // whether it set the statusline command that runs it. A customized command
    // it kept is read for whether it runs the staged entry: that setup is the
    // install too, and `--force` would destroy the command that makes it so.
    if (
      change.kind === "set" ||
      statusLineRunsBundle(settings.statusLine, staged.distPath)
    ) {
      changes.writeText(
        record,
        recorded,
        hostBundleRecordText(staged.distPath),
      );
      changes.report(recordedMessage(staged.distPath));
    } else {
      process.stdout.write(
        `Host bundle not recorded: the statusLine is customized and does not run the staged bundle. Re-run with --force to make the staged bundle the install.\n`,
      );
    }
  });
}

export async function runInstall(
  args: readonly string[],
  bundle: string,
  world: World,
  platform: NodeJS.Platform,
): Promise<void> {
  install(args, bundle, world, platform);
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

// The CLI runs in the user's own shell, so its CLAUDE_CONFIG_DIR is the one
// the Claude Code they launch from it reads.
function userSettingsPath(host: Host): string {
  return claudeSettingsPath(
    claudeConfigDir(detectClaudeConfigDir(host.env, process.cwd()), host.home),
  );
}

function recordedMessage(bundle: string): string {
  return `Recorded ${bundle} as the host's bundle\n`;
}

// The checkout's install step: a build is complete without staging, so this
// is what makes a checkout whose statusline command names it the host's code
// (src/install/record.ts).
export function runRecordHostBundle(bundle: string, world: InstallWorld): void {
  const settingsPath = userSettingsPath(world.host);
  const recording = recordIfInstall(
    bundle,
    parseStatusLine(settingsPath, readClaudeSettings(settingsPath).document),
    world.host,
  );
  process.stdout.write(
    recording.kind === "recorded"
      ? recordedMessage(recording.bundle)
      : `Host bundle not recorded: ${bundle} is not the install. ${
          recording.named === null
            ? "There is no statusLine command, or it names no bundle this can read (an absolute path to a bin/cc-candybar entry, bare or single-quoted)."
            : `The statusLine command runs ${recording.named}.`
        }\n`,
  );
}

// [LAW:types-are-the-program] What the install does to Claude Code's
// settings, decided from the one read of them before anything changes: the
// bytes it read, the statusLine setting they hold, and whether it sets the
// command or keeps the user's.
interface SettingsPlan {
  readonly was: string | null;
  readonly statusLine: StatusLine | null;
  readonly change:
    | { readonly kind: "set"; readonly command: string; readonly text: string }
    | { readonly kind: "kept"; readonly command: string };
}

// One value spliced at one key path of settings.json.
type SettingsEdit = readonly [keyPath: readonly string[], value: unknown];

// [LAW:one-source-of-truth] The command install writes is the staged entry
// alone. The config file holds the renderer settings. Install adopts the staged
// entry in any spelling a version of install used (a version whose quoter
// left fewer characters bare wrote the path quoted where shellWord leaves it
// bare), or the legacy `pnpm dlx` form with a package version and no arguments.
// Any other command is the user's, the entry with words of theirs after it
// included, and is kept unless `--force`.
function planSettings(
  settingsPath: string,
  text: string | null,
  binPath: string,
  force: boolean,
): SettingsPlan {
  const settings = parseClaudeSettings(settingsPath, text);
  try {
    parseDocument(settings.edited);
  } catch (error) {
    if (!(error instanceof Json5EditError)) throw error;
    throw new Error(`cannot edit ${settingsPath}: ${error.reason}`);
  }
  const statusLine = parseStatusLine(settingsPath, settings.document);
  const existing = statusLine?.command ?? null;
  const ours =
    existing === null ||
    existing.trim() === "" ||
    (existing.startsWith(`pnpm dlx ${PACKAGE_NAME}@`) &&
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(
        existing.slice(`pnpm dlx ${PACKAGE_NAME}@`.length),
      )) ||
    [binPath, shellWord(binPath), singleQuoted(binPath)].includes(existing);
  if (!ours && !force)
    return {
      was: text,
      statusLine,
      change: { kind: "kept", command: existing },
    };

  // [LAW:one-source-of-truth] Splices, not a rewrite, so every byte install
  // does not own survives: a statusLine object is amended, so its other keys
  // (a `refreshInterval` the user set) survive an upgrade.
  const command = shellWord(binPath);
  const edits: readonly SettingsEdit[] =
    statusLine === null
      ? [[["statusLine"], { type: "command", command }]]
      : [
          [["statusLine", "type"], "command"],
          [["statusLine", "command"], command],
        ];
  try {
    return {
      was: text,
      statusLine,
      change: {
        kind: "set",
        command,
        text: edits.reduce(
          (edited, [keyPath, value]) =>
            setValue(
              edited,
              keyPath,
              JSON.stringify(value, null, 2),
              JSON_DIALECT,
            ),
          settings.edited,
        ),
      },
    };
  } catch (e) {
    // [LAW:no-silent-failure] JSON reads a duplicate key as its last one; the
    // splicer refuses a document whose meaning is ambiguous.
    if (!(e instanceof Json5EditError)) throw e;
    throw new Error(`cannot edit ${settingsPath}: ${e.reason}`);
  }
}

// Exports for testing
export const __test__ = {
  runStageRuntime,
  infoPlist,
  planSettings,
  resolveRenderEntry,
  stagedEntryKind,
  installSuccessMessage,
};
