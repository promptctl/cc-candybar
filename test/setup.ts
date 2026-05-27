import os from "node:os";
import path from "node:path";

// [LAW:single-enforcer] Guard every Jest worker from accidentally touching the
// live daemon's socket at /tmp/cc-candybar-<uid>/socket. Default CC_CANDYBAR_SOCKET
// to a dead, per-worker path so socketPath() never resolves to the live daemon
// in any test that forgets to set its own isolation. Individual tests that need
// a live socket override this explicitly (withTempState, CC_CANDYBAR_SOCKET in
// subprocess env, etc.).
process.env.CC_CANDYBAR_SOCKET = path.join(
  os.tmpdir(),
  `cc-candybar-jest-${process.pid}`,
  "socket",
);
