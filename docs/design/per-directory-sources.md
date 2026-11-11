# Sessions of one directory share its shell and file sources

**What this document answers**

- What sharing the bar must keep once the host runs a renderer's sources, and why the directory is not what carries it.
- The design: what a run's identity is, where readings live, what the host keeps, and what order a session's events arrive in.
- How the sharing is checked.
- Which designs fail, and why.

The spec is docs/design/host-and-renderer.md. This note is the reasoning behind its rules for a shell source's environment, a declaration's canonical form, and a session's `config` event arriving before its request.

## The requirement

The daemon serves about 30 Claude Code sessions at once, almost always as clusters of sessions in one directory. Sessions of one directory must not each pay for what that directory already knows:

- One spawn or file read per period for the cluster, not one per session.
- A session that joins a cluster draws the cluster's values on its first bar.

## Sharing is a property of the read

A reading is determined by what was read: the command, its working directory and the environment it ran in, or the file's path; then the parser and the refresh. Two sessions that ask for one read share one run, whoever they are. A directory is only the common case of that: sessions of one directory ask for the same reads.

So the host keys every run by an identity that holds everything the read depends on and nothing else, and the renderer has no directory-level source. Sharing needs no mechanism of its own.

## The design

### 1. A declaration names its environment, and a run carries it

- **A declaration** is what a renderer subscribes: a command and its working directory or a file's path, a parser, a refresh, and for a shell source the names of the environment variables the command reads. The names are laid over a base set (`PATH`, `HOME` and the like) that is data in the bundled default.
- **A run identity** is what the host keys a run by: the declaration with each name replaced by its value in the session's environment. The collector, the one judge of every declaration, parses a declaration and a session's environment into a run identity.
- **The run is spawned with exactly those variables.** A variable the declaration does not name cannot change the output, so the identity is the whole truth about what the output depends on, and no session's run sees another session's environment.
- **Sessions whose named values agree share one run.** A session with another `PATH` gets its own, correctly.
- Environment values never reach a renderer. Two sessions can hold one declaration and different readings, which is why a reading is the session's.

### 2. Readings are per session, in world state

Each session's world state carries the readings of the runs that session subscribes. The renderer's shell and file sources are the view's, like every other value a session reads from world state. The rule that put a source in the directory's store unless its cache policy read a view's value goes, with the fixpoint that computed it.

### 3. The host keeps unheld runs under a count bound

A run nobody holds is kept, least recently read first out, as the tmux names, usage scans and plugin files already are. A kept run spawns nothing, because a period runs only while its entry is held. A returning hold finds the kept value at once: a period resumes where it left off, and a run with no period is read again once while its value stands.

A directory nobody draws stops spawning when its last session lets go.

### 4. A session's subscriptions reach the host before its request does

The router delivers a session's `config` event before that session's request. The `config` turn opens the session in the renderer and returns its subscriptions. The host declares them, and the request then waits on a world state that names every run it needs.

- A session joining a cluster finds each run held and read, so its request does not wait.
- A session whose run is new waits for its first reading, up to the client's deadline.
- A key that moves inside a turn is a new run served stale-while-revalidate: the old reading stands until the new one lands.

### 5. One canonical form

Two declarations that mean one read must be one identity, whatever order they were written in:

- Environment names are a sorted set, the base and the declared names merged before anything is digested. Naming a base variable twice, or in another order, changes nothing.
- A run identity carries its environment as a record of name to value. Every digest is taken over JSON with keys sorted at every level.
- A session's subscriptions leave in digest order, so an output is the same bytes whatever order a config declares in. The replay test depends on that.

Each form is built at the one place the value is made, so nothing downstream compares two spellings.

## How the sharing is checked

Each run's refresh event carries how many sessions hold it. With N sessions in one directory whose named variables agree:

- A source shows one refresh per period, shared by N.
- The N+1th session's first bar carries the value.

Both are read off the host's own events at normal use. No load is put on the machine to see them.

## Designs that fail

- **A whole-environment digest in the identity.** No two sessions have the same environment, so no run is ever shared.
- **A whole-environment digest minus a list of session-unique variables.** One variable missing from the list ends sharing silently, and the list is never complete.
- **No environment in the identity, with the run in whichever session's environment came first.** The reading is wrong for every other session, and one session's tokens reach another's command.
- **A directory-level source in the renderer, fed by a document of readings beside world state.** It is a second copy of a host fact with its own sequence, and it is wrong whenever two sessions of a directory differ in a named variable.
- **A directory-level source reading the newest of its sessions' world states.** It answers by which document arrived last.
- **The host holding for a new session what a sibling session subscribes.** That is a guess about what a renderer will ask for, kept beside the rule that subscriptions arrive whole in outputs.
