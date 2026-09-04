// [LAW:verifiable-goals] brandon-build-notice-5d6's done-when against the REAL
// bundle: a daemon spawned from `<checkout>/dist/index.mjs` reads its own
// `import.meta.url` and the digest baked into it, so only the built artifact
// in a checkout-shaped directory can exercise the notice — the tsx harness
// runs `src/index.ts`, whose entry resolves to `src/src` and is always
// `not-source-checkout`. Each case copies the bundle into a scratch checkout
// and reads the rendered rows over the socket; every click is the affordance
// the bar rendered, found by what it does and dispatched through the wire.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { sourceDigest } from "../src/source-digest";
import { PACKAGE_VERSION } from "../src/version";
import { UPDATE_DISMISSED_KEY, UPDATE_NOTICE_FIELD } from "../src/daemon/update-notice";
import {
  click,
  extractUrls,
  findUrl,
  killAndWait,
  render,
  renderUntil,
  stripAnsi,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { builtBundle } from "./helpers/spawn-test-daemon";
import { waitForExit } from "./helpers/daemon-wire";

const REPO_ROOT = process.cwd();
const REPO_BUNDLE = path.join(REPO_ROOT, "dist", "index.mjs");
const REPO_SRC = path.join(REPO_ROOT, "src");
const HOUR_S = 60 * 60;
const V = PACKAGE_VERSION.replace(/\./g, "\\.");
const SOURCE_ROW = new RegExp(
  `⬆ Newer source: 9\\.9\\.9 \\[[0-9a-f]{7}\\]\\. You're on ${V} \\[[0-9a-f]{7}\\]\\. \\[rebuild\\] \\[dismiss\\] \\[disable\\]`,
);
const RELEASE_ROW = new RegExp(
  `⬆ Newer release: 99\\.0\\.0\\. You're on ${V}\\. \\[upgrade\\] \\[dismiss\\] \\[disable\\]`,
);

// The strip wraps at the render width; a notice is one sentence however many
// rows it took, so assertions read the strip as flowed text.
const flowed = (raw: string): string =>
  stripAnsi(raw).split("\n").join(" ").replace(/\s+/g, " ");
const rowsOf = (raw: string): string[] => stripAnsi(raw).split("\n");
const hasNotice = (raw: string): boolean => stripAnsi(raw).includes("⬆");

// [LAW:no-silent-failure] The feature checks its own test's precondition: a
// bundle not built from the current `src/` carries another digest, and every
// verdict below would be about that build. CI builds before `pnpm test`.
beforeAll(() => {
  const digest = sourceDigest(REPO_SRC);
  if (!fs.readFileSync(REPO_BUNDLE, "utf8").includes(digest)) {
    throw new Error(
      "dist/index.mjs was not built from the current src/ — this test spawns the built bundle; run `pnpm build` first",
    );
  }
});

interface Scratch {
  readonly root: string;
  readonly projectDir: string;
  readonly configFile: string;
  remove(): void;
}

type Source = "edited" | "real-with-bumped-mtimes" | "none";

function bumpMtimes(dir: string): void {
  const t = Date.now() / 1000 + HOUR_S;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isDirectory()) bumpMtimes(p);
    fs.lutimesSync(p, t, t);
  }
}

// A checkout-shaped directory holding a copy of the built bundle and a
// package.json naming the source's version, plus a project dir whose
// `.json5`/`.json` pair trips the collision detector so the render carries a
// per-config warning to order against.
function scratchLayout(source: Source): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.copyFileSync(REPO_BUNDLE, path.join(root, "dist", "index.mjs"));
  fs.writeFileSync(path.join(root, "package.json"), '{ "version": "9.9.9" }\n');
  const src = path.join(root, "src");
  if (source === "edited") {
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "edited.ts"), "export const edited = true;\n");
  }
  if (source === "real-with-bumped-mtimes") {
    fs.cpSync(REPO_SRC, src, { recursive: true });
    bumpMtimes(src);
  }
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-proj-"));
  const configFile = path.join(projectDir, ".cc-candybar.json5");
  fs.writeFileSync(configFile, "{}");
  fs.writeFileSync(path.join(projectDir, ".cc-candybar.json"), "{}");
  return {
    root,
    projectDir,
    configFile,
    remove: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

async function withDaemon<T>(
  scratch: Scratch,
  envOverride: NodeJS.ProcessEnv,
  body: (sockPath: string, daemon: RunningDaemon) => Promise<T>,
): Promise<T> {
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-bc");
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await spawnDaemonWithEnv(
      { ...env, ...envOverride },
      builtBundle(path.join(scratch.root, "dist", "index.mjs")),
    );
    return await body(sockPath, daemon);
  } finally {
    if (daemon) await killAndWait(daemon);
    removeTmpDirs();
    scratch.remove();
  }
}

const affordance = (raw: string, verb: string, key?: string): string => {
  const url = findUrl(extractUrls(raw), (effects) =>
    effects.some((e) => e.verb === verb && (key === undefined || e.args[1] === key)),
  );
  if (url === undefined) throw new Error(`no rendered affordance for ${verb} ${key ?? ""}`);
  return url;
};

describe("brandon-build-notice-5d6: the daemon renders what is newer than it, with its clicks", () => {
  test("edited source: the notice leads, then the config warning, and no trailer — the strip shows everything", async () => {
    const s = scratchLayout("edited");
    await withDaemon(s, {}, async (sock) => {
      const raw = await render(sock, "bc-stale", s.projectDir);
      const rows = rowsOf(raw);
      expect(flowed(raw)).toMatch(SOURCE_ROW);
      expect(rows[0]).toMatch(/^⬆ Newer source/);
      const warning = rows.findIndex((r) => r.includes("config-extension collision"));
      expect(warning).toBeGreaterThan(0);
      expect(rows.filter((r) => r.startsWith("↳"))).toEqual([]);
    });
  });

  // The ticket's criterion: mtime churn from a checkout or rebase over
  // identical bytes must not cry wolf.
  test("the real source with every mtime bumped renders no notice; the config warning leads", async () => {
    const s = scratchLayout("real-with-bumped-mtimes");
    await withDaemon(s, {}, async (sock) => {
      const raw = await render(sock, "bc-churn", s.projectDir);
      expect(hasNotice(raw)).toBe(false);
      expect(rowsOf(raw)[0]).toContain("config-extension collision");
    });
  });

  test("[dismiss] hides the notice for this session, from the next render", async () => {
    const s = scratchLayout("edited");
    await withDaemon(s, {}, async (sock) => {
      const before = await render(sock, "bc-dismiss", s.projectDir);
      expect(hasNotice(before)).toBe(true);
      await click(sock, affordance(before, "set-state", UPDATE_DISMISSED_KEY));
      const after = await render(sock, "bc-dismiss", s.projectDir);
      expect(hasNotice(after)).toBe(false);
      expect(rowsOf(after)[0]).toContain("config-extension collision");
    });
  });

  test("[disable] writes updateNotice: false into the session's config file, and the notice is gone once it reloads", async () => {
    const s = scratchLayout("edited");
    await withDaemon(s, {}, async (sock) => {
      const before = await render(sock, "bc-disable", s.projectDir);
      expect(hasNotice(before)).toBe(true);
      await click(sock, affordance(before, "set-config", UPDATE_NOTICE_FIELD));
      expect(fs.readFileSync(s.configFile, "utf8")).toMatch(/updateNotice:\s*false/);
      await renderUntil(
        sock,
        "bc-disable",
        s.projectDir,
        (r) => !hasNotice(r),
        "the bar without the update notice",
      );
    });
  });

  test("[rebuild] runs pnpm build in the checkout; a failure is said on the notice's second line", async () => {
    const s = scratchLayout("edited");
    await withDaemon(s, {}, async (sock) => {
      const before = await render(sock, "bc-rebuild", s.projectDir);
      await click(sock, affordance(before, "apply-update"));
      const failed = await renderUntil(
        sock,
        "bc-rebuild",
        s.projectDir,
        (r) => /rebuild failed:/.test(stripAnsi(r)),
        "the rebuild failure",
        20_000,
      );
      expect(flowed(failed)).toMatch(/rebuild failed: non-zero \(exit \d+\): \S/);
      expect(flowed(failed)).toMatch(SOURCE_ROW);
    });
  });

  test("[rebuild] success: pnpm build ran in the checkout root, and the daemon restarted itself on the rebuilt bundle", async () => {
    const s = scratchLayout("edited");
    // A build tool stand-in, first on the daemon's PATH: records where and how
    // it was run, then does the one thing a build does to a running daemon —
    // replaces the bundle it watches.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-bin-"));
    const record = path.join(binDir, "invocation.json");
    fs.writeFileSync(
      path.join(binDir, "pnpm"),
      `#!/bin/sh\nprintf '{"cwd":"%s","args":"%s"}' "$(pwd -P)" "$*" > ${JSON.stringify(record)}\ntouch dist/index.mjs\n`,
      { mode: 0o755 },
    );
    try {
      await withDaemon(s, { PATH: `${binDir}:${process.env.PATH}` }, async (sock, daemon) => {
        const before = await render(sock, "bc-rebuilt", s.projectDir);
        await click(sock, affordance(before, "apply-update"));
        // The rebuilt bundle is the binary watch's restart signal: `onApplied`
        // samples it at once and the daemon exits 0 for the next client to
        // respawn from the fresh code — no minute-long wait, no failure line.
        const exited = await Promise.race([
          waitForExit(daemon.child),
          new Promise<"timeout">((resolve) => setTimeout(resolve, 20_000, "timeout").unref()),
        ]);
        expect(exited).toEqual({ code: 0, signal: null });
        expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual({
          cwd: fs.realpathSync(s.root),
          args: "build",
        });
      });
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("a published install (no src/) behind the registry renders the release notice", async () => {
    const registry = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ latest: "99.0.0" }));
    });
    await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
    const { port } = registry.address() as { port: number };
    try {
      const s = scratchLayout("none");
      await withDaemon(
        s,
        { CC_CANDYBAR_REGISTRY_URL: `http://127.0.0.1:${port}` },
        async (sock) => {
          const raw = await renderUntil(
            sock,
            "bc-release",
            s.projectDir,
            hasNotice,
            "the release notice",
          );
          expect(flowed(raw)).toMatch(RELEASE_ROW);
          const upgrade = affordance(raw, "apply-update");
          expect(upgrade).toContain("apply-update");
        },
      );
    } finally {
      await new Promise<void>((resolve) => registry.close(() => resolve()));
    }
  });
});
