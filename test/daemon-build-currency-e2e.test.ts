// [LAW:verifiable-goals] brandon-build-notice-5d6's done-when: a daemon assesses
// the checkout its bundle sits in against the digest its bundle carries. A case
// about the notice hands those two in, on a daemon in this worker, over a
// scratch checkout; the built bundle itself is in
// test/daemon-build-currency-e2e.process.test.ts. Each reads the bar's messages,
// each in the viewer its indicator opens; every click is the affordance the
// viewer rendered, found by what it does and dispatched through the wire.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { sourceDigest } from "../src/source-digest";
import { PACKAGE_VERSION } from "../src/version";
import {
  UPDATE_DISMISSED_KEY,
  UPDATE_NOTICE_FIELD,
  UPDATE_NOTICE_SESSION_KEY,
} from "../src/daemon/update-notice";
import {
  effectsUrl,
  VERB_SET_STATE,
} from "../src/click/wire";
import {
  click,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";
import {
  bundleAt,
  startArmedDaemon,
  type InWorkerDaemon,
} from "./helpers/in-worker-daemon";
import { answerRepo } from "./helpers/repo-approval";
import {
  affordance,
  hasNotice,
  noticeOf,
  pagesOf,
  pagesUntil,
  scratchLayout,
  type Scratch,
} from "./helpers/update-notice-case";

const REPO_ROOT = process.cwd();
const REPO_SRC = path.join(REPO_ROOT, "src");
const REPO_DIGEST = sourceDigest(REPO_SRC);
const V = PACKAGE_VERSION.replace(/\./g, "\\.");
const SOURCE_ROW = new RegExp(
  `⬆ Newer source: 9\\.9\\.9 \\[[0-9a-f]{7}\\]\\. You're on ${V} \\[[0-9a-f]{7}\\]\\. \\[rebuild\\] \\[dismiss\\] \\[disable\\]`,
);
const RELEASE_ROW = new RegExp(
  `⬆ Newer release: 99\\.0\\.0\\. You're on ${V}\\. \\[upgrade\\] \\[dismiss\\] \\[disable\\]`,
);

// A daemon in this worker running from `scratch`'s bundle, built from this
// source: an update notice is read off a checkout and a digest, and both are
// inputs, so it takes no build.
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
});
