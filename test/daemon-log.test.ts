import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_BYTES, MAX_WAITING_BYTES } from "../src/daemon/log";

// The log sink's contract (src/daemon/log.ts): a line is in the file once the
// log drains, every line logged before the process exits is in the file, and
// the file self-rotates at the size boundary, shifting .1→.2→.3 and dropping
// the oldest.
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
    drained: () => Promise<void>,
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
    const { dlog, drained } = await import("../src/daemon/log");
    return await fn(dlog, logFile, drained);
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
      async (dlog, logFile, drained) => {
        dlog("info", "one");
        await drained();
        fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
        const spy = jest
          .spyOn(process.stderr, "write")
          .mockImplementation(() => true);
        try {
          dlog("info", "two");
          await drained();
        } finally {
          spy.mockRestore();
        }
        dlog("info", "three");
        await drained();
        expect(fs.readFileSync(logFile, "utf8")).toMatch(/\[info\] three\n$/);
      },
    );
  });

  test("a log another writer moved aside is not written into: the next line starts the file at the path", async () => {
    await withFreshLog(
      () => {},
      async (dlog, logFile, drained) => {
        dlog("info", "one");
        await drained();
        fs.renameSync(logFile, `${logFile}.1`);
        dlog("info", "two");
        await drained();
        expect(fs.readFileSync(`${logFile}.1`, "utf8")).not.toContain("two");
        expect(fs.readFileSync(logFile, "utf8")).toMatch(/^\S+ \[info\] two\n$/);
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
      async (dlog, _logFile, drained) => {
        const written: string[] = [];
        const spy = jest
          .spyOn(process.stderr, "write")
          .mockImplementation((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
          });
        try {
          expect(() => dlog("error", "uncaughtException: boom")).not.toThrow();
          // The disk is asked off the event loop, so its refusal is reported
          // once the log drains.
          await drained();
        } finally {
          spy.mockRestore();
        }
        expect(written.join("")).toMatch(/\[error\] uncaughtException: boom\n.*unwritable/);
      },
    );
  });

  test("the line is in the file once the log drains", async () => {
    await withFreshLog(
      () => {},
      async (dlog, logFile, drained) => {
        dlog("warn", "a line");
        await drained();
        const text = fs.readFileSync(logFile, "utf8");
        expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[^ ]+ \[warn\] a line\n$/);
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
      async (dlog, logFile, drained) => {
        dlog("info", "tips over");
        await drained();
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
        await drained();
        const fresh = fs.readFileSync(logFile, "utf8");
        expect(fresh).toMatch(/^\d{4}-.* \[info\] fresh\n$/);
        expect(fs.existsSync(`${logFile}.1`)).toBe(true);
      },
    );
  });

  // A disk that takes nothing costs lines the log says it lost, not memory:
  // lines past the bound are counted, and the count is in the file.
  test("lines past what the log holds while the disk takes none are counted, not held", async () => {
    await withFreshLog(
      () => {},
      async (dlog, logFile, drained) => {
        const line = "x".repeat(1000);
        const sent = Math.ceil((MAX_WAITING_BYTES * 1.5) / line.length);
        // In one turn: no write can land between them.
        for (let i = 0; i < sent; i++) dlog("info", line);
        await drained();
        const logged = fs.readFileSync(logFile, "utf8").trimEnd().split("\n");
        const dropped = Number(/ (\d+) line\(s\) dropped /.exec(logged.at(-1)!)?.[1]);
        expect(dropped).toBeGreaterThan(0);
        expect(logged.length - 1 + dropped).toBe(sent);
      },
    );
  });

  // The way out writes what is on its way, and only while something is.
  test("the exit listener is there only while lines are on their way", async () => {
    await withFreshLog(
      () => {},
      async (dlog, _logFile, drained) => {
        const before = process.listenerCount("exit");
        dlog("info", "one");
        expect(process.listenerCount("exit")).toBe(before + 1);
        await drained();
        expect(process.listenerCount("exit")).toBe(before);
      },
    );
  });

  // The death line: whatever a process logs before process.exit is in the
  // file, in order, though the writes are asynchronous.
  test("every line logged before process.exit is in the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-log-exit-"));
    try {
      const lines = 2000;
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `import { dlog } from ${JSON.stringify(path.resolve("src/daemon/log.ts"))};` +
            `for (let i = 0; i < ${lines}; i++) dlog("info", "line " + i + " " + "x".repeat(200));` +
            `dlog("warn", "death line"); process.exit(0);`,
        ],
        { env: { ...process.env, XDG_STATE_HOME: dir } },
      );
      const text = fs.readFileSync(
        path.join(dir, "cc-candybar", "daemon.log"),
        "utf8",
      );
      const logged = text.trimEnd().split("\n");
      expect(logged).toHaveLength(lines + 1);
      expect(logged.slice(0, -1).map((l) => / line (\d+) /.exec(l)?.[1])).toEqual(
        Array.from({ length: lines }, (_, i) => String(i)),
      );
      expect(logged.at(-1)).toMatch(/\[warn\] death line$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
