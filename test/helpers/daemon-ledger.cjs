// [LAW:nothing-unseen] Preloaded on every jest worker and every child of one
// (test/global-setup.ts), so a process entering the `daemon` subcommand records
// itself whatever brought it there: the spawn helper, a client that found no
// daemon, or a test's own spawn. Off that path this is one argv read.
//
// [LAW:no-silent-failure] Nothing here guards the write, so a daemon that cannot
// be recorded dies at boot and serves nothing. The ledger is opened without
// create: appending would bring a deleted ledger back holding only the lines
// after the delete, and teardown would judge those as the whole run.
if (process.argv[2] === "daemon") {
  const fs = require("node:fs");
  const { LEDGER_ENV, ROUTE_ENV, TEST_FILE_ENV } = require("./process-tier.cjs");
  const ledger = fs.openSync(
    process.env[LEDGER_ENV],
    fs.constants.O_WRONLY | fs.constants.O_APPEND,
  );
  fs.writeSync(
    ledger,
    `${JSON.stringify({
      file: process.env[TEST_FILE_ENV] ?? null,
      route: process.env[ROUTE_ENV] ?? "raw",
    })}\n`,
  );
  fs.closeSync(ledger);
}
