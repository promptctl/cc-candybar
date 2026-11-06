// [LAW:verifiable-goals] The Pages site (site/) promises a bar that renders and
// clicks with no server: the built transport.js runs the daemon's own request
// handler over a simulated machine. This test builds the site and runs the
// built bundle in a bare Node process, the bundle alone, nothing from src:
// a render draws the bar of the simulated repository, a click on the door is
// the daemon's click and opens the menu, and the scenario moves the bar without
// taking the session from the visitor (the menu they opened stays open). A
// copy the page cannot make says so, with its text, and the doctor runs in the
// page: the daemon it asks about is the page's own.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf, type Frame } from "../src/render/frame";

jest.setTimeout(60_000);

const ROOT = process.cwd();

// The deploy alone says where the explorer sits; a build without it has no explorer to link to.
function withoutLandscape(): NodeJS.ProcessEnv {
  const { LANDSCAPE_DIR: _, ...env } = process.env;
  return env;
}

// site/build.mjs as a command, with the deploy's environment unless a test names its own.
function buildSite(args: string[], env: NodeJS.ProcessEnv = {}): void {
  execFileSync("node", [path.join(ROOT, "site/build.mjs"), ...args], { stdio: "pipe", env: { ...withoutLandscape(), ...env } });
}

test("the deploy's LANDSCAPE_DIR is the live bar's link to the explorer, and a path outside the page is refused", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-site-"));
  buildSite([out], { LANDSCAPE_DIR: "landscape" });
  const printed = execFileSync("node", ["--input-type=module", "-e", `
    const { transport } = await import(${JSON.stringify(path.join(out, "transport.js"))});
    console.log(JSON.stringify(transport.landscape));
    process.exit(0);
  `], { encoding: "utf8", timeout: 30_000 });
  expect(JSON.parse(printed.trim().split("\n").pop()!)).toBe("landscape/");
  for (const bad of ["/landscape", "./landscape", "../landscape", 'x" onclick="y'])
    expect(() => buildSite([out], { LANDSCAPE_DIR: bad })).toThrow(/LANDSCAPE_DIR must be folders/);
  fs.rmSync(out, { recursive: true, force: true });
});

test("the built site renders, clicks, and plays its scenario with no server", () => {
  // Built into a directory of its own, so a test run never replaces the developer's site/dist.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-site-"));
  buildSite([out]);
  const probe = `
    const { transport } = await import(${JSON.stringify(path.join(out, "transport.js"))});
    if (transport.landscape !== null) throw new Error("a build outside the deploy links to an explorer: " + transport.landscape);
    const size = { width: 120, rows: 40 };
    // The page's first render compiles the config in its arrival turn, which
    // can spend its whole deadline, so what has not answered draws pending;
    // the page's next redraw waits for it, as Claude Code's next tick does.
    const cold = await transport.frame(size);
    const first = await transport.frame(size);
    const door = (await transport.render(size)).links.find((l) => l.text === "🍫");
    const clicked = await transport.click(door.url, size);
    const opened = await transport.frame(size);
    const copy = clicked.links.find((l) => l.does.startsWith("copy-text "));
    const copied = await transport.click(copy.url, size); // bare Node has no clipboard
    transport.scenario.seek(27 / 90);
    const working = await transport.frame(size);
    const painted = await transport.render(size);
    const tools = await transport.click(painted.links.find((l) => l.text.includes("tools")).url, size);
    const doctored = await transport.click(tools.links.find((l) => l.text.includes("🩺")).url, size);
    // The doctor's report lands after its probes, past the click's answer, so
    // it is drawn by a later frame, as the page's next redraw draws it.
    let doctor = await transport.frame(size);
    for (let i = 0; i < 100 && !JSON.stringify(doctor.rows).includes("daemon"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      doctor = await transport.frame(size);
    }
    console.log(JSON.stringify({ frames: { cold, first, opened, working, doctor }, refused: clicked.refused, copied: copied.refused, doctorRefused: doctored.refused }));
    process.exit(0);
  `;
  const printed = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 30_000 });
  fs.rmSync(out, { recursive: true, force: true });
  const { frames, ...said } = JSON.parse(printed.trim().split("\n").pop()!) as {
    frames: Record<"cold" | "first" | "opened" | "working" | "doctor", Pick<Frame, "rows">>;
    refused: string | null;
    copied: string | null;
    doctorRefused: string | null;
  };
  const r = { ...said, cold: textOf(frames.cold), first: textOf(frames.first), opened: textOf(frames.opened), working: textOf(frames.working), doctor: textOf(frames.doctor) };
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

// [LAW:verifiable-goals] `pnpm site:dev` promises the page as it is on disk, served to this machine
// alone, that reloads itself when the build changes; a plain build promises none of that.
describe("the dev server", () => {
  const PAGE = path.join(ROOT, "scripts/bar-web/index.html");
  const RELOADS = 'new EventSource("/esbuild")';

  // What a test makes is removed when it ends, passed or not; the server dies before its directory goes.
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
  });
  const tmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-site-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  test("serves the page from disk on loopback, and only the served bundle reloads the page", async () => {
    const server = spawn("node", [path.join(ROOT, "site/build.mjs"), "--serve", "--port", "0", tmpDir()], { env: withoutLandscape() });
    cleanups.push(() => server.kill());
    const serving = await new Promise<string>((resolve, reject) => {
      let said = "";
      server.stdout.on("data", (chunk) => {
        said += chunk;
        const line = said.split("\n").slice(0, -1).find((l) => l.startsWith("serving "));
        if (line !== undefined) resolve(line);
      });
      server.stderr.on("data", (chunk) => (said += chunk));
      server.on("exit", () => reject(new Error(`the dev server exited before serving: ${said}`)));
    });
    // It prints the addresses esbuild bound: loopback, and nothing else.
    expect(serving).toMatch(/^serving http:\/\/127\.0\.0\.1:\d+\/$/);
    const url = serving.slice("serving ".length);
    expect(await (await fetch(url + "index.html")).text()).toBe(fs.readFileSync(PAGE, "utf8"));
    expect(await (await fetch(url + "transport.js")).text()).toContain(RELOADS);

    const built = tmpDir();
    buildSite([built]);
    expect(fs.readFileSync(path.join(built, "transport.js"), "utf8")).not.toContain(RELOADS);
    expect(fs.readFileSync(path.join(built, "index.html"), "utf8")).toBe(fs.readFileSync(PAGE, "utf8"));
  });

  test("refuses a flag it does not know, a port that is not one, and a port with nothing to serve, and builds nothing", () => {
    const out = path.join(os.tmpdir(), `ccb-site-refused-${process.pid}`);
    const refused: Array<[string[], RegExp]> = [
      [["--serve", "--bogus"], /--bogus/],
      [["--serve", "--port", "http"], /--port must be a port number/],
      [["--serve", "--port", ""], /--port must be a port number/],
      [["--serve", "--port", "65536"], /--port must be a port number/],
      [["--port", "9000"], /use it with --serve/],
      [["extra"], /one output directory at most/],
    ];
    for (const [args, said] of refused) expect(() => buildSite([...args, out])).toThrow(said);
    expect(fs.existsSync(out)).toBe(false);
  });
});
