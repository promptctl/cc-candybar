import fs from "node:fs";
import path from "node:path";

// [LAW:single-enforcer] The one rule for watching a path that may not exist
// yet, shared by the config watcher (src/daemon/cache/render.ts) and the
// file/shell sources' WatchManager (src/var-system/sources.ts).
//
// [LAW:dataflow-not-control-flow] Every path yields ONE (dir, name) watch
// tuple: the nearest EXISTING ancestor directory, and the path component
// directly beneath it. A path whose parent exists watches that parent for
// the file's basename; one whose parent does not exist yet (a fresh install,
// an app that creates its state directory on first run) watches the deepest
// ancestor that does, for the missing directory's name — so the mkdir is
// itself an event, and the watcher re-derives the tuple and descends.
export function nearestWatchTarget(candidate: string): {
  readonly dir: string;
  readonly name: string;
} {
  let name = path.basename(candidate);
  let dir = path.dirname(candidate);
  while (!fs.existsSync(dir)) {
    name = path.basename(dir);
    dir = path.dirname(dir);
  }
  return { dir, name };
}
