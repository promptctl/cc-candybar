import { OWNER_CONTEXT } from "../proc/launcher.js";
import fs from "node:fs";
import path from "node:path";
import type { OneShotLauncher } from "../proc/launch.js";
import { readTextIfPresent } from "../utils/regular-text.js";
import type { InstallChanges } from "./changes.js";
import { machinePlatform, platformPackageFile } from "./platforms.js";

const HELPER = "cc-candybar-window";
const REPORTER = "terminal-adapters/kitty_geometry.py";
const ASSETS = [
  "index.html",
  "panel.js",
  "panel.css",
  "rich-powerline.woff2",
  "FONT-LICENSE",
] as const;

// A checkout and the stable install have adjacent binaries. An npm bundle
// finds its native executable through its own platform dependency.
export function windowHelper(bundle: string): string {
  const adjacent = path.resolve(path.dirname(bundle), "../bin", HELPER);
  if (fs.existsSync(adjacent)) return adjacent;
  const shipped = platformPackageFile(
    bundle,
    "bin/" + HELPER,
    machinePlatform("darwin"),
  );
  if (shipped.kind === "found") return shipped.path;
  throw new Error(
    "Missing cc-candybar-window. Run just install-bar-window in a checkout or reinstall the macOS package.",
  );
}

export function stageWindow(
  bundle: string,
  dir: string,
  changes: InstallChanges,
  launcher: Pick<OneShotLauncher, "launchSync">,
): void {
  const source = windowHelper(bundle);
  const target = path.join(dir, "bin", HELPER);
  const digest = fs.readFileSync(source + ".source", "utf8");
  if (!/^[a-f0-9]{64}\n$/.test(digest))
    throw new Error(
      "Invalid native window source digest at " + source + ".source",
    );
  const verifies = (file: string) =>
    launcher.launchSync({
      ...OWNER_CONTEXT,
      bin: "/usr/bin/codesign",
      args: [
        "--verify",
        "--strict",
        '-R=identifier "com.cccandybar.window"',
        file,
      ],
      category: "install.codesign",
    }).ok;
  // [LAW:single-enforcer] Preserve the executable already approved for
  // Accessibility when its source and signed identity still match.
  if (
    !(
      fs.existsSync(target) &&
      readTextIfPresent(target + ".source") === digest &&
      verifies(target)
    )
  ) {
    if (!verifies(source))
      throw new Error(
        "codesign failed verifying the window helper at " + source,
      );
    changes.replaceFile(target, fs.readFileSync(source), 0o755);
    changes.replaceFile(target + ".source", digest);
  }
  const reporter = path.join(dir, "bin", REPORTER);
  changes.mkdir(path.dirname(reporter));
  changes.replaceFile(
    reporter,
    fs.readFileSync(path.join(path.dirname(source), REPORTER)),
    0o644,
  );
  const assets = path.join(path.dirname(bundle), "bar-window");
  changes.replaceDir(path.join(dir, "dist", "bar-window"), (stage) => {
    fs.mkdirSync(stage);
    for (const asset of ASSETS)
      fs.copyFileSync(path.join(assets, asset), path.join(stage, asset));
  });
}
