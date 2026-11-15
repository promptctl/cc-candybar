// The renderer's watches: each a watch the host's one registry holds under an
// id this renderer minted, from its `watch` notice to its `unwatch`. What the
// registry hears comes back as a `watch` push, which carries the targets the
// OS is not listening to as of that push, so a held watch's deafness is the
// latest push's. The registry tells every change in deafness as a window, but
// the acquire's own deafness arrives after the acquire, in the push that
// answers it: a push whose deafness moved from what the watch held is heard
// as an `unknown` window, so the holder re-derives what it says of it.

import type { HostCalls, WatchId } from "../renderer-interface/adapter.js";
import {
  followWatch,
  sameDeafnesses,
  type Deafness,
  type HeldWatch,
  type Invalidation,
  type WatchMove,
  type WatchSpec,
  type WatchTargets,
  type WatcherHandle,
} from "../daemon/foundations/watch-targets.js";

interface Held {
  deaf: readonly Deafness[];
  readonly heard: (invalidation: Invalidation) => void;
}

export class Watches {
  private minted = 0;
  private readonly held = new Map<WatchId, Held>();

  constructor(private readonly host: HostCalls["watches"]) {}

  // A watch of `targets` under `key`, whose every window `heard` hears.
  acquire(
    key: string,
    targets: WatchTargets,
    heard: (invalidation: Invalidation) => void,
  ): WatcherHandle {
    const id = ++this.minted as WatchId;
    // Held before the host is told, so a push the notice answers at once
    // finds it.
    const watch: Held = { deaf: [], heard };
    this.held.set(id, watch);
    this.host.watch(id, key, targets);
    return {
      release: () => {
        if (this.held.delete(id)) this.host.unwatch(id);
      },
      get deaf() {
        return watch.deaf;
      },
    };
  }

  // The held watch following `spec`, decided over keys (`followWatch`).
  follow(
    held: HeldWatch | null,
    spec: WatchSpec,
    heard: (invalidation: Invalidation) => void,
  ): { readonly watch: HeldWatch; readonly move: WatchMove } {
    return followWatch(held, spec, (key, targets) =>
      this.acquire(key, targets, heard),
    );
  }

  // A push of what watch `id` heard. A push for a watch released since the
  // host sent it is that release's: nothing holds the watch to hear it.
  pushed(
    id: WatchId,
    heard: Invalidation | null,
    deaf: readonly Deafness[],
  ): void {
    const watch = this.held.get(id);
    if (watch === undefined) return;
    const moved = !sameDeafnesses(watch.deaf, deaf);
    watch.deaf = deaf;
    const window = heard ?? (moved ? { kind: "unknown" } : null);
    if (window !== null) watch.heard(window);
  }
}
