# Architecture

Status: design, except the Frame, which is built. [goals.md](goals.md) is what this answers to. The shapes crossing each seam are in [contracts.md](contracts.md).

## Vocabulary

These docs use the standard graphics terms. The code predates them, so it still says "lane" for two different things.

| Term | Means | The code's name today |
|---|---|---|
| Renderer | The process that turns facts and state into a Frame | "the daemon" |
| Frame | One rendered bar, the renderer's output | `Frame` |
| Encoder | Turns a Frame into what one surface accepts | `LANE_FRAMES` entries |
| Surface | Where a Frame appears: the band, Claude Code's statusline, a tmux pane, tmux's status row, a browser page | Lane, and the `renderer` setting |
| Built-in source | A fact Gather always reads: session, metrics, activity, context, git | Lane, in the payload |

## Two kinds of process

```
Claude Code client ──▶ renderer ──▶ Frame ──▶ surfaces
URL handler ──▶ Gather ──click by name──▶ renderer
                  │                          │
                  └───── SessionFacts ───────┘
```

**Gather** is one process. It gathers what is true about a session: transcripts, git, usage, host, tmux session names, plugin storage, and every `shell` and `file` source. It holds the clicks' stable address and routes each click by name. There is no renderer logic in it.

**A renderer** is one of any number of identical processes. Each runs:

```
Events ─▶ Apply ─▶ Draw
```

| Stage | Job |
|---|---|
| Events | Clicks, timers, watchers and anything later each put an event on one queue |
| Apply | The one writer: state, config, history, and every effect |
| Draw | A pure function from facts, state, config and an instant to a Frame. It writes nothing |

There is no special renderer, and no dev mode. Renderers differ only in values: name, socket, state root, config home, and the bundle they run from. The main renderer is simply the first. If a renderer is ever instrumented for development, that is added instrumentation, never a subset of behaviour.

## Which renderer a session uses

A client connects to a renderer, and that renderer answers it. Nothing selects.

- **The statusline command's path picks the build.** A client spawns the bundle beside it on a daemon miss, which is why the live daemon runs from the main checkout.
- **`CC_CANDYBAR_SOCKET` picks the socket.**

So a session runs on a worktree's renderer by starting Claude Code with those two values. A restart for that is fine.

Any number of renderers can follow one session's facts. The count doesn't matter to Gather, which sends to all of them.

*To probe:* how a session's statusline command can be set per launch, for example through `claude --settings`. How a client resolves "the bundle beside it" is taken from the memory docs; read `src/daemon/acquire.ts` to confirm it.

## Isolation

Isolation is paths. A renderer can do everything a renderer does, and it does it inside its own state root and config home. A click on a surface's switch does what the button says, in any renderer. See [areas/isolation.md](areas/isolation.md).

## What stays and what moves

From the state `createDaemon` builds in `src/daemon/daemon.ts`:

| Goes to | State |
|---|---|
| Gather | `payloadProviders` and its services, `watcherRegistry` for sources, `fileEvents`, `refreshLedger`, source registries, plugin storage, the tmux connections that replace `paneVisibility` |
| Renderer | `sessionState`, `settingsHistory`, `navigationHistory`, `effectSessions`, `renderWarnings`, `menuIdle`, `linkSigner`, `frameFeeds`, `tmuxStatusLines`, `laneSetups`, `runs`, `renderSightings`, `updateWatch`, doctor stores |
| Split | `renderCache`: config, compile and views go to the renderer, source registries and storage to Gather. It's the hardest piece |
| One per process | `stats`, `limits`, `binaryWatch`, shutdown state |

Today's daemon is therefore closer to a renderer than to Gather, and most of its code stays where it is. Every surface still connects to a renderer. Feeds, surfaces and surface setup keep working as they do, because they stay together in one process with the requests that feed them.

The tmux status line is one more surface of a renderer. A request takes it, so the renderer that answers Claude Code's client holds it, and the restore record tmux itself keeps already covers that renderer's death. It differs from other surfaces only in how a click travels, covered in [areas/clicks.md](areas/clicks.md).

`docs/design/inventory/verbs.md` classifies some of this differently, because it was written for an earlier cut. This table overrides it.

## Areas

Each area is one document with the same sections, written to stand alone against [contracts.md](contracts.md).

| Area | Owns |
|---|---|
| [frame](areas/frame.md) | Draw's output, encoders, deleting ANSI decoders |
| [events](areas/events.md) | The queue, pure clicks, Apply |
| [isolation](areas/isolation.md) | Renderer values, relative paths |
| [gather](areas/gather.md) | The Gather process, total facts, sources |
| [clicks](areas/clicks.md) | Names, the minter, the handler, routing |
| [lifetime](areas/lifetime.md) | Starting, supervising, versioning, memory |
| [tmux events](areas/tmux-events.md) | The control connection, the hidden bar pane, the off-screen rate |
