// [LAW:verifiable-goals] The Pages site (site/) promises a bar that renders and
// clicks with no server: the built transport.js runs the daemon's own request
// handler over a simulated machine. This test builds the site and runs the
// built bundle in a bare Node process, the bundle alone, nothing from src:
// a render draws the bar of the simulated repository, a click on the door is
// the daemon's click and opens the menu, and the scenario moves the bar.

import { execFileSync } from "node:child_process";
import path from "node:path";

jest.setTimeout(60_000);

const ROOT = process.cwd();

test("the built site renders, clicks, and plays its scenario with no server", () => {
  execFileSync("node", [path.join(ROOT, "site/build.mjs")], { stdio: "pipe" });
  const probe = `
    const { transport } = await import(${JSON.stringify(path.join(ROOT, "site/dist/transport.js"))});
    const size = { width: 120, rows: 40 };
    const plain = (s) => s.replace(/\\u001b\\[[0-9;]*m|\\u001b\\]8;[^\\u001b]*\\u001b\\\\/g, "");
    const first = await transport.render(size);
    const door = first.links.find((l) => l.text === "🍫");
    const opened = await transport.click(door.url, size);
    transport.scenario.seek(27 / 90);
    const working = await transport.render(size);
    console.log(JSON.stringify({ first: plain(first.ansi), refused: opened.refused, opened: plain(opened.ansi), working: plain(working.ansi) }));
    process.exit(0);
  `;
  const out = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 30_000 });
  const r = JSON.parse(out.trim().split("\n").pop()!) as Record<string, string | null>;
  expect(r.first).toContain("~/c/tidepool");
  expect(r.first).toContain("fix-cache-timer");
  expect(r.refused).toBeNull();
  expect(r.opened).toContain("🎨 look");
  // Turn 1, mid-work: the todo list and the tools the transcript says are running.
  expect(r.working).toMatch(/2\/3 Finding the race/);
  expect(r.working).toContain("Bash");
});
