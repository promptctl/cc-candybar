// [LAW:behavior-not-structure] The providers' one close, as steps of a
// teardown: what a teardown that meets a throwing owner still ends, and what
// it says.

import { createPayloadProviders } from "../src/daemon/payload-providers";
import { FileEventDelivery } from "../src/daemon/cache/file-events";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import { systemTimekeeper } from "../src/time";
import { runTeardown } from "../src/utils/teardown";
import { HOST } from "./helpers/host";
import { unscriptedLauncher, unscriptedRuns } from "./helpers/fake-launcher";

function providers() {
  const log = () => {};
  const watchers = new WatcherRegistry({
    clock: systemTimekeeper,
    logger: log,
  });
  const built = createPayloadProviders({
    clock: systemTimekeeper,
    launcher: unscriptedLauncher,
    host: HOST,
    watchers,
    fileEvents: new FileEventDelivery({
      clock: systemTimekeeper,
      watchers,
      logger: log,
    }),
    logger: log,
    ledger: new RefreshLedger(log),
    sourceRuns: unscriptedRuns(),
  });
  return { built, watchers };
}

test("an owner whose close throws is logged by name with its stack, and every owner after it still closes", async () => {
  const { built, watchers } = providers();
  const closed: string[] = [];
  const gitClose = built.gitProvider.close.bind(built.gitProvider);
  built.gitProvider.close = () => {
    gitClose();
    throw new Error("git refused");
  };
  const storageClose = built.managedStorage.close.bind(built.managedStorage);
  built.managedStorage.close = () => {
    storageClose();
    closed.push("managedStorage");
  };
  const logged: string[] = [];
  try {
    const failed = await runTeardown(built.closes, (level, message) =>
      logged.push(`${level} ${message}`),
    );
    expect(failed).toEqual(["gitProvider close"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(
      /^warn gitProvider close failed: Error: git refused\n\s+at /,
    );
    // The last owner in the list closed although the first one threw.
    expect(closed).toEqual(["managedStorage"]);
  } finally {
    watchers.closeAll();
  }
});
