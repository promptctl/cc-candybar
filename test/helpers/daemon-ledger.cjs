// [LAW:nothing-unseen] Preloaded on every jest worker and every child of one
// (test/global-setup.ts), so a process entering the `daemon` subcommand records
// itself whatever brought it there: the spawn helper, a client that found no
// daemon, or a test's own spawn. Off that path this is one argv read. A daemon
// built in a worker is no process, and the harness records it itself
// (test/helpers/in-worker-daemon.ts).
//
// [LAW:no-silent-failure] Nothing here guards the write, so a daemon that cannot
// be recorded dies at boot and serves nothing.
if (process.argv[2] === "daemon") {
  const { LEDGER_ENV, ROUTE_ENV, TEST_FILE_ENV, recordDaemonStart } = require("./process-tier.cjs");
  recordDaemonStart({
    ledger: process.env[LEDGER_ENV],
    file: process.env[TEST_FILE_ENV] ?? null,
    route: process.env[ROUTE_ENV] ?? "raw",
  });
}
