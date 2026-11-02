// [LAW:one-source-of-truth] Where each run's files live, relative to the package
// root. A file's layer is the directory that holds it, so these are the only
// places that name one: the jest configs select and ignore from here, and the
// boot judge reads BOOTS_DIR and PROCESS_TIER_DIR. CommonJS because the configs and a
// preload load it untransformed.

const UNIT_DIR = "test/unit";
// A test that boots the daemon lives under BOOTS_DIR: in a jest worker through the
// harness, or as a real process under PROCESS_TIER_DIR.
const BOOTS_DIR = "test/daemon-boots";
const PROCESS_TIER_DIR = `${BOOTS_DIR}/process`;
const E2E_DIR = "test/e2e";

// jest's testPathIgnorePatterns is a regex over absolute paths, so a bare
// "/test/e2e/" would also ignore every test of a checkout living under such a
// path; anchoring to <rootDir> makes it this checkout's directory.
const ignoring = (dir) => `<rootDir>/${dir}/`;

module.exports = { BOOTS_DIR, E2E_DIR, PROCESS_TIER_DIR, UNIT_DIR, ignoring };
