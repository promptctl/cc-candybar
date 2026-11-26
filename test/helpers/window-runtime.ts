import fs from "node:fs";
import path from "node:path";

// Installer tests substitute codesign at the process edge.
export function windowRuntime(root: string): void {
  const files: Record<string, string> = {
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
