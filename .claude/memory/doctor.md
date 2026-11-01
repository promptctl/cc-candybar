# Doctor

Checks are data, and one fold runs them for both the menu's button and the CLI. Probes are pure. Every effect sits behind one edge.

Most of the facts the doctor needs are visible only to the statusline client, which inherits Claude Code's environment. They arrive as hints, and a click reasons over the hints recorded at the session's last render.

## Claude Code settings

- The first scope that sets statusLine wins it whole. This is unverified, and the checks depend on it. env merges key by key.
- Never write managed settings or a project's shared .claude/settings.json. The first is an administrator's policy, and the second is somebody's repository.
- Claude Code parses settings strictly: keys must be quoted and trailing commas aren't allowed. Edit settings files in that dialect.
- Refresh cadence is judged from the settings chain the bar's session reads, not from request timing. Under load, no arrival pattern tells a timer from the events of a busy turn. And a statusLine from --settings, MDM or server-managed settings outranks every file the doctor could fix.
- Whether a bar moves is read off the frame it drew, never inferred from the config.

## Terminals

- Trust tmux's UTF-8 verdict for the attached client, not the locale variables. tmux has given different answers under LANG=C and LC_ALL=C.
- A terminal can't report what it drew, so a Nerd Font failure lets the user mark what they see ("shapes" or "boxes"). The mark is stored per machine and keyed by the terminal's name, never its release.
- macOS doesn't fall back to an installed Nerd Font for private-use glyphs; CoreText's LastResort font draws them as a box. iTerm2 draws Powerline glyphs itself.
- Inside tmux, the session's env is the tmux server's start env. So ignore ITERM_PROFILE there, and judge whether the terminal is remote from the attached client's process ancestry (sshd, mosh-server). Never read a remote terminal's font locally.
- kitty and Alacritty name themselves only in TERM, which carries no release. For VS Code, don't read TERM_PROGRAM_VERSION: Cursor and Windsurf set TERM_PROGRAM=vscode alongside their own version numbers.

## Processes and state

- A daemon is identified by its entry path, resolved through links, plus a checkout marker. A process name alone is no identity.
- The URL handler always delivers to the default socket. So if a shell's socket override names a different daemon, the check refuses before opening any link.
- Render sightings live in memory, not in session state. Session state persists and is never pruned, so a session recorded by an older daemon would fail its row forever.
- Clicked terminals get a file of their own, separate from the mark book. Older builds parse the mark book strictly and refuse keys they don't know.
- If the spawn rate limit refuses a probe, the click is refused too. The refusal never becomes a fact.
- The CLI reads the doctor's stores through the daemon, never from files of its own.
- Session state is one unversioned file that builds of either age read, because a rollback or a pinned install runs over a newer build's records. So a record there only gains fields and a field keeps its meaning. A new value of an existing field needs the same care: a parser that refuses values it doesn't know fails every click on that build.
- Node resolves its entry point through links, but argv[1] keeps the symlink of npm's global bin. Name a bundle by the resolved path.
- The native build stamp is computed by calling the repo's tsx binary directly. pnpm exec prints its install check on stdout, which would end up in the stamp.

## Probes must not block the loop

A probe runs on the daemon's event loop, so it must not block.

- The gh/glab login check is local only.
- Transcripts are read synchronously but non-blocking, because a FIFO at the transcript path would otherwise hang the loop.
