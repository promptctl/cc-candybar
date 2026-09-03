import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { PARENT_PID_ENV } from "../src/daemon/parent-watchdog";

// [LAW:single-enforcer] The one place that arms the parent-death watchdog for
// every daemon any test spawns. This runs in each Jest worker; the worker
// publishes its own pid, and every daemon spawned by the worker — directly, or
// detached through the production spawn path — inherits it via process.env and
// exits when this worker dies. So a SIGKILLed / crashed / timed-out Jest can
// never orphan a daemon to init (the 113-corpse leak). The real daemon is
// spawned by the client, never under Jest, so it never sees this variable and
// is never touched.
process.env[PARENT_PID_ENV] = String(process.pid);

// [LAW:single-enforcer] The one place source-run processes get their package
// version stamp (see test/helpers/version-stamp.cjs): this worker's own
// sandbox global, and — through NODE_OPTIONS, inherited by every daemon a test
// spawns — each child's too. Without it src/version.ts refuses to load.
const VERSION_STAMP = path.join(__dirname, "helpers", "version-stamp.cjs");
createRequire(__filename)(VERSION_STAMP);
process.env.NODE_OPTIONS = [
  process.env.NODE_OPTIONS ?? "",
  `--import=${pathToFileURL(VERSION_STAMP).href}`,
]
  .filter((s) => s !== "")
  .join(" ");

// [LAW:single-enforcer] Guard every Jest worker from accidentally touching the
// live daemon's socket at /tmp/cc-candybar-<uid>/socket. setupFiles re-runs in
// a fresh module context per test file, so randomUUID() gives a path unique per
// test file — not just per worker process (process.pid would be shared across
// every file that worker runs sequentially). Individual tests that need a live
// socket override this explicitly (withTempState, CC_CANDYBAR_SOCKET in
// subprocess env, etc.).
process.env.CC_CANDYBAR_SOCKET = path.join(
  os.tmpdir(),
  `cc-candybar-jest-${crypto.randomUUID()}`,
  "socket",
);
