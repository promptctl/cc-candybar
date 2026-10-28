# Capturing the surveyed statuslines

The explorer page plays each surveyed project's real statusline, as it printed in a sandbox
through a mock two-minute conversation. This directory is the pipeline that produces those
frames. Each script's docstring is the reference for its arguments and output shape; this file
is the process around them: the order, the decisions, the traps, and where things stand.

## The pipeline

Survey data lives outside the repo in `/tmp/ccland`: `src/<slug>/` holds every cloned project
(7,069 repos), `t2/measure.json` names each project's statusline files, and the explorer's
`export.py` reads the results from there. Slugs are `owner__repo`.

1. **Triage** — `triage.py` reads only the survey's statusline files of each project and stamps
   one tier: `skip` (boring), `unlocated`, `safe`, `review`, `risky`. Risky is obfuscation,
   eval, sudo at command position, credential reads, exfiltration shapes, and any project whose
   statusline is compiled-only (Rust, Go). Review is network, reading the transcript directory,
   reading Claude's own credentials file, writing settings, spawning claude, detaching.
2. **Fixture** — `fixture.py` builds the mock conversation: a `base/` home and a `tick/00..59/`
   directory per two-second tick, each with the hook JSON, the transcript so far, and the
   working tree as it stands (edits, a commit, a push). Figures are internally consistent and
   the rate-limit clocks are relative to the time the fixture is built.
3. **Resolve** — `resolve.py` turns each project of the named tiers into one shell command:
   a `statusLine.command` the author declared, with its paths pointed at the repo's own files,
   or a guess from the survey's file list ranked by reading stdin and being named like an
   entry. A Python module inside a package runs as a module so its relative imports hold.
4. **Deps** — `deps.py` fetches, on the host with network, what the entry imports: `bun install`
   with lifecycle scripts off, and `uv` with wheels only into `.ccland-venv` in the project
   root. Nothing from the project or the packages executes on the host. Run it, then re-run
   resolve so launch picks up the venv.
5. **Run** — `run.py` makes a run copy per project and width (home, stub tools, project), and
   at each tick swaps in that tick's working tree and transcript and runs the command under
   `sandbox-exec` with the tick's hook JSON on stdin. A frame is kept at every tick the output
   changed. `scrub.py` rewrites the host's user, host and run path out of every frame.
6. **Export** — the explorer's `tools/export.py` stamps each project `live` and writes the frames
   as a gzip blob the page inflates at load.

The commands, as last run (the runs directory must be a real path, not through the `/tmp` symlink):

```
python3 -I triage.py  /tmp/ccland/data.json /tmp/ccland/t2/measure.json /tmp/ccland/src /tmp/ccland/tiers.json
python3 -I fixture.py /private/tmp/ccland/fixture
python3 -I resolve.py /tmp/ccland/tiers.json /tmp/ccland/src /tmp/ccland/entries.json safe
python3 -I deps.py    /tmp/ccland/entries.json /tmp/ccland/src /tmp/ccland/deps.json
python3 -I resolve.py /tmp/ccland/tiers.json /tmp/ccland/src /tmp/ccland/entries.json safe
python3 -I run.py     /tmp/ccland/entries.json /private/tmp/ccland/fixture /tmp/ccland/src /private/tmp/ccland/runs /tmp/ccland/captures.json
sh ../../explorer/build.sh && (cd ../../explorer && node smoke.mjs)
```

`run.py` with slugs after the output path runs only those and writes only those, so a partial
rerun goes to its own file and is merged into `captures.json` by hand.

## The sandbox

`sandbox.sb` denies network, all of `/Users`, `/Volumes`, `/tmp`, `/private/tmp` and the user's
temp directory, and every write; then allows reads of the run copy, the project copy and the bun
runtime, writes inside the run copy, and metadata reads on the ancestors of the runs directory so
node can `lstat` its way down. Traps met on the way, each costing hours:

- A write under `/tmp` fails because `/tmp` is a symlink; every path handed to the profile is a
  `realpath`.
- A `regex` rule costs about a second per process spawn; every rule is `subpath` or `literal`,
  and the user temp directory arrives as a parameter.
- Apple's `/usr/bin/git` is an xcrun shim that stalls when the temp directory is denied; the
  fixture's `bin/git` is a symlink to the real git (`xcrun --find git`).
- A bar once listed this machine's Claude Code background tasks: it had read
  `/private/tmp/claude-501`. That is why the temp directories are denied.
- `whoami` and `hostname` answer from the kernel and the sandbox cannot fake them; the real
  user and host appeared in 22 bars. `scrub.py` rewrites them.
- A bar that leaves a helper running holds the pipes into the next tick; the runner kills the
  process group after every tick.

Docker was not an option: no daemon on this machine.

## Decisions

- **Width.** Captured at 80, 120 and 160 columns; the page draws the widest that fits, at the
  bar's natural size. Scaling the bar down was rejected.
- **Animation.** Sixty ticks of two seconds, looped, off one shared clock with a speed control,
  so every bar is at the same moment of the conversation.
- **Review tier runs.** The tier was a reading list for a reviewer, but every signal that puts a
  project there is something the sandbox and the fake home already contain. The sandbox is the
  enforcer, so the review tier runs the same way the safe tier does. The risky tier does not run.
- **Compiled statuslines do not run.** Rust and Go projects need a build, and a build needs
  network for dependencies. A prefetch outside the sandbox and an offline build inside it would
  be the route; not done.

## Where it stands

`/tmp/ccland/captures.json` holds 2,653 records, 2,091 ok: the safe tier (1,686 entries, 1,343
ok) and the review tier (966 entries, 748 ok). The explorer is built from it.

The top 300 projects by novelty and size have 125 bars. The 175 without, by tier: 70 risky (the
compiled ones, mostly), 33 review, 33 safe, 23 skipped as boring, 16 never located. The safe
and review failures that remain are mostly bars that run and print nothing: an entry that is a
library module, a wrapper around a binary nobody built, or a bar that needs a subcommand the
manifest does not name.

Things learned the hard way, so they are not learned again:

- A guess at the entry file flips a working one about one time in ten however it is weighted.
  The merge rule protects the page: a capture that is ok is never replaced by one that is not,
  so a rerun of changed commands goes to its own file and is merged by that rule.
- A bar can put the runner into an uninterruptible wait that nothing inside the process can
  escape, and a daemon that makes its own session outlives the sweep. The runner drives a child
  per project and kills the child's session at the limit; three such daemons from one project
  were found an hour after their sweep.
- Two runners sharing a runs directory collide on a slug and one dies. Pilot in a run of your
  own slugs, never beside a sweep that may reach the same slug.
- uv builds a venv on its own managed interpreter under the home directory, which the sandbox
  denies; the venv has to be built on the Homebrew python3.

Five bars show a truncated sandbox path containing only their own slug; cosmetic, and the cure
is a shorter runs path. One bar prints the root volume's free space, as a disk segment does.
