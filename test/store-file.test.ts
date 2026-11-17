// The file one of a profile's stores lives in: read once, written behind a
// debounce off the daemon's thread, and flushed synchronously at the close.
// What a write races, and what a refused write leaves owed.

import fs, {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DebouncedStoreFile } from "../src/daemon/store-file";
import { systemTimekeeper } from "../src/time";
import { heldClock } from "./helpers/held-clock";
import { jestTmpDir } from "./helpers/jest-tmp";
import { throughout, until } from "./helpers/until";

let dir: string;
let file: string;

beforeEach(() => {
  dir = jestTmpDir("state");
  mkdirSync(dir, { recursive: true });
  file = join(dir, "store.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A store over one value the case moves, with every line it logs and every
// failure it says beyond the log.
function store(at = file, debounceMs = 0, clock = systemTimekeeper) {
  let body = "";
  const logged: string[] = [];
  const failed: string[] = [];
  const f = new DebouncedStoreFile(
    at,
    () => body,
    clock,
    (reason) => failed.push(reason),
    (_level, line) => logged.push(line),
    debounceMs,
  );
  const set = (text: string): void => {
    body = text;
    f.save();
  };
  return { f, set, logged, failed };
}

// The write syncs to the real disk, and a datasync on a busy CI runner has
// outlasted until's default 5 s: the budget is when a write that never lands
// fails, not how long one that does is waited on.
const settled = (done: () => boolean): Promise<void> =>
  until(done, "the write's landing", 20_000);

describe("reading the file", () => {
  test("a missing file is a store with nothing in it", () => {
    expect(store().f.read()).toEqual({ kind: "ok", value: null });
  });

  test("a file there is read as it stands", () => {
    writeFileSync(file, "held");
    expect(store().f.read()).toEqual({ kind: "ok", value: "held" });
  });

  test("a path that cannot be read says why, naming it", () => {
    mkdirSync(file);
    const read = store().f.read();
    expect(read).toEqual({
      kind: "failed",
      reason: expect.stringContaining(file),
    });
  });
});

describe("the synchronous flush", () => {
  // [LAW:nothing-unseen] A flush blocks the daemon's one thread, so each one
  // says what it wrote and how long it held the thread.
  test("each flush logs the bytes it wrote and how long it took", () => {
    const { f, set, logged } = store();
    set("dracula");
    f.flush();
    expect(logged.at(-1)).toMatch(
      /^store\.json saved bytes=7 took=\d+ms held=\d+ms$/,
    );
  });

  test("writes the file owner-only", () => {
    const { f, set } = store();
    set("nord");
    f.flush();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a flush with nothing owed writes nothing", () => {
    const { f, logged } = store();
    f.flush();
    expect(existsSync(file)).toBe(false);
    expect(logged).toEqual([]);
  });

  test("a failed write stays owed, is said beyond the log, and lands on the next flush", () => {
    // Parent of the target is a regular file, so mkdir/write/rename fails.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const at = join(blocker, "store.json");
    const { f, set, failed } = store(at);
    set("nord");
    f.flush();
    expect(existsSync(at)).toBe(false);
    expect(failed).toEqual([
      expect.stringMatching(/^store\.json save failed: /),
    ]);
    rmSync(blocker);
    f.flush();
    expect(readFileSync(at, "utf8")).toBe("nord");
  });
});

describe("the debounced write", () => {
  // The debounced write reaches the disk off the daemon's thread: no flush is
  // called, and the file still lands whole, owner-only.
  test("lands on disk by itself and says so", async () => {
    const { set, logged } = store();
    set("nord");
    await settled(() => logged.some((l) => l.startsWith("store.json saved")));
    expect(readFileSync(file, "utf8")).toBe("nord");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.writing`)).toBe(false);
  });

  test("waits out its window, then writes what the store holds then, once", async () => {
    const clock = heldClock(new Date());
    const { set, logged } = store(file, 500, clock);
    set("one");
    set("two");
    clock.advance(499);
    expect(existsSync(file)).toBe(false);
    clock.advance(1);
    await settled(() => existsSync(file));
    expect(readFileSync(file, "utf8")).toBe("two");
    expect(logged.filter((l) => l.includes("saved"))).toHaveLength(1);
  });

  // A disk that refuses a write is retried by the next save or the close's
  // flush, not on a timer: an idle daemon does not spin on it.
  test("a write the disk refuses is tried once, not on a timer", async () => {
    const blocked = join(dir, "not-a-folder");
    writeFileSync(blocked, "");
    const { set, logged, failed } = store(join(blocked, "store.json"));
    set("nord");
    await settled(() => logged.some((l) => l.includes("save failed")));
    await throughout(
      () => logged.filter((l) => l.includes("save failed")).length === 1,
      "one failed write, not retried",
      100,
    );
    expect(failed).toHaveLength(1);
  });

  // The rename that publishes a debounced write runs on the thread pool, so a
  // flush can land while it is on its way. The newer state still wins, the
  // older write's temp file is gone, and nothing calls the superseded rename a
  // failure.
  test("a flush while its rename is in flight keeps the newer state", async () => {
    const { f, set, logged } = store();
    const rename = fs.promises.rename;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        await held;
        return rename(from, to);
      });
    try {
      set("old");
      await settled(() => spy.mock.calls.length === 1);
      set("new");
      f.flush();
      release();
      // The held rename runs out: it finds no temp file, and the write ends.
      await settled(() => logged.some((l) => l.includes("superseded")));
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(existsSync(`${file}.writing`)).toBe(false);
    expect(logged.filter((l) => l.includes("save failed"))).toEqual([]);
    expect(logged.filter((l) => l.includes("superseded"))).toEqual([
      expect.stringContaining("superseded by a flush landed=false"),
    ]);
  });

  // A flush the disk refuses supersedes nothing: the debounced write it raced
  // still publishes, and the flush's newer state waits for the next save.
  test("a flush the disk refuses leaves the in-flight write to land", async () => {
    // A real debounce: the newer state the failed flush leaves owed is
    // rescheduled once the raced write lands, and must not land before the
    // file is read back.
    const { f, set, logged } = store(file, 500);
    const rename = fs.promises.rename;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renameSpy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        await held;
        return rename(from, to);
      });
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" });
    });
    try {
      set("old");
      await settled(() => renameSpy.mock.calls.length === 1);
      set("new");
      f.flush();
      release();
      await settled(() => logged.some((l) => l.includes("saved")));
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(logged.filter((l) => l.includes("save failed"))).toHaveLength(1);
    expect(logged.filter((l) => l.includes("superseded"))).toEqual([]);
    expect(logged.filter((l) => l.includes("saved"))).toHaveLength(1);
    // The newer state is still owed: the next flush lands it.
    f.flush();
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(logged.filter((l) => l.includes("saved"))).toHaveLength(2);
  });

  // [LAW:no-ambient-temporal-coupling] The close's synchronous flush writes the
  // newest state; a debounced write already on its way is older, and must not
  // land over it. Here the flush lands before that write reaches its rename:
  // the write removes its own temp file and says it was superseded.
  test("a flush before its rename supersedes it", async () => {
    const { f, set, logged } = store();
    const mkdir = fs.promises.mkdir;
    const spy = jest
      .spyOn(fs.promises, "mkdir")
      .mockImplementation(async (at, opts) => {
        // The write's first await: the flush lands before it resumes.
        set("new");
        f.flush();
        return mkdir(at, opts);
      });
    try {
      set("old");
      await settled(() => logged.some((l) => l.includes("superseded")));
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(existsSync(`${file}.writing`)).toBe(false);
    expect(logged.filter((l) => l.includes("save failed"))).toEqual([]);
    expect(logged.filter((l) => l.includes("superseded"))).toEqual([
      expect.stringContaining("superseded by a flush landed=false"),
    ]);
  });

  // The other ordering: the debounced rename lands, and the flush writes over
  // it before the write resumes. The write says it was superseded rather than
  // `saved` after the flush's own line, and the flush's state stands.
  test("a flush right after its rename lands supersedes it", async () => {
    const { f, set, logged } = store();
    const rename = fs.promises.rename;
    const spy = jest
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (from, to) => {
        await rename(from, to);
        // On disk, but the write has not resumed: the flush lands in between.
        set("new");
        f.flush();
      });
    try {
      set("old");
      await settled(() => logged.some((l) => l.includes("superseded")));
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(logged.filter((l) => l.includes("save failed"))).toEqual([]);
    expect(logged.filter((l) => l.includes("superseded"))).toEqual([
      expect.stringContaining("superseded by a flush landed=true"),
    ]);
    // The flush's `saved` is the last one.
    expect(logged.filter((l) => l.includes("saved")).length).toBe(1);
  });
});
