import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clog, closeLog } from "../src/daemon/log";
import { logPath } from "../src/daemon/paths";

// [LAW:behavior-not-structure] These assert the contract `clog` exists to
// provide — a non-daemon process can append to the daemon's log — not how it
// is implemented. A different implementation (a lock file, an O_APPEND fd held
// open) would pass all of them unchanged.
describe("clog — append-only client logging", () => {
  let stateDir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevXdg = process.env.XDG_STATE_HOME;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-log-"));
    process.env.XDG_STATE_HOME = stateDir;
  });

  afterEach(() => {
    closeLog();
    process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("writes a timestamped, levelled line", () => {
    clog("warn", "click-client verb=dispatch ok=N");
    const written = fs.readFileSync(logPath(), "utf8");
    expect(written).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[warn\] click-client verb=dispatch ok=N\n$/,
    );
  });

  test("creates the state directory when it does not exist yet", () => {
    // A click can arrive before this machine's daemon has ever run.
    fs.rmSync(stateDir, { recursive: true, force: true });
    clog("info", "first ever line");
    expect(fs.readFileSync(logPath(), "utf8")).toContain("first ever line");
  });

  test("appends rather than truncating, across separate calls", () => {
    clog("info", "first");
    clog("info", "second");
    const lines = fs.readFileSync(logPath(), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });

  // [LAW:single-enforcer] Rotation belongs to the daemon alone. A client that
  // rotated would rename generations out from under the daemon's open stream,
  // so an oversized log must be left exactly as found — appended to, never
  // shifted. This is the invariant that makes one shared file safe.
  test("never rotates, even past the daemon's rotation threshold", () => {
    const oversized = "x".repeat(6 * 1024 * 1024);
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(logPath(), oversized + "\n");

    clog("info", "appended by a client");

    expect(fs.existsSync(`${logPath()}.1`)).toBe(false);
    const written = fs.readFileSync(logPath(), "utf8");
    expect(written.startsWith(oversized)).toBe(true);
    expect(written).toContain("appended by a client");
  });

  // Deliberately NOT tested: the interleaving of client and daemon lines. The
  // two run in separate processes and order by wall clock, so no code here
  // promises it — asserting it would pin timing the design never guaranteed
  // and buy a flaky test. That both emitters target logPath() is covered
  // above, and is one shared call in log.ts.
});
