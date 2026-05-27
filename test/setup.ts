import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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
