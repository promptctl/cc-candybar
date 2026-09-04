// [LAW:verifiable-goals] candybar-build-2s5's acceptance criteria against the
// REAL bundle: a daemon spawned from `<checkout>/dist/index.mjs` reads its own
// `import.meta.url`, so only the built artifact in a real checkout layout can
// exercise the positive path — the tsx harness runs `src/index.ts`, whose
// entry resolves to `src/src` and is always `not-source-checkout`. Each case
// copies the bundle into a scratch checkout, sets the mtimes directly, and
// reads the rendered rows over the socket: the build row rides the same
// warning channel as the config-collision detector and leads it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assessBuild, REBUILD_HINT } from "../src/daemon/build-currency";
import { killAndWait, render, stripAnsi } from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { builtBundle } from "./helpers/spawn-test-daemon";

const REPO_BUNDLE = path.join(process.cwd(), "dist", "index.mjs");
const HOUR_MS = 60 * 60 * 1000;
const STALE_ROW =
  /^\s*⚠ stale build: dist\/index\.mjs \d{4}-\d\d-\d\d \d\d:\d\d:\d\d < src\/edited\.ts \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s*$/;
const WARNING_URL_BEFORE_STALE_ROW =
  /\x1b\]8;;(cc-candybar:\/\/[^\x1b]*)\x1b\\[^\n]*⚠ stale build/;

// [LAW:no-silent-failure] The feature checks its own test's precondition: a
// missing or out-of-date `dist/` would run a bundle without the code under
// test and fail on something unrelated. CI builds before `pnpm test`.
beforeAll(() => {
  const v = assessBuild(pathToFileURL(REPO_BUNDLE).href);
  if (v.kind !== "current") {
    throw new Error(
      `dist/index.mjs is ${v.kind === "stale" ? "older than src/" : v.kind}` +
        " — this test spawns the built bundle; run `pnpm build` first",
    );
  }
});

interface Scratch {
  readonly root: string;
  readonly bundle: string;
  readonly projectDir: string;
  remove(): void;
}

// A checkout-shaped directory holding a copy of the built bundle, plus a
// project dir whose `.json5`/`.json` pair trips the collision detector so
// the render carries a per-config warning to order against.
function scratchLayout(withSource: boolean): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-"));
  const bundle = path.join(root, "dist", "index.mjs");
  fs.mkdirSync(path.dirname(bundle));
  fs.copyFileSync(REPO_BUNDLE, bundle);
  if (withSource) {
    const edited = path.join(root, "src", "edited.ts");
    fs.mkdirSync(path.dirname(edited));
    fs.writeFileSync(edited, "");
    const t = (fs.statSync(bundle).mtimeMs + HOUR_MS) / 1000;
    fs.utimesSync(edited, t, t);
  }
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-proj-"));
  fs.writeFileSync(path.join(projectDir, ".cc-candybar.json5"), "{}");
  fs.writeFileSync(path.join(projectDir, ".cc-candybar.json"), "{}");
  return {
    root,
    bundle,
    projectDir,
    remove: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

async function renderFrom(
  scratch: Scratch,
  sessionId: string,
): Promise<string> {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-bc");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(env, builtBundle(scratch.bundle));
    return await render(sockPath, sessionId, scratch.projectDir);
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
  }
}

describe("candybar-build-2s5: the daemon renders a stale build as an advisory warning", () => {
  test("a source file newer than the bundle: build row first, rebuild hint, then the config warning", async () => {
    const scratch = scratchLayout(true);
    try {
      const raw = await renderFrom(scratch, "bc-stale");
      const rows = stripAnsi(raw).split("\n");
      expect(rows[0]).toMatch(STALE_ROW);
      expect(rows[1]).toContain(REBUILD_HINT);
      expect(rows[2]).toContain("config-extension collision");
      expect(rows.length).toBeGreaterThan(3);
      const url = WARNING_URL_BEFORE_STALE_ROW.exec(raw)?.[1];
      expect(url).toContain("show-config-warning");
    } finally {
      scratch.remove();
    }
  });

  test("the same checkout after a rebuild renders no build row; the config warning leads", async () => {
    const scratch = scratchLayout(true);
    try {
      const t = (fs.statSync(scratch.bundle).mtimeMs + 2 * HOUR_MS) / 1000;
      fs.utimesSync(scratch.bundle, t, t);
      const rows = stripAnsi(await renderFrom(scratch, "bc-rebuilt")).split("\n");
      expect(rows[0]).toContain("config-extension collision");
      expect(rows.join("\n")).not.toContain("stale build");
    } finally {
      scratch.remove();
    }
  });

  test("a bundle with no src/ beside it (the published install) renders no build row", async () => {
    const scratch = scratchLayout(false);
    try {
      const rows = stripAnsi(await renderFrom(scratch, "bc-published")).split("\n");
      expect(rows[0]).toContain("config-extension collision");
      expect(rows.join("\n")).not.toContain("stale build");
    } finally {
      scratch.remove();
    }
  });
});
