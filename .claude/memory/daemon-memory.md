# Daemon memory: the limit, the cache budget, disposal

## The limit judges what the platform charges

The memory backstop measures what the OS charges the process: the physical footprint on macOS, RSS on Linux. It avoids RSS on macOS because macOS RSS includes pages malloc has freed and marked reusable. A backstop that judges by that RSS kills daemons whose real footprint is far under the limit.

On macOS the footprint comes from a subprocess. It is read asynchronously once a minute, and each reading is scheduled only after the previous one answers. When a reading fails, RSS stands in, minus the gap between RSS and the footprint at the last good reading. That gap holds steady from minute to minute, and judging a failed reading on raw RSS kills healthy daemons too. A host whose footprint has never been read has no gap and is judged on RSS.

The env override for the limit keeps "RSS" in its name. It's a published contract, so don't rename it.

## A breach leaves two post-mortems

On a breach the daemon writes the platform's own memory attribution first, then a V8 heap snapshot, under one shared identity, and exits. The attribution is needed because a heap snapshot describes only V8's half. The breaches that trip the limit are the ones where RSS and the heap disagree: V8's own mappings, malloc, page tables and file-backed code, part of which no eviction can reach. Rotation keeps the newest few breaches, with both files for each.

## The render cache has a byte budget

The render cache's share of the memory budget is what is left under the line the doctor calls near the limit once the rest of the daemon is reserved, and never less than a quarter. A fixed fraction fails one way or the other: at a lowered limit it leaves the cache too little to hold the sessions being served, and at the default it either starves the cache or, full, crosses that line. The cache evicts the least-recently-used entries while its accounted bytes exceed the share, never the one being served nor one an open feed draws: a frame opens nothing, so an evicted feed's entry would stop the feed. Past the share with only those left, the cache warns rather than evicts. At the default limit the share holds several times the live working set. Past capacity, sessions rendering in turn miss on every render, and no miss is cheap enough to survive that, so a thrashing cache needs capacity, not cheaper misses. The costs per entry, per compile and per view are measured, and a test fails if real heap use exceeds any of them. Re-measure when you change what an entry, a compile or a view holds.

Entries share one compile when their configs compile alike. A new entry appears for every directory a session renders from: every worktree, every cd. With one compile per entry, that exhausted the memory limit several times a day. So a compile captures nothing that differs per directory: no store, no registry, no variables. A checkout-relative plugin path resolves into the variables, so a compile that read them would differ per worktree. A compile's template functions reach the render in progress through one binding. It is bound for the synchronous walk and unbound on every exit, so a shared compile keeps nothing from whoever drew last. A read with nothing bound throws.

## Retire, then reclaim when unheld

A render in flight holds the state it draws with. Eviction and reload swap the map at once and retire the state they no longer serve. One place disposes states, and only once a state is retired and no render holds it. So a render always finishes on the state it took its payload from, never on one disposed while it awaited the payload. A reload builds the new state completely before swapping, so a broken config keeps the last good one.

In the stats, a retired count that climbs while the cache size holds steady means a render never returned.

A reload whose resolved inputs are the ones the served state was built from keeps that state, because a rebuilt state reopens every session view and restarts its sources, and a save is always followed by its watch's reload of the same bytes. The key is typed over every input a build resolves from the config's files and folders, a plugin folder's generation included, so a folder's recovery still rebuilds, and an input added later fails to compile until it is keyed. What else a build reads belongs to the daemon and is the same for every load, so it is not keyed: anything there that starts to vary per load has to join the key, or a reload keeps a state built from its old value. A test that reloads to drive a build has to change what the config loads first.

## Dispose releases every MobX subscription

Disposing a store has to release its computeds' subscriptions. A keepAlive computed never unsubscribes on its own. If it read session state, it stays among the observers of the daemon-wide session-state atom for the daemon's lifetime, and it keeps the whole disposed store alive. The stats report that atom's observer count beside the session count. An observer count that climbs while the cache size holds steady is this leak. A test checks that the count drops back after a dispose.

## There is always a bar

Each cache entry starts with the bundled default's state. A config that fails its very first load still renders a bar, settings menu included, with its error behind the indicator beside the door.

## Tests

The cache's idle sweep is an interval armed on the first hold. A cache a test builds must be closed, or it and every compile it serves live as long as the Jest worker.
