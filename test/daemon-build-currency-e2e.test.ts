// [LAW:verifiable-goals] brandon-build-notice-5d6's done-when: a daemon assesses
// the checkout its bundle sits in against the digest its bundle carries. A case
// about the notice hands those two in, on a daemon in this worker, over a
// scratch checkout; a case about the built bundle itself spawns a copy of it
// there. Each reads the bar's messages, each in the viewer its indicator opens;
// every click is the affordance the viewer rendered, found by what it does and
// dispatched through the wire.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { DIAGNOSTICS_VIEWING } from "../src/config/door";
import { sessionStatePath } from "../src/daemon/paths";
import type { SessionSnapshot } from "../src/daemon/session-state";
import { sourceDigest } from "../src/source-digest";
import { PACKAGE_VERSION } from "../src/version";
import {
  UPDATE_DISMISSED_KEY,
  UPDATE_NOTICE_FIELD,
  UPDATE_NOTICE_SESSION_KEY,
} from "../src/daemon/update-notice";
import {
  effectsUrl,
  VERB_APPLY_UPDATE,
  VERB_SET_STATE,
} from "../src/click/wire";
import {
  click,
  linkUrls,
  findUrl,
  killAndWait,
  render,
} from "./helpers/daemon-e2e";
import { readDiagnostics, type ViewerPage } from "./helpers/diagnostics-viewer";
import { until } from "./helpers/until";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { builtBundle } from "./helpers/spawn-test-daemon";
import { waitForExit, type DaemonTarget } from "./helpers/daemon-wire";
import {
  bundleAt,
  startArmedDaemon,
  type InWorkerDaemon,
} from "./helpers/in-worker-daemon";
import { answerRepo } from "./helpers/repo-approval";

const REPO_ROOT = process.cwd();
const REPO_BUNDLE = path.join(REPO_ROOT, "dist", "index.mjs");
const REPO_SRC = path.join(REPO_ROOT, "src");
const REPO_DIGEST = sourceDigest(REPO_SRC);
const HOUR_S = 60 * 60;
const V = PACKAGE_VERSION.replace(/\./g, "\\.");
const SOURCE_ROW = new RegExp(
  `⬆ Newer source: 9\\.9\\.9 \\[[0-9a-f]{7}\\]\\. You're on ${V} \\[[0-9a-f]{7}\\]\\. \\[rebuild\\] \\[dismiss\\] \\[disable\\]`,
);
const RELEASE_ROW = new RegExp(
  `⬆ Newer release: 99\\.0\\.0\\. You're on ${V}\\. \\[upgrade\\] \\[dismiss\\] \\[disable\\]`,
);

// [LAW:no-ambient-temporal-coupling] Session state is written on a debounce,
// so a SIGKILL right after a click can leave the viewer that read the bar
// saved as open, and the next daemon restores it open. A test that kills
// waits until the viewer's close is on disk, so the successor's bar is the
// one this test means.
async function viewerClosedOnDisk(
  env: NodeJS.ProcessEnv,
  sid: string,
): Promise<void> {
  const file = sessionStatePath(env);
  // Before the first save there is no file; the write is a rename, so a file
  // that is there is whole.
  const closed = (): boolean =>
    fs.existsSync(file) &&
    (JSON.parse(fs.readFileSync(file, "utf8")) as SessionSnapshot)[sid]?.[
      DIAGNOSTICS_VIEWING
    ] === "0";
  await until(closed, () => `the viewer's close saved in ${file}`, 5_000);
}

// Every message a session's bar offers, each read in the viewer: a notice is
// one sentence however many rows it wrapped onto, so a page reads as flowed text.
const pagesOf = async (
  sock: DaemonTarget,
  sessionId: string,
  cwd: string,
): Promise<ViewerPage[]> =>
  readDiagnostics(sock, sessionId, cwd, await render(sock, sessionId, cwd));
const noticeOf = (pages: readonly ViewerPage[]): ViewerPage | undefined =>
  pages.find((p) => p.text.startsWith("⬆"));
const hasNotice = (pages: readonly ViewerPage[]): boolean =>
  noticeOf(pages) !== undefined;
// [LAW:no-ambient-temporal-coupling] Reads the bar's messages until what is
// waited for shows, or fails naming the last messages read.
async function pagesUntil(
  sock: DaemonTarget,
  sessionId: string,
  cwd: string,
  accepts: (pages: readonly ViewerPage[]) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<ViewerPage[]> {
  let last: ViewerPage[] = [];
  await until(
    async () => accepts((last = await pagesOf(sock, sessionId, cwd))),
    () => `${what}; last messages: ${JSON.stringify(last.map((p) => p.text))}`,
    timeoutMs,
  );
  return last;
}

interface Scratch {
  readonly root: string;
  readonly projectDir: string;
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

// A checkout-shaped directory holding a package.json naming the source's
// version, plus a project dir whose
// `.json5`/`.json` pair trips the collision detector so the render carries a
// per-config warning to order against.
function scratchLayout(source: Source): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), '{ "version": "9.9.9" }\n');
  const src = path.join(root, "src");
  if (source === "edited") {
    fs.mkdirSync(src);
    fs.writeFileSync(
      path.join(src, "edited.ts"),
      "export const edited = true;\n",
    );
  }
  if (source === "real-with-bumped-mtimes") {
    fs.cpSync(REPO_SRC, src, { recursive: true });
    bumpMtimes(src);
  }
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-proj-"));
  fs.writeFileSync(path.join(projectDir, ".cc-candybar.json5"), "{}");
  fs.writeFileSync(path.join(projectDir, ".cc-candybar.json"), "{}");
  return {
    root,
    projectDir,
    remove: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

// A daemon in this worker running from `scratch`'s bundle, built from this
// source: an update notice is read off a checkout and a digest, and both are
// inputs, so it takes no build.
const layBundle = (scratch: Scratch): void =>
  fs.copyFileSync(REPO_BUNDLE, path.join(scratch.root, "dist", "index.mjs"));

async function withDaemon<T>(
  scratch: Scratch,
  envOverride: NodeJS.ProcessEnv,
  body: (daemon: InWorkerDaemon) => Promise<T>,
): Promise<T> {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-bc");
  // The project's config (the collision the bar warns of) is approved.
  answerRepo(scratch.projectDir, "approved", env);
  const daemon = startArmedDaemon(
    { ...env, ...envOverride },
    bundleAt(scratch.root, REPO_DIGEST),
  );
  try {
    return await body(daemon);
  } finally {
    await daemon.stop();
    removeTmpDirs();
    scratch.remove();
  }
}

// A real daemon, spawned from a copy of the built bundle in `scratch`.
async function withBuiltDaemon<T>(
  scratch: Scratch,
  envOverride: NodeJS.ProcessEnv,
  body: (sockPath: string, daemon: RunningDaemon) => Promise<T>,
): Promise<T> {
  layBundle(scratch);
  const { env, sockPath, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-bc");
  // The project's config (the collision the bar warns of) is approved.
  answerRepo(scratch.projectDir, "approved", env);
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
  const url = findUrl(linkUrls(raw), (effects) =>
    effects.some(
      (e) => e.verb === verb && (key === undefined || e.args[1] === key),
    ),
  );
  if (url === undefined)
    throw new Error(`no rendered affordance for ${verb} ${key ?? ""}`);
  return url;
};

describe("brandon-build-notice-5d6: the daemon renders what is newer than it, with its clicks", () => {
  test("edited source: the notice leads, then the config warning", async () => {
    const s = scratchLayout("edited");
    await withDaemon(s, {}, async (sock) => {
      const pages = await pagesOf(sock, "bc-stale", s.projectDir);
      expect(pages).toHaveLength(2);
      expect(pages[0]!.text).toMatch(SOURCE_ROW);
      expect(pages[1]!.text).toContain("config-extension collision");
    });
  });

  // The ticket's criterion: mtime churn from a checkout or rebase over
  // identical bytes must not cry wolf.
  test("the real source with every mtime bumped renders no notice; the config warning leads", async () => {
    const s = scratchLayout("real-with-bumped-mtimes");
    await withDaemon(s, {}, async (sock) => {
      const pages = await pagesOf(sock, "bc-churn", s.projectDir);
      expect(hasNotice(pages)).toBe(false);
      expect(pages[0]!.text).toContain("config-extension collision");
    });
  });

  test("[dismiss] hides the notice for this session, from the next render", async () => {
    const s = scratchLayout("edited");
    await withDaemon(s, {}, async (sock) => {
      const before = noticeOf(await pagesOf(sock, "bc-dismiss", s.projectDir));
      expect(before).toBeDefined();
      await click(
        sock,
        affordance(before!.rendered, "set-state", UPDATE_DISMISSED_KEY),
      );
      const after = await pagesOf(sock, "bc-dismiss", s.projectDir);
      expect(hasNotice(after)).toBe(false);
      expect(after[0]!.text).toContain("config-extension collision");
    });
  });

  test("[disable] writes updateNotice: false into the user's config file, and the notice is gone once it reloads", async () => {
    const s = scratchLayout("edited");
    // The user's file — where durable clicks land, under the project's layer.
    const xdg = path.join(s.root, "xdg");
    const userFile = path.join(xdg, "cc-candybar", "config.json5");
    await withDaemon(s, { XDG_CONFIG_HOME: xdg }, async (sock) => {
      const before = noticeOf(await pagesOf(sock, "bc-disable", s.projectDir));
      expect(before).toBeDefined();
      await click(
        sock,
        affordance(before!.rendered, "set-config", UPDATE_NOTICE_FIELD),
      );
      expect(fs.readFileSync(userFile, "utf8")).toMatch(
        /updateNotice:\s*false/,
      );
      await pagesUntil(
        sock,
        "bc-disable",
        s.projectDir,
        (pages) => !hasNotice(pages),
        "the bar without the update notice",
      );
    });
  });

  // The settings menu's ☑ update notice is a session pick, which outranks the
  // file: a disable that wrote only the file would leave the notice up.
  test("[disable] hides the notice over a session that switched it on from the menu", async () => {
    const s = scratchLayout("edited");
    await withDaemon(s, {}, async (sock) => {
      const before = noticeOf(
        await pagesOf(sock, "bc-disable-pick", s.projectDir),
      )!;
      await click(
        sock,
        effectsUrl([
          {
            verb: VERB_SET_STATE,
            args: ["bc-disable-pick", UPDATE_NOTICE_SESSION_KEY, "true"],
          },
        ]),
      );
      await click(
        sock,
        affordance(before.rendered, "set-config", UPDATE_NOTICE_FIELD),
      );
      await pagesUntil(
        sock,
        "bc-disable-pick",
        s.projectDir,
        (pages) => !hasNotice(pages),
        "the bar without the update notice",
      );
    });
  });

  test("[rebuild] runs pnpm build in the checkout; a failure is said on the notice's second line", async () => {
    const s = scratchLayout("edited");
    await withDaemon(s, {}, async (sock) => {
      const before = noticeOf(await pagesOf(sock, "bc-rebuild", s.projectDir))!;
      await click(sock, affordance(before.rendered, "apply-update"));
      const failed = await pagesUntil(
        sock,
        "bc-rebuild",
        s.projectDir,
        (pages) => /rebuild failed:/.test(noticeOf(pages)?.text ?? ""),
        "the rebuild failure",
        20_000,
      );
      expect(noticeOf(failed)!.text).toMatch(
        /rebuild failed: non-zero \(exit \d+\): \S/,
      );
      expect(noticeOf(failed)!.text).toMatch(SOURCE_ROW);
    });
  });

  test("a published install (no src/) behind the registry renders the release notice", async () => {
    const registry = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ latest: "99.0.0" }));
    });
    await new Promise<void>((resolve) =>
      registry.listen(0, "127.0.0.1", resolve),
    );
    const { port } = registry.address() as { port: number };
    try {
      const s = scratchLayout("none");
      await withDaemon(
        s,
        { CC_CANDYBAR_REGISTRY_URL: `http://127.0.0.1:${port}` },
        async (sock) => {
          const pages = await pagesUntil(
            sock,
            "bc-release",
            s.projectDir,
            hasNotice,
            "the release notice",
          );
          expect(noticeOf(pages)!.text).toMatch(RELEASE_ROW);
          const upgrade = affordance(noticeOf(pages)!.rendered, "apply-update");
          expect(upgrade).toContain("apply-update");
        },
      );
    } finally {
      await new Promise<void>((resolve) => registry.close(() => resolve()));
    }
  });

  // The bundle itself: what a build does to a running daemon, and an act that
  // outlives one. Only a process has these.
  describe("a daemon spawned from the built bundle", () => {
    // [LAW:no-silent-failure] The feature checks its own test's precondition: a
    // bundle not built from the current `src/` carries another digest, and every
    // verdict below would be about that build. CI builds before `pnpm test`.
    beforeAll(() => {
      if (!fs.readFileSync(REPO_BUNDLE, "utf8").includes(REPO_DIGEST)) {
        throw new Error(
          "dist/index.mjs was not built from the current src/ — this test spawns the built bundle; run `pnpm build` first",
        );
      }
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
        await withBuiltDaemon(
          s,
          { PATH: `${binDir}:${process.env.PATH}` },
          async (sock, daemon) => {
            const before = noticeOf(
              await pagesOf(sock, "bc-rebuilt", s.projectDir),
            )!;
            await click(sock, affordance(before.rendered, "apply-update"));
            // The rebuilt bundle is the binary watch's restart signal: `onApplied`
            // samples it at once and the daemon exits 0 for the next client to
            // respawn from the fresh code — no minute-long wait, no failure line.
            const exited = await Promise.race([
              waitForExit(daemon.child),
              new Promise<"timeout">((resolve) =>
                setTimeout(resolve, 20_000, "timeout").unref(),
              ),
            ]);
            expect(exited).toEqual({ code: 0, signal: null });
            expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual({
              cwd: fs.realpathSync(s.root),
              args: "build",
            });
          },
        );
      } finally {
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });

    // brandon-unfiled-3248.z676's done-when: the act is a job, not the daemon's
    // child, so a daemon killed mid-act leaves it running; the next daemon reads
    // it as running and refuses a second, and its verdict reaches whichever
    // daemon is up when it lands.
    describe("a daemon SIGKILLed mid-act", () => {
      // A build tool stand-in, first on PATH: it waits for the test's gate and
      // then does what a build does to a running daemon, rewriting the bundle it
      // watches. It ends itself once the scratch checkout is gone or two minutes
      // have passed, so a failed test, or a worker killed before its cleanup,
      // leaves nothing behind: an act outlives every daemon by design.
      function standIn(
        s: Scratch,
        then: string,
      ): { binDir: string; gate: string; ran: string } {
        const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-bin-"));
        const gate = path.join(s.root, "gate");
        const ran = path.join(binDir, "ran");
        fs.writeFileSync(
          path.join(binDir, "pnpm"),
          [
            "#!/bin/sh",
            `n=0; while [ ! -e ${JSON.stringify(gate)} ]; do [ -d ${JSON.stringify(s.root)} ] && [ $n -lt 1200 ] || exit 1; n=$((n+1)); sleep 0.1; done`,
            `echo $$ >> ${JSON.stringify(ran)}`,
            then,
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        return { binDir, gate, ran };
      }

      async function killedMidAct(
        then: string,
        afterGate: (
          successor: RunningDaemon,
          sock: string,
          sid: string,
          s: Scratch,
        ) => Promise<void>,
      ): Promise<{ ran: string }> {
        const s = scratchLayout("edited");
        layBundle(s);
        const stub = standIn(s, then);
        const {
          env: isolated,
          sockPath,
          removeTmpDirs,
        } = prepareIsolatedDaemonEnv("ccb-bc");
        answerRepo(s.projectDir, "approved", isolated);
        const env = { ...isolated, PATH: `${stub.binDir}:${process.env.PATH}` };
        const bundle = builtBundle(path.join(s.root, "dist", "index.mjs"));
        const sid = "bc-killed";
        let successor: RunningDaemon | undefined;
        try {
          const starter = await spawnDaemonWithEnv(env, bundle);
          try {
            const before = noticeOf(await pagesOf(sockPath, sid, s.projectDir))!;
            await click(sockPath, affordance(before.rendered, "apply-update"));
            await viewerClosedOnDisk(env, sid);
          } finally {
            await killAndWait(starter, "SIGKILL");
          }
          successor = await spawnDaemonWithEnv(env, bundle);
          const busy = await pagesUntil(
            sockPath,
            sid,
            s.projectDir,
            (pages) => noticeOf(pages)?.text.includes("[rebuilding…]") ?? false,
            "the successor showing the act as running",
          );
          // The busy label carries no apply click; a click built by hand is refused.
          expect(() =>
            affordance(noticeOf(busy)!.rendered, "apply-update"),
          ).toThrow();
          await expect(
            click(
              sockPath,
              effectsUrl([{ verb: VERB_APPLY_UPDATE, args: [sid] }]),
            ),
          ).rejects.toThrow(/already rebuilding/);
          fs.writeFileSync(stub.gate, "");
          await afterGate(successor, sockPath, sid, s);
          return { ran: fs.readFileSync(stub.ran, "utf8") };
        } finally {
          if (successor) await killAndWait(successor);
          removeTmpDirs();
          s.remove();
          fs.rmSync(stub.binDir, { recursive: true, force: true });
        }
      }

      test("the act completes, the next daemon reports it running and refuses a second, then restarts on the whole bundle", async () => {
        const { ran } = await killedMidAct(
          "touch dist/index.mjs",
          async (successor) => {
            const exited = await Promise.race([
              waitForExit(successor.child),
              new Promise<"timeout">((resolve) =>
                setTimeout(resolve, 20_000, "timeout").unref(),
              ),
            ]);
            expect(exited).toEqual({ code: 0, signal: null });
          },
        );
        // One program ran, once: the refused click started none.
        expect(ran.trim().split("\n")).toEqual([expect.stringMatching(/^\d+$/)]);
      });

      test("a failed act's verdict reaches the daemon that did not start it", async () => {
        await killedMidAct(
          "echo 'tsdown: boom' >&2; exit 1",
          async (_successor, sock, sid, s) => {
            const failed = await pagesUntil(
              sock,
              sid,
              s.projectDir,
              (pages) => /rebuild failed:/.test(noticeOf(pages)?.text ?? ""),
              "the failure the successor did not start",
              10_000,
            );
            expect(noticeOf(failed)!.text).toMatch(
              /rebuild failed: non-zero \(exit 1\): tsdown: boom/,
            );
          },
        );
      });
    });
  });
});
