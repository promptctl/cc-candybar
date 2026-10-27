import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autorun } from "mobx";
import { AutoCompactProvider } from "../src/segments/autocompact-provider";
import { ok } from "../src/utils/outcome";

// [LAW:behavior-not-structure] The owner of the auto-compact window
// (brandon-unfiled-3248.8ro6, step 1): every request asks, the file is read
// only when it changed, and each read is logged once — a refusal that stands
// is logged by the read that found it, never again by the requests after.

let dir: string;
let settings: string;
let lines: string[];
let provider: AutoCompactProvider;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-autocompact-"));
  settings = path.join(dir, "settings.json");
  lines = [];
  provider = new AutoCompactProvider((level, msg) =>
    lines.push(`${level} ${msg}`),
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A write that moves the stamp however coarse the filesystem's clock: the
// size differs, and the mtime is set apart.
const write = (text: string, mtimeS: number): void => {
  fs.writeFileSync(settings, text);
  fs.utimesSync(settings, mtimeS, mtimeS);
};

describe("AutoCompactProvider", () => {
  test("no file is Claude Code's own window, read once", () => {
    expect(provider.window(settings)).toEqual(ok("auto"));
    expect(provider.window(settings)).toEqual(ok("auto"));
    expect(provider.getStats().refreshes).toEqual({ request: 1 });
  });

  test("the file is read again only when its stamp moved", () => {
    write(JSON.stringify({ autoCompactWindow: 400_000 }), 1_000);
    expect(provider.window(settings)).toEqual(ok(400_000));
    expect(provider.window(settings)).toEqual(ok(400_000));
    expect(provider.getStats().refreshes).toEqual({ request: 1 });

    write(JSON.stringify({ autoCompactWindow: 1_000_000 }), 2_000);
    expect(provider.window(settings)).toEqual(ok(1_000_000));
    expect(provider.getStats()).toEqual({
      entries: 1,
      refreshes: { request: 2 },
      failures: 0,
      lastMs: expect.any(Number),
    });
  });

  test("a request whose stamp did not move wakes no reader of the window", () => {
    write(JSON.stringify({ autoCompactWindow: 400_000 }), 1_000);
    provider.window(settings);
    let reads = 0;
    const stop = autorun(() => {
      provider.stored(settings);
      reads++;
    });
    try {
      for (let request = 0; request < 3; request++) provider.window(settings);
      expect(reads).toBe(1);
      write(JSON.stringify({ autoCompactWindow: 1_000_000 }), 2_000);
      provider.window(settings);
      expect(reads).toBe(2);
    } finally {
      stop();
    }
  });

  test("a refusal is logged once, by the read that found it", () => {
    write(JSON.stringify({ autoCompactWindow: 5 }), 1_000);
    const first = provider.window(settings);
    expect(first.kind).toBe("failed");
    expect(provider.window(settings)).toBe(first);
    expect(provider.window(settings)).toBe(first);
    expect(lines).toEqual([
      expect.stringMatching(
        /^warn autocompact refresh path=\S*settings\.json stamp=\S+ by=request outcome=failed reason=".*not a window \/autocompact accepts.*" took=\d+ms$/,
      ),
    ]);
    expect(provider.getStats().failures).toBe(1);
  });

  test("two Claude Code directories are two files, each read once", () => {
    const other = path.join(dir, "other.json");
    fs.writeFileSync(other, JSON.stringify({ autoCompactWindow: 300_000 }));
    write(JSON.stringify({ autoCompactWindow: 400_000 }), 1_000);
    expect(provider.window(settings)).toEqual(ok(400_000));
    expect(provider.window(other)).toEqual(ok(300_000));
    expect(provider.window(settings)).toEqual(ok(400_000));
    expect(provider.getStats()).toMatchObject({
      entries: 2,
      refreshes: { request: 2 },
    });
  });
});
