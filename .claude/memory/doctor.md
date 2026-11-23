# Doctor

The Doctor is retired and will be rebuilt on the shared host. This file keeps what its probes learned about the machine, because that stays true and a rebuild starts from it.

Most of the facts a doctor needs are visible only to the statusline client, which inherits Claude Code's environment, so they arrive as hints.

## Claude Code settings

- The first scope that sets statusLine wins it whole. This was never verified, and the old checks depended on it. env merges key by key.
- Never write managed settings or a project's shared .claude/settings.json. The first is an administrator's policy, and the second is somebody's repository.
- Claude Code parses settings strictly: keys must be quoted and trailing commas aren't allowed. Edit settings files in that dialect.
- Refresh cadence is judged from the settings chain the session reads, not from request timing. Under load, no arrival pattern tells a timer from the events of a busy turn. And a statusLine from --settings, MDM or server-managed settings outranks every file a fix could write.

## Terminals

- Trust tmux's UTF-8 verdict for the attached client, not the locale variables. tmux has given different answers under LANG=C and LC_ALL=C.
- A terminal can't report what it drew, so a Nerd Font failure can only be marked by the user ("shapes" or "boxes"). A mark belongs per machine and keyed by the terminal's name, never its release.
- macOS doesn't fall back to an installed Nerd Font for private-use glyphs; CoreText's LastResort font draws them as a box. iTerm2 draws Powerline glyphs itself.
- Inside tmux, the session's env is the tmux server's start env. So ignore ITERM_PROFILE there, and judge whether the terminal is remote from the attached client's process ancestry (sshd, mosh-server). Never read a remote terminal's font locally.
- kitty and Alacritty name themselves only in TERM, which carries no release. For VS Code, don't read TERM_PROGRAM_VERSION: Cursor and Windsurf set TERM_PROGRAM=vscode alongside their own version numbers.

## Processes and state

- A daemon is identified by its entry path, resolved through links, plus a checkout marker. A process name alone is no identity.
- Session state persists and is never pruned, so what a daemon only observes in memory (a render sighting) must not be kept there: a session recorded by an older daemon would fail its check forever.
- Session state is one unversioned file that builds of either age read, because a rollback or a pinned install runs over a newer build's records. So a record there only gains fields and a field keeps its meaning. A new value of an existing field needs the same care: a parser that refuses values it doesn't know fails every click on that build.
- Node resolves its entry point through links, but argv[1] keeps the symlink of npm's global bin. Name a bundle by the resolved path.
- The native build stamp is computed by calling the repo's tsx binary directly. pnpm exec prints its install check on stdout, which would end up in the stamp.

## Probes must not block the loop

A probe runs on the daemon's event loop, so it must not block.

- The gh/glab login check is local only.
- Transcripts are read synchronously but non-blocking, because a FIFO at the transcript path would otherwise hang the loop.
