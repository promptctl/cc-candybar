import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_BYTES } from "../src/daemon/log";

// The log sink's contract (src/daemon/log.ts): a line is on disk the moment
// dlog returns — no stream, nothing to flush — and the file self-rotates at
// the size boundary, shifting .1→.2→.3 and dropping the oldest.
//
// [LAW:locality-or-seam] logPath() reads $XDG_STATE_HOME at call time and the
// sink's byte counter is module state, so each scenario gets a fresh tmp state
// dir AND a fresh module instance (jest.resetModules + dynamic import). Nothing
// here can reach the user's real daemon.log.

async function withFreshLog<T>(
  seed: (logFile: string) => void,
  fn: (
    dlog: (level: "info" | "warn" | "error", msg: string) => void,
    logFile: string,
  ) => Promise<T> | T,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-log-"));
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    jest.resetModules();
    const { logPath } = await import("../src/daemon/paths");
    const logFile = logPath();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    seed(logFile);
    const { dlog } = await import("../src/daemon/log");
    return await fn(dlog, logFile);
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("dlog", () => {
  test("never throws even when stderr, the last channel, fails too", async () => {
    await withFreshLog(
      (logFile) => {
        fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
        fs.writeFileSync(path.dirname(logFile), "");
      },
      (dlog) => {
        const spy = jest
          .spyOn(process.stderr, "write")
          .mockImplementation(() => {
            throw new Error("EPIPE");
          });
        try {
          expect(() => dlog("error", "uncaughtException: boom")).not.toThrow();
        } finally {
          spy.mockRestore();
        }
      },
    );
  });

  test("never throws when the sink's path cannot even be resolved", async () => {
    await withFreshLog(
      () => {},
      (dlog) => {
        // With no $XDG_STATE_HOME, logPath() falls back to os.homedir(),
        // which throws when the process has no resolvable home.
        const prevXdg = process.env.XDG_STATE_HOME;
        delete process.env.XDG_STATE_HOME;
        const home = jest.spyOn(os, "homedir").mockImplementation(() => {
          throw new Error("ENOENT: no home");
        });
        const written: string[] = [];
        const err = jest
          .spyOn(process.stderr, "write")
          .mockImplementation((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
          });
        try {
          expect(() => dlog("error", "uncaughtException: boom")).not.toThrow();
        } finally {
          err.mockRestore();
          home.mockRestore();
          process.env.XDG_STATE_HOME = prevXdg;
        }
        expect(written.join("")).toMatch(/\[error\] uncaughtException: boom\n.*unwritable: ENOENT/);
      },
    );
  });

  test("self-heals: a state dir removed mid-life is recreated for the next line", async () => {
    await withFreshLog(
      () => {},
      (dlog, logFile) => {
        dlog("info", "one");
        fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
        const spy = jest
          .spyOn(process.stderr, "write")
          .mockImplementation(() => true);
        try {
          dlog("info", "two");
        } finally {
          spy.mockRestore();
        }
        dlog("info", "three");
        expect(fs.readFileSync(logFile, "utf8")).toMatch(/\[info\] three\n$/);
      },
    );
  });

  test("never throws: an unwritable sink degrades to stderr, line intact", async () => {
    await withFreshLog(
      (logFile) => {
        // Replace the state dir with a FILE so mkdir and append both fail.
        fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
        fs.writeFileSync(path.dirname(logFile), "");
      },
      (dlog) => {
        const written: string[] = [];
        const spy = jest
          .spyOn(process.stderr, "write")
          .mockImplementation((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
          });
        try {
          expect(() => dlog("error", "uncaughtException: boom")).not.toThrow();
        } finally {
          spy.mockRestore();
        }
        expect(written.join("")).toMatch(/\[error\] uncaughtException: boom\n.*unwritable/);
      },
    );
  });

  test("the line is on disk when dlog returns", async () => {
    await withFreshLog(
      () => {},
      (dlog, logFile) => {
        dlog("warn", "death line");
        const text = fs.readFileSync(logFile, "utf8");
        expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[^ ]+ \[warn\] death line\n$/);
      },
    );
  });

  test("rotates at the size boundary: .1→.2→.3, oldest dropped, count reset", async () => {
    await withFreshLog(
      (logFile) => {
        // A pre-existing log one line short of the boundary, plus three
        // generations, so this daemon "restart" inherits the on-disk size.
        fs.writeFileSync(logFile, "x".repeat(MAX_BYTES - 16));
        fs.writeFileSync(`${logFile}.1`, "gen1");
        fs.writeFileSync(`${logFile}.2`, "gen2");
        fs.writeFileSync(`${logFile}.3`, "gen3");
      },
      (dlog, logFile) => {
        dlog("info", "tips over");
        // The tipping line landed in the file that then became .1. Sliced,
        // not regexed: `x+` over 5 MB overflows the regex stack on node 22.
        const seeded = MAX_BYTES - 16;
        const gen1 = fs.readFileSync(`${logFile}.1`, "utf8");
        expect(gen1.slice(0, seeded)).toBe("x".repeat(seeded));
        expect(gen1.slice(seeded)).toMatch(/^\d{4}-.* \[info\] tips over\n$/);
        expect(fs.readFileSync(`${logFile}.2`, "utf8")).toBe("gen1");
        expect(fs.readFileSync(`${logFile}.3`, "utf8")).toBe("gen2");
        expect(fs.existsSync(`${logFile}.4`)).toBe(false);
        expect(fs.existsSync(logFile)).toBe(false);

        // The counter reset: the next line opens a fresh generation alone.
        dlog("info", "fresh");
        const fresh = fs.readFileSync(logFile, "utf8");
        expect(fresh).toMatch(/^\d{4}-.* \[info\] fresh\n$/);
        expect(fs.existsSync(`${logFile}.1`)).toBe(true);
      },
    );
  });
});
