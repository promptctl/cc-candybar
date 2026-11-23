# Events

Status: design, nothing built.

## Owns

The queue, pure clicks, and Apply: the one writer in a renderer. The `Event` type in [../contracts.md](../contracts.md).

## Why

A click, a timer and a future webhook are the same thing: something happened. Each puts an event on one queue, and nothing else. Draw writes nothing. Everything that writes is downstream of the queue, in Apply.

The queue's implementation isn't the point. What matters is that an event source can't reach state, a file or an effect directly.

## Design

**`set-state` and `set-config` are pure.** Each produces an event. They don't flip switches, and nothing runs because of when they ran.

**A surface change is a declaration.** The renderer's output declares each session's lane switches, and the host reconciles the surface from the declaration (`src/daemon/declared-bar-panes.ts`), so nothing infers that a surface moved from a measurement taken before a handler and after its commit. A hand edit or another session's save moves no surface, because only a declaration does.

**Timers are event sources.** The idle close produces `idle-close`. It's one more source, not a special path.

**Effects stay what they are.** A click does what its button says. `dispatch` keeps running every effect and collecting errors, on purpose.

**Cut what doesn't convert.** A feature too tangled to make pure gets removed and rebuilt later in a law-aligned way.

**Every event emits one wide event**, extending today's click event, so a queue that did nothing is distinguishable from one that never ran.

[../inventory/verbs.md](../inventory/verbs.md) lists every verb's reach and the effects outside a handler.

## To survey

Not done. A future session should have a subagent produce:

- Every effect in `journaled`, in timers, in watchers and in other triggers, each marked converts cleanly, or cut.
- The complete `Event` union, replacing the sketch in [../contracts.md](../contracts.md).
- Which writers exist outside Apply after the change, which should be none.

## To probe

- **Ordering.** Every wake today happens after a click's writes and journal commit. Prove a frame never draws a half-applied event.
- **Effects that need Gather's facts.** Surface setup needs a session's pid and pane. The proposal is that Apply performs it from facts Gather sent, untested.
- **Click timing.** `src/renderer/verbs/index.ts` relies on a click's writes landing before its reply and the feed's next frame. Prove the queue keeps that, or define what replaces it.

## Done when

A test shows that handlers for `set-state` and `set-config` touch only the queue, no source of change reaches a writer except through Apply, and no handler infers a surface change from a measurement.
