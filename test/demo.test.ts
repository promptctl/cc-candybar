import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripAnsi } from "./helpers/ansi";

// `pnpm demo` claims to print what production produces. That holds only while
// its payload is the daemon's own (buildRenderPayload over a faked hook event):
// the fields below are ones no hook event carries and the daemon always
// supplies, so a demo that restates its payload by hand renders them empty.
describe("pnpm demo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccb-demo-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runDemo = (config: string, env: Record<string, string> = {}) => {
    const configPath = join(dir, "config.json5");
    writeFileSync(configPath, config);
    return spawnSync(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      [join(process.cwd(), "src", "demo", "dsl.ts"), configPath],
      {
        env: {
          ...process.env,
          HOME: join(dir, "home"),
          XDG_STATE_HOME: join(dir, "state"),
          ...env,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  };

  test("renders the fields only the daemon's payload supplies", () => {
    const r = runDemo(`{
      variables: {
        home: { kind: "input", path: "home", default: "" },
        undo: { kind: "input", path: "history.undo", default: "absent" },
        unsaved: { kind: "input", path: "unsaved", default: "absent" },
        file: { kind: "input", path: "configPath", default: "absent" },
      },
      segments: {
        probe: {
          template: "home={{ .home }} undo={{ .undo }} unsaved={{ .unsaved }} file={{ .file }}",
        },
      },
      root: "probe",
    }`);
    expect(r.status).toBe(0);
    expect(stripAnsi(r.stdout)).toContain(
      `home=${join(dir, "home")} undo=0 unsaved=0 file=${join(dir, "config.json5")}`,
    );
  });

  // The usage store's transcript seed logs when it runs, and a `today` read
  // runs it. Only the daemon writes daemon.log: the demo's providers log
  // through the sink the demo hands them.
  test("does not write the daemon's log", () => {
    const r = runDemo(
      `{
        variables: {
          todayCost: { kind: "input", path: "today.cost", default: "absent" },
        },
        segments: { probe: { template: "today={{ .todayCost }}" } },
        root: "probe",
      }`,
      { CC_CANDYBAR_DEBUG: "1" },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("usageStore seed sessions=");
    expect(existsSync(join(dir, "state", "cc-candybar", "daemon.log"))).toBe(
      false,
    );
  });

  test("a config that does not load fails with the loader's message", () => {
    const r = runDemo(`{ root: "no-such-segment" }`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no-such-segment");
  });
});
