import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

import { PARENT_PID_ENV } from "../src/daemon/parent-watchdog";

// [LAW:single-enforcer] Arms the parent-death watchdog: every daemon a test spawns inherits this worker's pid via env, so a killed Jest can never orphan one to init.
process.env[PARENT_PID_ENV] = String(process.pid);

// [LAW:single-enforcer] Stamps the package version into this worker and, through NODE_OPTIONS, every daemon it spawns — without it src/version.ts refuses to load.
const stamp = createRequire(__filename)(
  path.join(__dirname, "..", "scripts", "version-stamp.cjs"),
) as { withStamp(nodeOptions: string | undefined): string };
process.env.NODE_OPTIONS = stamp.withStamp(process.env.NODE_OPTIONS);

// [LAW:single-enforcer] setupFiles re-runs in a fresh module context per test FILE, so
// randomUUID() gives a socket path unique per file, never the live daemon's socket.
process.env.CC_CANDYBAR_SOCKET = path.join(
  os.tmpdir(),
  `cc-candybar-jest-${crypto.randomUUID()}`,
  "socket",
);

// [LAW:single-enforcer] A closed port, so no test daemon ever polls npm for a release.
process.env.CC_CANDYBAR_REGISTRY_URL = "http://127.0.0.1:1";
