import type {
  ConfigSnapshot,
  LayerRole,
} from "../../config/config-snapshot.js";
import { walkLinks } from "../../utils/atomic-write.js";
import { directoryEntries } from "../../utils/directory-entry.js";
import { displayDigestOf } from "../../config/displayed-config.js";

// [LAW:one-source-of-truth] Discovery and the file-writing turn identify a
// destination by the directory entry a rename replaces. Replacing its bytes
// leaves a held stepper usable. Retargeting a symlink changes its identity.
export function configDestinations(
  snapshot: ConfigSnapshot,
  entryOf = directoryEntries(),
) {
  const paths = new Map<LayerRole, string | null>();
  for (const layer of snapshot.chain) {
    const walk = walkLinks(layer.path);
    paths.set(
      layer.role,
      walk.stopped === null ? entryOf(walk.hops.at(-1)!) : null,
    );
  }
  const id = displayDigestOf([snapshot.repo?.dir ?? null, [...paths]]);
  return { id, paths };
}
