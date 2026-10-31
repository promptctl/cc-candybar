// [LAW:verifiable-goals] The bundle itself: what a build does to a running
// daemon, and an act that outlives one. The notice's own cases are in
// test/daemon-build-currency-e2e.test.ts, and take no build.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DIAGNOSTICS_VIEWING } from "../src/config/door";
import { sessionStatePath } from "../src/daemon/paths";
import type { SessionSnapshot } from "../src/daemon/session-state";
import { sourceDigest } from "../src/source-digest";
import { effectsUrl, VERB_APPLY_UPDATE } from "../src/click/wire";
import { click, killAndWait } from "./helpers/daemon-e2e";
import { until } from "./helpers/until";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { builtBundle } from "./helpers/spawn-test-daemon";
import { waitForExit } from "./helpers/daemon-wire";
import { answerRepo } from "./helpers/repo-approval";
import {
  affordance,
  noticeOf,
  pagesOf,
  pagesUntil,
  scratchLayout,
  type Scratch,
} from "./helpers/update-notice-case";

const REPO_BUNDLE = path.join(process.cwd(), "dist", "index.mjs");
const REPO_DIGEST = sourceDigest(path.join(process.cwd(), "src"));

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

const layBundle = (scratch: Scratch): void =>
  fs.copyFileSync(REPO_BUNDLE, path.join(scratch.root, "dist", "index.mjs"));

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
