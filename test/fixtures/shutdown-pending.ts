import { writeFileSync, unlinkSync } from "node:fs";
import { daemonWorld } from "../../src/host";
import { runDaemon } from "../../src/daemon/server";
import { sessionStatePath } from "../../src/daemon/paths";

if (process.argv[2] === "daemon") {
  const world = daemonWorld();
  const marker = sessionStatePath(world.host) + ".pending";
  // [LAW:effects-at-boundaries] Hold the actual session write timer until
  // its owner cancels it on flush. All other daemon tasks run normally.
  runDaemon({
    ...world,
    clock: {
      ...world.clock,
      after(task, ms, fire, options) {
        if (task !== "session-state write")
          return world.clock.after(task, ms, fire, options);
        writeFileSync(marker, task, { flag: "wx" });
        return () => unlinkSync(marker);
      },
    },
  });
} else {
  // The daemon launches its renderer from the same entry.
  void import("../../src/index");
}
