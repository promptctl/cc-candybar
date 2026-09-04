// [LAW:behavior-not-structure] The contract of the build-currency verdict,
// pinned by constructing the mtimes directly in a scratch checkout — both
// orderings, the published-install shape, and the ways the check declines —
// independent of how any machine's statusline is wired
// (candybar-build-2s5).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assessBuild,
  buildCurrencyWarning,
  makeBuildWatch,
  REBUILD_HINT,
} from "../src/daemon/build-currency";
import type { LogLevel } from "../src/daemon/log";

const HOUR_MS = 60 * 60 * 1000;
const T0 = new Date("2026-08-15T09:00:31").getTime();

function touch(file: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

// A checkout root with `dist/index.mjs` and two source files, one nested.
// Returns the bundle path plus the source paths so tests can move their
// clocks around.
function scratchCheckout(): {
  root: string;
  bundle: string;
  entryUrl: string;
  shallow: string;
  deep: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-build-"));
  const bundle = path.join(root, "dist", "index.mjs");
  const shallow = path.join(root, "src", "index.ts");
  const deep = path.join(root, "src", "daemon", "cache", "render.ts");
  touch(bundle, T0);
  touch(shallow, T0 - HOUR_MS);
  touch(deep, T0 - 2 * HOUR_MS);
  return { root, bundle, entryUrl: pathToFileURL(bundle).href, shallow, deep };
}

describe("assessBuild", () => {
  let c: ReturnType<typeof scratchCheckout>;
  beforeEach(() => {
    c = scratchCheckout();
  });
  afterEach(() => {
    fs.rmSync(c.root, { recursive: true, force: true });
  });

  test("bundle newer than every source file is current, naming the newest source", () => {
    const v = assessBuild(c.entryUrl);
    expect(v).toEqual({
      kind: "current",
      bundle: { path: c.bundle, mtimeMs: T0 },
      newestSource: { path: c.shallow, mtimeMs: T0 - HOUR_MS },
    });
  });

  test("a nested source file newer than the bundle makes it stale", () => {
    touch(c.deep, T0 + HOUR_MS);
    const v = assessBuild(c.entryUrl);
    expect(v).toEqual({
      kind: "stale",
      bundle: { path: c.bundle, mtimeMs: T0 },
      newestSource: { path: c.deep, mtimeMs: T0 + HOUR_MS },
    });
  });

  test("dotfiles and ~ backups newer than the bundle are not source and do not make it stale", () => {
    touch(path.join(c.root, "src", ".DS_Store"), T0 + HOUR_MS);
    touch(path.join(c.root, "src", "daemon", ".render.ts.swp"), T0 + HOUR_MS);
    touch(path.join(c.root, "src", "index.ts~"), T0 + HOUR_MS);
    touch(path.join(c.root, "src", ".hidden", "x.ts"), T0 + HOUR_MS);
    expect(assessBuild(c.entryUrl).kind).toBe("current");
  });

  test("a symlink is an entry stamped by its own mtime, never followed into its target", () => {
    const external = path.join(c.root, "elsewhere");
    touch(path.join(external, "lib.ts"), T0 + HOUR_MS);
    const link = path.join(c.root, "src", "vendored");
    fs.symlinkSync(external, link);
    fs.lutimesSync(link, (T0 - HOUR_MS) / 1000, (T0 - HOUR_MS) / 1000);
    expect(assessBuild(c.entryUrl).kind).toBe("current");
    fs.lutimesSync(link, (T0 + HOUR_MS) / 1000, (T0 + HOUR_MS) / 1000);
    const v = assessBuild(c.entryUrl);
    expect(v.kind).toBe("stale");
    if (v.kind === "stale") expect(v.newestSource.path).toBe(link);
  });

  test("a self-link and a dangling link are entries, not paths: the verdict is computed", () => {
    for (const [name, target] of [
      ["loop", "."],
      ["up", ".."],
      ["dangling.ts", path.join(c.root, "gone.ts")],
    ] as const) {
      const link = path.join(c.root, "src", name);
      fs.symlinkSync(target, link);
      fs.lutimesSync(link, (T0 - HOUR_MS) / 1000, (T0 - HOUR_MS) / 1000);
    }
    expect(assessBuild(c.entryUrl).kind).toBe("current");
  });

  // Root ignores directory permissions, so the condition cannot be built.
  (process.getuid?.() === 0 ? test.skip : test)(
    "an unreadable source directory is unchecked naming the reason, never a verdict over partial source",
    () => {
      const dir = path.join(c.root, "src", "daemon");
      fs.chmodSync(dir, 0o000);
      try {
        const v = assessBuild(c.entryUrl);
        expect(v.kind).toBe("unchecked");
        if (v.kind === "unchecked") expect(v.reason).toMatch(/EACCES/);
      } finally {
        fs.chmodSync(dir, 0o755);
      }
    },
  );

  test("equal mtimes are current (a build that finished within the same tick is not stale)", () => {
    touch(c.deep, T0);
    expect(assessBuild(c.entryUrl).kind).toBe("current");
  });

  test("no src/ beside dist/ is the published-install shape, not a verdict", () => {
    fs.rmSync(path.join(c.root, "src"), { recursive: true });
    expect(assessBuild(c.entryUrl)).toEqual({ kind: "not-source-checkout" });
  });

  test("an empty src/ has no source for the bundle to predate", () => {
    fs.rmSync(path.join(c.root, "src"), { recursive: true });
    fs.mkdirSync(path.join(c.root, "src"));
    expect(assessBuild(c.entryUrl)).toEqual({ kind: "not-source-checkout" });
  });

  test("a bundle that cannot be stat'd is unchecked with the reason, never a throw", () => {
    fs.rmSync(c.bundle);
    const v = assessBuild(c.entryUrl);
    expect(v.kind).toBe("unchecked");
    if (v.kind === "unchecked") expect(v.reason).toMatch(/ENOENT/);
  });

  test("a non-file entry URL is unchecked", () => {
    expect(assessBuild("data:text/javascript,").kind).toBe("unchecked");
  });
});

describe("buildCurrencyWarning", () => {
  let c: ReturnType<typeof scratchCheckout>;
  beforeEach(() => {
    c = scratchCheckout();
  });
  afterEach(() => {
    fs.rmSync(c.root, { recursive: true, force: true });
  });

  test("stale names both files relative to the checkout, both timestamps, and the rebuild command", () => {
    touch(c.deep, new Date("2026-09-03T10:12:04").getTime());
    const text = buildCurrencyWarning(assessBuild(c.entryUrl));
    expect(text).toBe(
      [
        "stale build: dist/index.mjs 2026-08-15 09:00:31 < src/daemon/cache/render.ts 2026-09-03 10:12:04",
        REBUILD_HINT,
      ].join("\n"),
    );
    expect(REBUILD_HINT).toContain("just deploy");
    expect(REBUILD_HINT).toContain("pnpm dev");
  });

  test("current, not-source-checkout, and unchecked render nothing", () => {
    expect(buildCurrencyWarning(assessBuild(c.entryUrl))).toBeNull();
    fs.rmSync(path.join(c.root, "src"), { recursive: true });
    expect(buildCurrencyWarning(assessBuild(c.entryUrl))).toBeNull();
    expect(
      buildCurrencyWarning({ kind: "unchecked", reason: "ENOENT" }),
    ).toBeNull();
  });
});

describe("makeBuildWatch", () => {
  let c: ReturnType<typeof scratchCheckout>;
  let log: Array<[LogLevel, string]>;
  beforeEach(() => {
    jest.useFakeTimers();
    c = scratchCheckout();
    log = [];
  });
  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(c.root, { recursive: true, force: true });
  });

  test("samples at arm, resamples on the interval, and logs only transitions", () => {
    touch(c.deep, T0 + HOUR_MS);
    const watch = makeBuildWatch({
      entryUrl: c.entryUrl,
      intervalMs: 1000,
      log: (level, msg) => log.push([level, msg]),
    });
    watch.arm();
    expect(watch.warning()).toContain("stale build:");
    expect(log).toEqual([["info", expect.stringMatching(/^build currency: stale/)]]);

    // Steady state: another tick, same verdict, no new log line.
    jest.advanceTimersByTime(1000);
    expect(log).toHaveLength(1);

    // The rebuild lands: the next sample clears the warning and logs once.
    touch(c.bundle, T0 + 2 * HOUR_MS);
    jest.advanceTimersByTime(1000);
    expect(watch.warning()).toBeNull();
    expect(log).toHaveLength(2);
    expect(log[1]).toEqual(["info", expect.stringMatching(/^build currency: current/)]);
  });

  test("a published-install layout logs the typed absence at info, never warn", () => {
    fs.rmSync(path.join(c.root, "src"), { recursive: true });
    const watch = makeBuildWatch({
      entryUrl: c.entryUrl,
      intervalMs: 1000,
      log: (level, msg) => log.push([level, msg]),
    });
    watch.arm();
    expect(watch.warning()).toBeNull();
    expect(log).toEqual([["info", "build currency: not a source checkout"]]);
  });

  test("an unchecked sample is logged at warn and renders nothing", () => {
    fs.rmSync(c.bundle);
    const watch = makeBuildWatch({
      entryUrl: c.entryUrl,
      intervalMs: 1000,
      log: (level, msg) => log.push([level, msg]),
    });
    watch.arm();
    expect(watch.warning()).toBeNull();
    expect(log).toEqual([["warn", expect.stringMatching(/^build currency: unchecked: /)]]);
  });
});
