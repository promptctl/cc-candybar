# Sources and frames

The bar redraws up to 30 times a second while it moves, but the facts it shows change far less often: a repo's branch, a session's cost, a tmux session's name. So the daemon answers two questions with two owners. When a fact changes is its **source's** to say. When a frame is drawn is its **feed's** to say. A frame is the current values plus its instant, turned into bytes: no I/O, no refresh, no freshness check.

This is the model every value of the bar lives in. [PLUGIN-API.md](PLUGIN-API.md) is its sister: it describes how a plugin contributes values to this model, and how the bar's own functionality can move into plugins.

## Three kinds of value

Every value is exactly one of these, told apart by type.

- **A source does I/O.** It has a **scope** (what it is per), a **refresh** (what makes it read) and a **read**. A built-in provider, a user's `shell` or `file` variable and a plugin's source are one type.
- **A derived value is pure.** It is computed over other values (a template variable, a setting's effective value) and changes exactly when what it reads changes, in the same turn. It has no refresh.
- **A projection is pure over stored values and the frame's instant.** A countdown, a commit's age, an effect's phase. No store can hold it, because it would change every frame, so only the draw evaluates it. Whatever reads a projection is a projection too, so a derived value never reads the instant.

## Scope: where a value lives

A value has one home, keyed by its scope:

| Scope | Key | Example |
|---|---|---|
| `daemon` | none | the host name |
| `configDir` | a Claude Code configuration directory (a second one is a second account) | today's spend, the auto-compact window |
| `repo` | a checkout's root (a linked worktree is its own) | branch, status counts, pull request |
| `directory` | the directory a session renders from | a user `shell` variable that reads nothing per session |
| `session` | the session id | the session's cost, metrics, transcript folds |
| `view` | a session in one directory | the session's inputs in that directory's config, its picks |
| `pane` | a tmux pane | the tmux session's name |

A **session home** holds what belongs to a session wherever it renders: its latest request, its effect memory, and its session-scoped sources. A `cd` or a worktree changes none of these, so an effect keeps its clock and a transcript is folded once. A **view** holds what depends on one directory's config under the session's picks. A session has at most one view, the one for its latest request's directory, and a request from elsewhere closes it and opens the new one.

A user source's scope is derived, never authored: it is `view` when its key or dependencies read a session value, otherwise `directory`. So a `shell` keyed on a session input runs once per session, and one that reads nothing per session runs once per directory.

## Refresh: what makes a source read

| Trigger | Meaning |
|---|---|
| `every` | a period, which may differ after a failure (a good read and a bad one are retried on different clocks) |
| `watch` | a file changed |
| `request` | each statusline request of a session that holds the source |
| `reads` | values the source names changed (a `shell` keyed on an input) |
| `never` | read once |

A trigger that arrives while the source is reading is handled by its kind, one rule for every source:

- **It asks for the reading already in flight** (the same key, or a period's tick): it shares that read.
- **It says the world changed since the read began** (a watched file, a transcript append, a key's input): it queues exactly one re-read after the current one, so the last change always lands. The value stands as it is until then.
- **It says the daemon itself just changed what the source reads** (a click that moved the value): it supersedes. The read in flight is abandoned and never stored, the value is pending, and one fresh read starts.

At most one read is in flight per key, plus one queued re-read where the trigger is a change. Nothing else bounds the pile-up, and nothing else needs to.

## Holds: a source reads only while something draws it

A session's view declares the sources its preset reads, from the closure of everything the preset's templates read, and holds each one at the key its request names: which repo, which pane, which session. A period runs only over held keys, so a pane whose Claude Code exited or a session that closed costs nothing. A preset switch holds what the new preset reads before any draw and releases what it no longer reads at once. Each owner's cache evicts only keys nothing holds, so a session back from idle finds its last value kept, drawn while it is re-read.

Each source has exactly one owner that schedules it, and no draw schedules anything.

## Pending: not answered yet is its own state

A source's value is pending, a value, absent (the domain genuinely has nothing) or failed. Pending is never drawn as an answer.

- A placement reading a pending value draws its **loading cell**: `…` in its own colours, at the width it last drew. A placement that last drew nothing stays hidden. So a pending value never reflows its row or flashes.
- A failure still draws `⚠` with its reason.
- An input's default answers absence only, never pending. A user `shell` or `file` source's own default is its value until its first read, so it draws that default rather than `…`.
- A new key is pending until its own answer lands, so an old key's answer is never drawn for a new one: the pull request of a branch just checked out reads `…`, not the previous branch's PR. A re-read under the same key keeps its value until it lands.

The draw keeps one record of what each placement last drew, its frame memory. It is the one thing a draw writes, and it wakes nothing.

## Two paths, one draw

There is one renderer, and it is synchronous. A feed's frame is that draw alone. A statusline request declares its view, starts the refreshes its arrival triggers, waits, then calls the same draw.

- **A request waits until its client's deadline.** Its answer must show the model, context and cost it was sent with, so it awaits the refreshes its arrival started and the first value of every source its view newly holds. Only the client knows when it will hang up, so it sends its deadline with the request, and the daemon ends the wait early enough to leave room for the draw. What is still not answered draws as pending, and its landing wakes the next frame.
- **A view's payload is derived; a draw writes no input.** The payload is one computed over the view's request facts, its declared sources, the session's picks and the config's facts. So a source keyed on an input re-runs in the turn that input changes, never from a draw.
- **What moves with the instant is never stored.** Today's spend for the frame's day, a countdown, the click-error hold and the feed counters are computed at draw from stored instants against the frame's `at`.

## What wakes a frame

A feed draws as soon as its spacing allows when a value its bar reads changes:

- **its spacing** is the moving period (30 fps) while the bar is shown and moving, otherwise once a second;
- **a wake** moves the feed's one timer earlier, never later, so wakes of every cause coalesce and no source sets the draw rate;
- **the causes** are a source whose stored value actually changed (a re-read that found the same branch wakes nothing), a click's writes, a config reload and a change in what is visible.

So a click is on the next frame of an open feed, within the moving period if the feed just drew, and on the next statusline request without one.

## Lifecycle

The render cache owns directory entries, session homes and views, and bounds them all by one byte budget, a share of the daemon's memory limit. A view is a child of its entry: evicting an entry closes its views. Over budget, eviction takes the least recently used entry or session home, never one being served or one an open feed holds. A feed holds its session's home from open to close, and holds the session's current view only for the length of each draw, so whatever moved the view between frames is what the next frame draws.

## Seen

A failed refresh is logged once, by the refresh that failed, never per draw. Every source records each refresh in one ledger, by its trigger, with its outcome and its length. A refresh on any trigger but a request writes one event of its own. A request's refreshes are facts of its render event, which names each lane its arrival refreshed and how long it took, what drew pending, and how long the request waited against its deadline. The daemon's stats list every source's refreshes by trigger, its failures and its last refresh's length, with the homes of each scope. The feed's summary line counts its wakes by cause, how many coalesced, and the refreshes every source ran while it was open, beside the frames it drew.
