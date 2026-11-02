# Events

Status: design, nothing built.

## Owns

The queue, pure clicks, and Apply: the one writer in a renderer. The `Event` type in [../contracts.md](../contracts.md).

## Why

A click, a timer and a future webhook are the same thing: something happened. Each puts an event on one queue, and nothing else. Draw writes nothing. Everything that writes is downstream of the queue, in Apply.

The queue's implementation isn't the point. What matters is that an event source can't reach state, a file or an effect directly.

## Design

**`set-state` and `set-config` are pure.** Each produces an event. They don't flip switches, and nothing runs because of when they ran.

**`journaled` goes.** It measures surface switches before a handler and after its commit, then infers that a surface moved. That is hidden ordering, the `[LAW:no-ambient-temporal-coupling]` violation. A surface change becomes an explicit `surface-requested` event carrying its intent. The memory doc's reason for the measurement still holds: a hand edit or another session's save mustn't restart every idle Claude Code. An explicit event satisfies that, because only a request produces one.

**Timers are event sources.** The idle close produces `idle-close`. It's one more source, not a special path.

**Effects stay what they are.** A surface click that restarts Claude Code does what its button says. `dispatch` keeps running every effect and collecting errors, on purpose.

**Cut what doesn't convert.** A feature too tangled to make pure gets removed and rebuilt later in a law-aligned way. Apparent first candidates:

| Candidate | Why it's tangled |
|---|---|
| Surface setup after a click | Inferred from a before-and-after measurement, with owed setups running on a later request or click |
| `doctor-run` reloading inside the measured window | An unseen hand edit gets attributed to the click |
| `undo`, `redo` and `rewind` writing through `writeConfigText` | They skip the loader gate and closing view, though isolation doesn't depend on fixing this |

**Every event emits one wide event**, extending today's click event, so a queue that did nothing is distinguishable from one that never ran.

[../inventory/verbs.md](../inventory/verbs.md) has every verb's effects and every side effect outside a handler. Its reach classes and dev rows are obsolete; its effect lists aren't.

## To survey

Not done. A future session should have a subagent produce:

- Every effect in `journaled`, in timers, in watchers and in other triggers, each marked converts cleanly, or cut.
- The complete `Event` union, replacing the sketch in [../contracts.md](../contracts.md).
- Which writers exist outside Apply after the change, which should be none.

## To probe

- **Ordering.** Every wake today happens after a click's writes and journal commit. Prove a frame never draws a half-applied event.
- **Effects that need Gather's facts.** Surface setup needs a session's pid and pane. The proposal is that Apply performs it from facts Gather sent, untested.
- **Click timing.** `src/daemon/verbs/index.ts` relies on a click's writes landing before its reply and the feed's next frame. Prove the queue keeps that, or define what replaces it.

## Done when

A test shows that handlers for `set-state` and `set-config` touch only the queue, no source of change reaches a writer except through Apply, and `journaled`'s surface measurement is gone.
