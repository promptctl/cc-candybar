# Data sources: reading, holding, refreshing

## One owner per source; renders never fetch

Each shared source has one owner that schedules its reads: git state, PR lookups, tmux pane names, plugins' session files, today's transcript scans, the auto-compact setting, the cache expiry and the host's name and user. The host name has a period because it follows the network and a daemon lives for days; the user shares it, because a lookup that failed (a directory service briefly away) must be tried again. A read returns the stored value, and only a value that has never been read is awaited. Refreshes come from triggers (a watch, a period), never from a render. A pushed frame does no I/O at all. It draws what the owners have stored.

A render request waits for what its arrival started: the refreshes it triggers, the first value of every keyed source its view declares, and every run of its session's or its directory's sources that answers a key the source has no answer under yet: a first value, or a key or dependency that moved. A period's or a watch's re-read is not waited for, since it keeps the answer it has standing, and another session may have started it. It waits only until its client's deadline, less what the draw needs, and whatever has not answered then is drawn as pending. The client states the deadline because only the client knows when it hangs up: the native client counts its budget from before it connects, the Node client from after, and under load the daemon reads a request late. A config's first request compiles in its arrival turn, and that compile can spend the whole deadline, so the first bar from a new directory or config can be mostly pending. A frame waits for nothing, and anything not answered yet is drawn as pending.

A value the daemon itself made stale (a click's move) is pending too, but no request waits on it: the move may take as long as the program it ran, and a wait for it would end at the deadline with the bar from before the click. So a pending value says whether its key was never answered or was superseded, and a request waits only on the first.

A supersede holds back every other trigger of its key until it resumes, and overlapping supersedes need every resume, so no read that ran during a move stores the world from before it.

A stored value changes only when a read finds something different, compared by structure. Every stored value is something a feed wakes on, so a period that rewrote an equal value would wake every feed showing it once a period.

## Periods run only while something holds the key

Each session view declares the keys its preset reads, using the keys its request names: which repo, which pane, which plugin session file, which Claude Code directory. Those declarations are the holds. A period runs only while its key is held. It measures from the last read that landed, and resumes where it left off. A preset switch takes the holds it newly needs before any draw and releases the old ones at once. Each source's LRU evicts only unheld keys. So data the old preset read costs nothing once released, and a daemon with no subscribers keeps no timer and makes no external call.

## Where a variable lives

Variables that read anything per session live in each session's view: inputs, state, templates, time, and shell or file sources keyed on those. Everything else lives in the directory's store and runs once, however many sessions render there.

## Git

Git state is keyed by repo root, not by cwd or session. Two things refresh it. One is a watch on HEAD, the index and the branch refs tree of the common git directory: a linked worktree's own git directory holds no refs, and a branch name's slashes are directories, so a watch one level deep hears neither a worktree's ref move nor one on a slash-named branch. The tree stops at the branch refs because on Linux a recursive watch costs one watch per entry, and remote refs and tags are the remote's to grow. The other is a period over held repos, which also catches working-tree edits no watch sees and events a filesystem drops. A directory watch binds an inode, not a path, so a git directory removed and recreated at its path (a worktree removed and added again under the same name, a re-clone) is deaf to the watch opened on it, with no event to say so. The watch's key is therefore the directories it bound, every pass derives it again, and a new key rebinds, so a recreated repo is heard within one period. Following the git directory through its parent instead would not do: the last worktree's removal deletes the worktrees directory too, and a parent watch on macOS delivers the whole working tree's events. A watch that fires mid-read queues exactly one re-read after it, so the last change always lands. A change in a repo nothing uses reads nothing until the repo's next use. A directory resolves to its repo only when a view declares, so drawing a frame never resolves anything.

## PR lookup

The forge lookup is a separate source on the repo, and a git refresh never awaits it. Its key is the branch plus the remote, so a branch switch or a re-pointed origin starts a new key. Each key keeps its last answer, so switching back to a branch answers from that branch's own lookup. The lookup period is longer after a success than after a failure. A branch's PR is its newest in any state. A merged or closed PR still counts only while HEAD is its head, because the forge matches by branch name and branch names get reused. A failed lookup shows as a visible error, distinct from "no PR" and never as a missing value.

## Not answered yet is its own state

A value is pending (not answered yet), absent (the domain has nothing), failed, or ok. Reading a pending value throws a pending signal. Every place that evaluates a template treats that signal as its own outcome, never as a failure. No error is recorded and no default is used, since a default stands in for a failure, not a wait. A pending placement draws loading cells laid out like the last frame drawn from the same source, so the bar doesn't reflow when the answer lands. A pending globals rule keeps the name it last settled on.

An input variable stays pending until its view's source is bound and answers its path. Its default answers only a payload that lacks the path, not a missing payload. A cache policy reads its source when the value it keys on first answers, not at declaration, so a view's source reads once when the view opens.

## Usage and today

Per-session usage records live in one store. Session totals and today's total are folds over that store, and nothing scans the transcript tree per render. Today counts the rendering session plus every record whose transcript sits under that Claude Code directory's projects. It doesn't count every session the daemon has seen, because that sum would change depending on which other sessions happened to render. Today's period rescans the tree, so sessions that never render (headless `claude -p`, the Agent SDK) still reach today within a minute. Today rolls over at local midnight without a refresh.

A transcript's change stamp is its mtime plus its size, because an append within one mtime tick changes only the size.

## Transcript folds are incremental

A fold keeps a byte cursor and running sums for each file and reads only the bytes appended since its last read. It reads in bounded windows of whole lines, so a cold fold of a huge transcript holds one window in memory, not the whole file. Reads go through a small gate of slots, however many folds are queued. A rewrite re-folds that file from zero. A rewrite shows up as an inode change (a rename-based /compact, log rotation) or as the file shrinking below the cursor (in-place truncation). A missing transcript is an empty fold, not a failure; a transcript that has to be read and cannot be is a failure with its reason, never an empty fold. A fold whose stamp still matches is served as it stands without a read, whatever the file's permissions now say. The change stamp never tells missing from unreadable: an empty stamp only means "not a hit", and the read is what classifies, so the stat must not grow a second classification beside it. Metrics and activity keep their own cursors over the same bytes rather than sharing the usage store's read, so the store's cursor and sums always change together.

## Activity: the turn boundary is a prompt

Activity facts come from message content, which the transcript parse otherwise drops, so they are reduced to bounded scalars at the one parse site. The turn boundary is a human prompt, recognised from the marks Claude Code writes. An entry with a non-human origin is another turn of the same prompt. The interrupt marker, built-in command tags, local command output, shell command tags, meta entries and compact-summary entries are not prompts. An entry with no mark at all is a prompt, so SDK input and older Claude Code versions (which write no origin) still count. Per-turn facts reset only at a prompt, the todo list never resets, and an interrupt clears only what was running. Tool call ids are kept only to pair a result with its call, and they never cross into the payload.

## File-event delivery is one fact

A watch the OS has stopped feeding reports nothing, exactly as a folder nobody writes does: macOS's fseventsd can wedge after days up, and then no directory watch in any process hears anything, with no error. Every directory watch in the daemon rides one FSEvents stream on macOS, or one inotify queue on Linux, so delivery fails for the whole daemon at once, and one owner judges it for every watch. Only writing tells a dead watch from a quiet folder, so that owner rewrites a probe in a folder of its own each period. The config's folder is the user's, a project's is a repository, and the state directory itself is written by the log on every request, so none of them can hold the probe. Two probes in a row unreported is a stall. One is not, because libuv's macOS watch drops what lands while it rebuilds its one stream, which any watch opening or closing in the daemon makes it do. The probe folder's identity is judged before delivery, because a folder replaced at its path never reports a probe to the old inode's watch. The same period judges every directory watch in the daemon against the disk, reopening one whose path holds another folder and opening a deaf one again: a strict ancestor renamed away and another tree put at its path reports nothing to the handle bound under the old one, and a refusal the OS has lifted is heard only by a retry. A reload that keeps its watch retries nothing, because one that did would answer the failed window its own handle's error told. A refused or failed watch, the folder gone or replaced, or a probe that can't be written leaves the daemon unable to check, and that reads as neither delivering nor stalled. The probe is a period on the watch's health, never on reads: re-reading on a timer would hide a sick fseventsd behind a bar that looks alive.

An edit made while the daemon can't vouch for delivery may never have been heard. So the span opens at a stall or at the move into unable-to-check, only an event the watch reports closes it, and closing it re-reads every config, every held plugin file and every source a config watches a file for, however the span ended. The bar's row stands for as long as the span is open, so a probe that lands but is not yet heard still warns.

While file events are stalled, every `watch_file` variable carries the stall as its standing fault, read from the delivery owner, so a stale value never reads as current. Every move of delivery re-reads them as a catch-up does, because a stall can end in unable-to-check with no catch-up to come, and no variable may drop the fault without reading again. The fault follows the stall and not the span, because unable-to-check is no finding about delivery: faulting on it would mark every variable for the life of a daemon whose watches may be hearing everything. The bar's row carries the rest of the span.

## Plugin storage

One daemon-wide owner reads every plugin's session files. A plugin source has no period: its folder's watch is its only trigger, so a folder that can't be created, a refused watch, or one that errors on a folder still there, is a standing failure of every source in the folder, never a silent stale value, and never the whole config's failure, since one plugin's folder must not take down the bar. The owner doesn't retry, because the OS refusing a watch (limits, permissions) refuses an immediate retry the same way. With no period, nothing visits an entry while no view holds it, so a hold returning to a kept entry re-reads it, drawing the kept value meanwhile; otherwise a file written while a session was away never reaches its bar.

While file events are stalled, every plugin source reads the stall as its standing failure. A stall doesn't move a generation, because a reload opens a new watch on the same stalled service. A folder found lost while stalled keeps reading the stall until delivery resumes, for the same reason: the reload that would move it on rides that stalled service, so a file read once from the path would freeze there unreported. Every period still judges each folder against the disk, because the event naming a removed folder and the follower's event that reloads its config ride one stream, which can drop both at once without a stall.

A folder's watch is held by what declares the folder, never by a view, because opening or closing a directory watch leaks on macOS. A folder is keyed by its path and a generation the owner moves on every loss, because an install replaces folders by rename and ext4 reuses a freed inode number; birth time sits beside device and inode in a folder's identity for the same reason. An event naming the folder itself is checked against the disk, because a chmod, a utimes or an xattr reports the same name as a removal. A removed storage folder recovers by reloading the config through the watch that already follows the plugin's folder for its definition, because a lost generation stays lost even after its watch has moved onto a folder made again at its path: the reload's build recreates the folder under a new generation, and a spurious fire reloads into the same key and opens nothing. Until then the lost folder's held files are re-read from the path, so no draw shows a value from a folder that is gone.

Only the daemon's storage owner creates, watches or sweeps a storage folder. A build outside the daemon, such as the doctor's or the demo's, holds none of the daemon's sessions, so a sweep there would remove files they hold.

## Auto-compact window

The window changes only when someone types /autocompact in the session. It is read back from Claude Code's user settings in the session's Claude Code directory, and re-read only when that file's stamp changes. The file is user-global, so the value isn't per session. It's unverified whether other running sessions pick up a change.

## tmux

The pane comes from the client's hint. The daemon's own TMUX and TMUX_PANE are never read. A slash click types into that pane, so every bundled slash control is gated on the session being in tmux.

## Authoring a data-backed segment

docs/segment-authoring.md walks through it, and its snippets run in CI. A built-in segment is authored the same way against the bundled default. The one difference is the data source: a provider fills it into the payload, and input variables read it.
