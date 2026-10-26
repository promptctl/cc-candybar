# Testing

- Read rendered bytes through the test helpers' ANSI reader, not a regex of your own. Every link carries an id= derived from its URL, so a regex that spells out ESC]8;; matches nothing.
- Jest runs ESM through ts-jest. If an ESM dependency ships untranspiled, add it to the transform allow-list under both node_modules/<pkg> and pnpm's .pnpm shadow path.
- Tests time out at 30 s. Fake time and the filesystem rather than waiting on real ones.
- Test setup isolates the daemon from the host. Claude Code's config directory points at an empty dir, so no test picks up the host's memento. The registry URL points at a closed port, and managed settings at an empty dir. One integration test drives the host's real memento on purpose.
- Test daemons watch the Jest worker's pid and shut down when it dies, so a killed or timed-out Jest can't leave an orphaned daemon.
- Close any render cache a test builds. Otherwise its idle sweep keeps it, and every compile it serves, alive for the life of the worker.
- The authoring docs under docs/ are tested against the live loader, so editing a doc can fail tests.
- In a worktree whose node_modules is a symlink to the main checkout's, pnpm can refuse to run scripts. If it does, run the binaries in node_modules/.bin directly.
- The load gate fails on a Mac whose disk is stalled by other work, because a render still touches the disk. The CI runner is the authority on whether a build passes it.
