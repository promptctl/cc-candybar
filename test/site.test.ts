// [LAW:verifiable-goals] The Pages site (site/) promises a bar that renders and
// clicks with no server: the built transport.js runs the daemon's own request
// handler over a simulated machine. This test builds the site and runs the
// built bundle in a bare Node process, the bundle alone, nothing from src:
// a render draws the bar of the simulated repository, a click on the door is
// the daemon's click and opens the menu, and the scenario moves the bar without
// taking the session from the visitor (the menu they opened stays open). A
// copy the page cannot make says so, with its text, and the doctor runs in the
// page: the daemon it asks about is the page's own.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stripAnsi } from "./helpers/ansi";

jest.setTimeout(60_000);

const ROOT = process.cwd();

// The deploy alone says where the explorer sits; a build without it has no explorer to link to.
function withoutLandscape(): NodeJS.ProcessEnv {
  const { LANDSCAPE_DIR: _, ...env } = process.env;
  return env;
}

test("the deploy's LANDSCAPE_DIR is the live bar's link to the explorer, and a path outside the page is refused", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-site-"));
  execFileSync("node", [path.join(ROOT, "site/build.mjs"), out], { stdio: "pipe", env: { ...withoutLandscape(), LANDSCAPE_DIR: "landscape" } });
  const printed = execFileSync("node", ["--input-type=module", "-e", `
    const { transport } = await import(${JSON.stringify(path.join(out, "transport.js"))});
    console.log(JSON.stringify(transport.landscape));
    process.exit(0);
  `], { encoding: "utf8", timeout: 30_000 });
  expect(JSON.parse(printed.trim().split("\n").pop()!)).toBe("landscape/");
  for (const bad of ["/landscape", "./landscape", "../landscape", 'x" onclick="y'])
    expect(() => execFileSync("node", [path.join(ROOT, "site/build.mjs"), out], { stdio: "pipe", env: { ...withoutLandscape(), LANDSCAPE_DIR: bad } })).toThrow(/LANDSCAPE_DIR must be folders/);
  fs.rmSync(out, { recursive: true, force: true });
});

test("the built site renders, clicks, and plays its scenario with no server", () => {
  // Built into a directory of its own, so a test run never replaces the developer's site/dist.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-site-"));
  execFileSync("node", [path.join(ROOT, "site/build.mjs"), out], { stdio: "pipe", env: withoutLandscape() });
  const probe = `
    const { transport } = await import(${JSON.stringify(path.join(out, "transport.js"))});
    if (transport.landscape !== null) throw new Error("a build outside the deploy links to an explorer: " + transport.landscape);
    const size = { width: 120, rows: 40 };
    // The page's first render compiles the config in its arrival turn, which
    // can spend its whole deadline, so what has not answered draws pending;
    // the page's next redraw waits for it, as Claude Code's next tick does.
    const cold = await transport.render(size);
    const first = await transport.render(size);
    const door = first.links.find((l) => l.text === "🍫");
    const opened = await transport.click(door.url, size);
    const copy = opened.links.find((l) => l.does.startsWith("copy "));
    const copied = await transport.click(copy.url, size); // bare Node has no clipboard
    transport.scenario.seek(27 / 90);
    const working = await transport.render(size);
    const tools = await transport.click(working.links.find((l) => l.text.includes("tools")).url, size);
    const doctor = await transport.click(tools.links.find((l) => l.text.includes("🩺")).url, size);
    console.log(JSON.stringify({ renders: { cold: cold.ansi, first: first.ansi, opened: opened.ansi, working: working.ansi, doctor: doctor.ansi }, refused: opened.refused, copied: copied.refused, doctorRefused: doctor.refused }));
    process.exit(0);
  `;
  const printed = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 30_000 });
  fs.rmSync(out, { recursive: true, force: true });
  const { renders, ...said } = JSON.parse(printed.trim().split("\n").pop()!) as {
    renders: Record<"cold" | "first" | "opened" | "working" | "doctor", string>;
    refused: string | null;
    copied: string | null;
    doctorRefused: string | null;
  };
  const r = { ...said, cold: stripAnsi(renders.cold), first: stripAnsi(renders.first), opened: stripAnsi(renders.opened), working: stripAnsi(renders.working), doctor: stripAnsi(renders.doctor) };
  expect(r.cold).toContain("~/c/tidepool");
  expect(r.first).toContain("~/c/tidepool");
  expect(r.first).toContain("fix-cache-timer");
  expect(r.refused).toBeNull();
  expect(r.opened).toContain("🎨 look");
  // Turn 1, mid-work: the todo list and the tools the transcript says are running.
  expect(r.working).toMatch(/2\/3 Finding the race/);
  expect(r.working).toContain("Bash");
  // The seek moved the scenario, not the session: the menu the click opened is still open.
  expect(r.working).toContain("🎨 look");
  expect(r.copied).toMatch(/^the browser did not copy .*; the text: \S+$/);
  expect(r.doctorRefused).toBeNull();
  expect(r.doctor).toContain("✓ daemon");
});
