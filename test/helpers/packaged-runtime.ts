import { RUNTIME_MANIFEST, rendererAssetName, rendererDigest, rendererAssetOf } from "../../src/install/renderer-asset";
import fs from "node:fs";
import path from "node:path";

// Installer tests substitute codesign at the process edge.
export function packagedRuntime(root: string, version = "fixture"): void {
  const renderer = "export const version = " + JSON.stringify(version);
  const digest = rendererDigest(Buffer.from(renderer));
  const files: Record<string, string> = {
    ["dist/" + RUNTIME_MANIFEST]: JSON.stringify({ cli: rendererDigest(fs.readFileSync(path.join(root,"dist","index.mjs"))), renderer: digest }) + "\n",
    ["dist/" + rendererAssetName(digest)]: renderer,
    "bin/cc-candybar-window": "fixture image",
    "bin/cc-candybar-window.source": "a".repeat(64) + "\n",
    "bin/terminal-adapters/kitty_geometry.py": "# fixture",
  };
  for (const name of [
    "index.html",
    "panel.css",
    "panel.js",
    "rich-powerline.woff2",
    "FONT-LICENSE",
  ])
    files["dist/bar-window/" + name] = name;
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

// A relocated CLI imports its content-addressed sibling just as it does in dist.
export function relocateRenderer(cli: string, relocated: string): void {
  const { bytes, digest } = rendererAssetOf(path.dirname(cli));
  fs.writeFileSync(path.join(path.dirname(relocated), rendererAssetName(digest)), bytes);
}
