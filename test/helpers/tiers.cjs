// [LAW:one-source-of-truth] Where each run's files live, relative to the package
// root. A file's layer is the directory that holds it, so these are the only
// places that name one: the jest configs select and ignore from here. CommonJS
// because the configs load it untransformed.

const UNIT_DIR = "test/unit";
// A test whose subject is the daemon as a real process.
const PROCESS_TIER_DIR = "test/daemon-boots/process";

// jest's testPathIgnorePatterns is a regex over absolute paths, so a bare
// "/test/unit/" would also ignore every test of a checkout living under such a
// path; anchoring to <rootDir> makes it this checkout's directory.
const ignoring = (dir) => `<rootDir>/${dir}/`;

module.exports = { PROCESS_TIER_DIR, UNIT_DIR, ignoring };
