# Lifetime

Status: design, nothing built.

## Owns

How Gather and renderers start, connect, end and upgrade, and how memory is shared between them.

## Why

Today there's one daemon per socket, and the socket is its identity. Two process kinds need the same guarantees without a second supervisor to get wrong.

## Design

**Renderers start as daemons do today.** A client that finds no daemon at its socket spawns one from the bundle beside it, detached. A worktree's client spawns that worktree's bundle, so nothing new is needed.

**Gather starts on demand too.** A renderer that finds no Gather at the fixed path spawns one and dials it. The same lease and spawn lock that guard daemon start guard this.

**A renderer reconnects.** It follows the existing follower rules, and attaches again under the same name, so links on screen keep working after a rebuild. Gather restarting costs renderers their facts until they reconnect, and each shows that as pending.

**Gather's attach counter survives its restarts,** in a small state file, because reused attach ids could let a status line left by an old process match new links.

**The connection is versioned.** A renderer and Gather can come from different commits. A renderer speaking another protocol version than Gather is refused loudly on its bar. A worktree that changes a contract needs a matching Gather, and that includes any new built-in source.

**Which build Gather runs** is whichever renderer started it. That can be a worktree's bundle. Today's rule that a daemon ends when its bundle changes applies to Gather, so a worktree deleted under it ends it, and the next renderer starts it again.

**Costs measured so far** (`probes/p8.mts`, under `tsx`, one config):

| Measure | Result |
|---|---|
| Renderer memory above the runtime | About 150 MB: 278 MB against a 128 MB baseline |
| Config load | About 80 ms |
| A draw | 0.7 ms, or 1.4 ms with sparkle |
| Disk or process calls in 300 draws | Zero; controls proved the counter fires |

There are now always at least two processes, so the memory backstop divides. `.claude/memory/daemon-memory.md` governs that and must be read first.

## To probe

- **Spawn path.** Read `src/daemon/acquire.ts` to confirm that a client spawns the bundle beside it. This doc relies on the memory docs for that.
- **Gather's memory.** Unmeasured. It holds the data, not the compile, so its limit differs from a renderer's.
- **Which build should run Gather.** If a worktree's Gather causes trouble in practice, it may need to come from the installed bundle instead. Try it before settling.
- **Fork-bomb breaker and spawn locks.** `src/daemon/fork-bomb-breaker.ts` treats `CC_CANDYBAR_SOCKET` as a separate population. Check it holds with two process kinds.
- **Update flow.** `apply-update`, the binary watch and restart-on-rebuild across both kinds.

## Done when

Killing Gather, a renderer, or both, in any order, returns to a working bar with no manual step, and a version mismatch shows on the bar.
