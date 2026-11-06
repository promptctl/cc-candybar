import path from "node:path";
import { createRequire } from "node:module";

import { HOME_ENV, NAME_ENV, RUNTIME_DIR_ENV } from "../src/daemon/home";
import { PARENT_PID_ENV } from "../src/daemon/parent-watchdog";
import { jestTmpDir } from "./helpers/jest-tmp";

// [LAW:single-enforcer] The one place that arms the parent-death watchdog for
// every daemon any test spawns. This runs in each Jest worker; the worker
// publishes its own pid, and every daemon spawned by the worker — directly, or
// detached through the production spawn path — inherits it via process.env and
// exits when this worker dies. So a SIGKILLed / crashed / timed-out Jest can
// never orphan a daemon to init (the 113-corpse leak). The real daemon is
// spawned by the client, never under Jest, so it never sees this variable and
// is never touched.
process.env[PARENT_PID_ENV] = String(process.pid);

// [LAW:single-enforcer] The one place the test suite stamps the package
// version (scripts/version-stamp.cjs): this worker's own sandbox global, and —
// through NODE_OPTIONS, inherited by every daemon a test spawns — each child's
// too. Without it src/version.ts refuses to load.
const stamp = createRequire(__filename)(
  path.join(__dirname, "..", "scripts", "version-stamp.cjs"),
) as { withStamp(nodeOptions: string | undefined): string };
process.env.NODE_OPTIONS = stamp.withStamp(process.env.NODE_OPTIONS);

// [LAW:single-enforcer] Every Jest worker is a renderer home of its own
// (src/daemon/home.ts), so nothing it builds or spawns reads or writes the
// machine's: its state, config and cache are under a root of its own, and its
// sockets bind in a runtime directory of its own, never beside the live bar's
// at /tmp/cc-candybar-<uid>. setupFiles re-runs in a fresh module context per
// test file, so randomUUID() gives directories unique per test file — not just
// per worker process (process.pid would be shared across every file that
// worker runs sequentially). A test that needs a home apart from the worker's
// builds one with the same three variables (prepareIsolatedDaemonEnv).
process.env[HOME_ENV] = jestTmpDir("home");
process.env[NAME_ENV] = "jest";
process.env[RUNTIME_DIR_ENV] = jestTmpDir("run");

// [LAW:single-enforcer] No test daemon ever asks npm what the latest release
// is: the tsx-harness daemons run `src/index.ts`, whose entry resolves to a
// not-source-checkout layout, exactly the shape that polls the registry
// (src/daemon/update-notice.ts). A closed port answers instantly with a typed
// `unchecked`; the e2e test that exercises the release arm points this at a
// local server of its own.
process.env.CC_CANDYBAR_REGISTRY_URL = "http://127.0.0.1:1";

// [LAW:single-enforcer] No test daemon reads the host's Claude Code
// directory: the bar reads the settings and transcripts of the directory the
// rendering CLIENT reports, and the test clients report this variable
// (test/helpers/daemon-e2e.ts, the spawned real client). An empty directory
// has no settings and no transcripts, so `today` seeds nothing of the host's.
// Tests that seed transcripts hand the store their own directory.
process.env.CLAUDE_CONFIG_DIR = jestTmpDir("claude");

// [LAW:single-enforcer] No test doctor reads the host's managed Claude Code
// settings (`DoctorEdge.managedSettingsDir`, src/doctor/edge.ts): a machine
// whose policy sets a statusLine would otherwise pass or fail effect refresh
// for every test daemon. A directory that does not exist holds no policy.
process.env.CC_CANDYBAR_CLAUDE_MANAGED_DIR = jestTmpDir("managed");

// [LAW:single-enforcer] No test load finds the host's installed cc-candybar
// plugins (src/config/loader/plugin-folders.ts): both data locations name a
// directory that does not exist. A test installing a plugin points them at
// its own.
const noPlugins = jestTmpDir("data");
process.env.XDG_DATA_HOME = noPlugins;
process.env.XDG_DATA_DIRS = noPlugins;

// [LAW:single-enforcer] The worker's named home reads none of these, but a test
// of the main layout builds a main home over this environment less the home's
// variables (`MAIN_ENV`, test/helpers/host.ts), and that home must not land on
// the host's: its config would join every such test's chain (the XDG location
// is the lowest layer, src/config/loader/discovery.ts), its state holds the
// host's answers for repository configs and its link key, and its cache the
// host's usage scans.
process.env.XDG_CONFIG_HOME = jestTmpDir("config");
process.env.XDG_STATE_HOME = jestTmpDir("state");
process.env.XDG_CACHE_HOME = jestTmpDir("cache");
