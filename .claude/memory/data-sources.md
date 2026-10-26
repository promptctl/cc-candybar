# Data sources: reading, holding, refreshing

## One owner per source; renders never fetch

Each shared source has one owner that schedules its reads: git state, PR lookups, tmux pane names, memento's ceiling, today's transcript scans, the auto-compact setting and the cache expiry. A read returns the stored value, and only a value that has never been read is awaited. Refreshes come from triggers (a watch, a period), never from a render. A pushed frame does no I/O at all. It draws what the owners have stored.

A render request waits for what its arrival started: the refreshes it triggers, the first value of every keyed source its view declares, and every run of its session's or its directory's sources that answers a key the source has no answer under yet: a first value, or a key or dependency that moved. A period's or a watch's re-read is not waited for, since it keeps the answer it has standing, and another session may have started it. It waits only until its client's deadline, less what the draw needs, and whatever has not answered then is drawn as pending. The client states the deadline because only the client knows when it hangs up: the native client counts its budget from before it connects, the Node client from after, and under load the daemon reads a request late. A config's first request compiles in its arrival turn, and that compile can spend the whole deadline, so the first bar from a new directory or config can be mostly pending. A frame waits for nothing, and anything not answered yet is drawn as pending.

A value the daemon itself made stale (a click's move) is pending too, but no request waits on it: the move may take as long as the program it ran, and a wait for it would end at the deadline with the bar from before the click. So a pending value says whether its key was never answered or was superseded, and a request waits only on the first.

A supersede holds back every other trigger of its key until it resumes, and overlapping supersedes need every resume, so no read that ran during a move stores the world from before it.

## Periods run only while something holds the key

Each session view declares the keys its preset reads, using the keys its request names: which repo, which pane, which memento scope, which Claude Code directory. Those declarations are the holds. A period runs only while its key is held. It measures from the last read that landed, and resumes where it left off. A preset switch takes the holds it newly needs before any draw and releases the old ones at once. Each source's LRU evicts only unheld keys. So data the old preset read costs nothing once released, and a daemon with no subscribers keeps no timer and makes no external call.

## Where a variable lives

Variables that read anything per session live in each session's view: inputs, state, templates, time, and shell or file sources keyed on those. Everything else lives in the directory's store and runs once, however many sessions render there.

## Git

Git state is keyed by repo root, not by cwd or session. Two things refresh it. One is a watch on HEAD, the index and the local branch refs. The other is a period over held repos, which also catches working-tree edits no watch sees and events a filesystem drops. A watch that fires mid-read queues exactly one re-read after it, so the last change always lands. A change in a repo nothing uses reads nothing until the repo's next use. A directory resolves to its repo only when a view declares, so drawing a frame never resolves anything.

## PR lookup

The forge lookup is a separate source on the repo, and a git refresh never awaits it. Its key is the branch plus the remote, so a branch switch or a re-pointed origin starts a new key. Each key keeps its last answer, so switching back to a branch answers from that branch's own lookup. The lookup period is longer after a success than after a failure. A branch's PR is its newest in any state. A merged or closed PR still counts only while HEAD is its head, because the forge matches by branch name and branch names get reused. A failed lookup shows as a visible error, distinct from "no PR" and never as a missing value.

## Not answered yet is its own state

A value is pending (not answered yet), absent (the domain has nothing), failed, or ok. Reading a pending value throws a pending signal. Every place that evaluates a template treats that signal as its own outcome, never as a failure. No error is recorded and no default is used, since a default stands in for a failure, not a wait. A pending placement draws loading cells laid out like the last frame drawn from the same source, so the bar doesn't reflow when the answer lands. A pending globals rule keeps the name it last settled on.

An input variable stays pending until its view's source is bound and answers its path. Its default answers only a payload that lacks the path, not a missing payload. A cache policy reads its source when the value it keys on first answers, not at declaration, so a view's source reads once when the view opens.

## Usage and today

Per-session usage records live in one store. Session totals and today's total are folds over that store, and nothing scans the transcript tree per render. Today counts the rendering session plus every record whose transcript sits under that Claude Code directory's projects. It doesn't count every session the daemon has seen, because that sum would change depending on which other sessions happened to render. Today's period rescans the tree, so sessions that never render (headless `claude -p`, the Agent SDK) still reach today within a minute. Today rolls over at local midnight without a refresh.

A transcript's change stamp is its mtime plus its size, because an append within one mtime tick changes only the size.

## Transcript folds are incremental

A fold keeps a byte cursor and running sums for each file and reads only the bytes appended since its last read. It reads in bounded windows of whole lines, so a cold fold of a huge transcript holds one window in memory, not the whole file. Reads go through a small gate of slots, however many folds are queued. A rewrite re-folds that file from zero. A rewrite shows up as an inode change (a rename-based /compact, log rotation) or as the file shrinking below the cursor (in-place truncation). A missing transcript is an empty fold, not a failure. Metrics and activity keep their own cursors over the same bytes rather than sharing the usage store's read, so the store's cursor and sums always change together.

## Activity: the turn boundary is a prompt

Activity facts come from message content, which the transcript parse otherwise drops, so they are reduced to bounded scalars at the one parse site. The turn boundary is a human prompt, recognised from the marks Claude Code writes. An entry with a non-human origin is another turn of the same prompt. The interrupt marker, built-in command tags, local command output, shell command tags, meta entries and compact-summary entries are not prompts. An entry with no mark at all is a prompt, so SDK input and older Claude Code versions (which write no origin) still count. Per-turn facts reset only at a prompt, the todo list never resets, and an interrupt clears only what was running. Tool call ids are kept only to pair a result with its call, and they never cross into the payload.

## Plugin storage

One daemon-wide owner reads every plugin's session files. A plugin source has no period: its folder's watch is its only trigger, so a folder that can't be created, a refused watch, or one that errors on a folder still there, is a standing failure of every source in the folder, never a silent stale value, and never the whole config's failure, since one plugin's folder must not take down the bar. The owner doesn't retry, because the OS refusing a watch (limits, permissions) refuses an immediate retry the same way. With no period, nothing visits an entry while no view holds it, so a hold returning to a kept entry re-reads it, drawing the kept value meanwhile; otherwise a file written while a session was away never reaches its bar.

A folder's watch is held by what declares the folder, never by a view, because opening or closing a directory watch leaks on macOS. A folder is keyed by its path and a generation the owner moves on every loss, because an install replaces folders by rename and ext4 reuses a freed inode number; birth time sits beside device and inode in a folder's identity for the same reason. An event naming the folder itself is checked against the disk, because a chmod, a utimes or an xattr reports the same name as a removal. A removed storage folder recovers by reloading the config through the watch that already follows the plugin's folder for its definition, because the watch registry follows nothing: the reload's build recreates the folder under a new generation, and a spurious fire reloads into the same key and opens nothing. Until then the lost folder's held files are re-read from the path, so no draw shows a value from a folder that is gone.

Only the daemon's storage owner creates, watches or sweeps a storage folder. A one-shot load, such as the doctor's, holds no session, so a sweep there would remove files the daemon's sessions hold.

## Memento's ceiling

cc-candybar doesn't know memento's config grammar. If memento rejects a line, its Stop-hook gate silently switches off. So readings come from memento's own in-force query, and moves go through memento's own command. A move supersedes its scope's reading. The read in flight is abandoned and the value stays pending until a fresh read lands, so no render after a move shows the old value. Memento runs with the session's memento environment from the hints, not the daemon's. Only an old client that sends no hint leaves the daemon's environment in place.

## Auto-compact window

The window changes only when someone types /autocompact in the session. It is read back from Claude Code's user settings in the session's Claude Code directory, and re-read only when that file's stamp changes. The file is user-global, so the value isn't per session. It's unverified whether other running sessions pick up a change.

## tmux

The pane comes from the client's hint. The daemon's own TMUX and TMUX_PANE are never read. A slash click types into that pane, so every bundled slash control is gated on the session being in tmux.

## Authoring a data-backed segment

docs/segment-authoring.md walks through it, and its snippets run in CI. A built-in segment is authored the same way against the bundled default. The one difference is the data source: a provider fills it into the payload, and input variables read it.
