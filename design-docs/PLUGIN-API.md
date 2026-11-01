# Plugin API

A plugin contributes to the bar the same kinds of value the bar is built from: sources, derived values, segments, helpers and actions. Plugins and the bar's own functionality share one vocabulary. Another program shows itself on the bar by shipping a plugin. cc-candybar's own segments can move into bundled plugins over time, one at a time, without changing what any user config reads.

This document is the sister of [SOURCES-AND-FRAMES.md](SOURCES-AND-FRAMES.md), which describes the model a plugin plugs into: every value that does I/O is a source with a scope and a refresh, owned by one scheduler, and a frame only reads. Read that first if the words *source*, *scope*, *refresh*, *hold* or *pending* are unfamiliar.

## Why this shape

Three requirements decide it.

- **cc-candybar knows no other program.** An outside program's integration lives in that program's plugin. cc-candybar never parses another program's private files and never reimplements its rules. It never parses Claude Code's plugin registry either: whether an outside program is installed is whether its plugin is.
- **Reads are file reads where they can be.** Spawning a command to draw the bar costs far more than reading a small file, so the API makes the cheap path the easy one. A program writes what it knows; the bar reads it when it changes.
- **The client stays a relay.** The statusline client forwards Claude Code's hook JSON and the few facts only it can see (terminal size, tmux pane, config path). It never gathers data for plugins. A fact a plugin needs about a session comes from that session's hook JSON or from what the plugin's own program wrote.

## What a plugin declares

A plugin is a folder named for it, holding `plugin.json5`. Everything it declares is named under `plugins.<plugin>.`, so no plugin can collide with the bar, the user's config or another plugin. It may declare:

- **sources**: values that do I/O (below);
- **variables**: the same vocabulary a user config has, derived values over sources and inputs;
- **segments** and **helpers**: as in a user config;
- **actions**: as in a user config, plus `run` (below).

It never edits the layout. Placing a segment is the user's choice, made in their config or from edit mode's add-segment library, where every installed plugin's segments appear.

Merge order is bundled < installed < listed < the user's file, so the user's file can retune any plugin's segment by its full name.

## Sources

A source is the authored form of the model's source type: a **scope**, a **refresh** and a **read**.

```json5
sources: {
  status: {
    scope: "session",
    refresh: { watch: true },
    read: { file: { json: true } },
  },
},
```

A template reads it as `.plugins.<plugin>.status`.

### Scope: what the value is per

The scope names the key the value is kept under, and so how many readings exist: one per `daemon`, `configDir` (a Claude Code configuration directory), `repo`, `directory`, `session` or `pane`. The key comes from the facts of the session reading it, the same facts the bar's own sources key on: the session id and workspace from the hook JSON, the working directory, the tmux pane and the Claude Code directory from the client's hints.

A key can carry more than the scope's own fact, because some of the bar's sources need it to:

- **another source's value.** A pull-request lookup is keyed by the branch the repo's read returned, so a checkout of another branch is a new key and reads pending until its own answer lands.
- **what the readers want.** The repo's read is keyed by the set of fields the active preset reads, so a preset that shows only the branch never pays for the working-tree counts.

So a key is a derived value over the scope's facts, other sources' values and the reading closure. A key that throws is that source's failure.

### Refresh: what makes it read

The same triggers every source has: `watch` (a file changed), `every` (a period, which may differ after a failure, such as 5 minutes after a good read and 45 seconds after a bad one), `request` (each statusline request of a session that holds the source), `reads` (named values changed) and `never`. A source reads only while some session's preset reads it: the session's view declares it from its closure and holds it, and a period runs only over held keys.

### Read: how the value is got

`read` is a union of readers.

- **`file`** reads a file and parses it as text or JSON. With no path, it reads the plugin's managed file for the key (below). With a path, it reads that path, which may be relative to the plugin folder or to the scope's own root (the checkout root for a `repo` source, a linked worktree being its own checkout).
- **`shell`** runs a command and reads what it prints, as a user config's `shell` variable does.
- **`module`** names an export of an ES module in the plugin folder: `read(key, prior)` returning the value or a failure. It is how a source that needs code is written. `prior` is the source's last value for the key, because several of the bar's own reads are folds: the transcript readers keep a cursor and running sums and read only the bytes appended since, and the repo's read reuses what it learned from an unchanged config.

Every reader yields the same outcome: a value, absent (the domain has nothing, such as no file yet), or a failure with its reason. Before the first read lands the value is pending, and a segment reading it draws its loading cell. Absent drops the value, so the segment's `when` can hide it; a failure draws `⚠` with its reason.

## Managed storage

A program that wants to show something per session should not have to invent a file layout, clean it up, or tell the bar where it is. The API gives every plugin one file per key, in its own folder:

```
<plugin folder>/session/<session id>.json
```

The plugin's program writes that file, whole, by writing a temporary file beside it and renaming it into place, whenever what it knows changes. cc-candybar does the rest. It creates the scope's folder when it first loads the plugin, watches the folder once for as long as a loaded config declares the plugin (a watch the OS has stopped feeding shows as a failure rather than a quiet folder), reads only the file that changed and only if a session holds it, and removes files that have gone untouched for 30 days and that no session holds. A `file` source with no path reads this file.

`session` is the scope the API stores first. The other scopes store the same way when a plugin needs one: a key that is not a safe file name is stored under the hex SHA-256 of the key.

The session id in the path is the one Claude Code gave the session, parsed where the request enters the daemon, so it can never name a file outside the folder.

## One owner per source

Each source has exactly one owner that schedules its reads, whichever plugin declared it. Plugin sources are owned for the whole daemon, not per directory or per session view: their watches go through the daemon's one watch registry, held for as long as the folder matters, so views opening and closing never open and close a watch. A session's view reaches every source it reads through the same declaration, whether the source is a plugin's or the bar's, so the set of sources is open: it is the union of what the loaded plugins declare.

## Names

A plugin's names live under `.plugins.<plugin>.`. A bundled plugin's live at the top level, so when one of the bar's own sources moves into a bundled plugin, `.git.branch` and `.session.cost` still mean what they meant and no user config changes.

## Actions

A plugin has the user config's actions (`set`, `copy`, `open`, `slash` and the rest) and one more that any config file may use:

```json5
actions: {
  raise: {
    run: ["/path/to/tool", "set", "+100000", "--session", "{{ .session.id }}"],
    env: { TOOL_HOME: "{{ .plugins.tool.status.home }}" },
    refreshes: ["status"],
  },
},
```

- **The draw evaluates it.** The argument list and `env` are templates the draw evaluates, as it evaluates `copy`'s text. A click runs exactly what the glyph promised, and nothing is evaluated at click time.
- **No shell.** The list is the program and its arguments. It runs in the directory of the file that declares it, so a config with no file, such as the bundled default, declares none.
- **The link is signed.** A `cc-candybar://` link can be opened by any web page, so a `run` link carries its session, its action name and its evaluated arguments signed with a key only the daemon holds, together with the action's declaration as the draw saw it. A link that fails the signature, names an action the session's config doesn't declare, or was drawn before that action was edited, is refused.
- **It runs off the click.** The click returns at once and the program runs asynchronously, bounded by one timeout. A non-zero exit, a timeout or a failed launch shows its stderr, or the reason when it printed none, in the session's click-error slot.
- **`refreshes` names what it makes stale.** Each named source is superseded: its value reads pending, any read in flight is abandoned, and a fresh read starts once the program exits. No draw after the click shows the value from before it.

## Trust

A config or plugin that comes from a repository runs only after the user approves it, by a click in the bar, once per version of its contents. The question lists everything risky the config uses, including its `shell` and `module` reads and its `run` actions. A user's own config and plugins installed into the user's or a package manager's plugin root never ask.

## How the bar's own functionality fits

Each of the bar's sources is a source of this API with a reader that exists or is designed above. Moving one is a matter of writing it as a bundled plugin's source.

| Today | Scope | Refresh | Read | What it asks of the design |
|---|---|---|---|---|
| auto-compact window | `configDir` | `request`, re-read only when the settings file's stamp moves | `file` (JSON) of the directory's `settings.json`; its controls are `slash` actions | nothing |
| tmux session name | `pane` | `every` 30 s | `module` (the name lives only in tmux's memory) | nothing |
| session cost, tokens, metrics, activity, cache expiry, speed | `session` | `request`, stamp-gated by the transcript | `module` | reads are folds: `read(key, prior)` |
| today's cost | `configDir` | `every` 60 s over held directories, plus each request's own session | `module` | reads are folds |
| repo state | `repo` | `watch` (HEAD, index, local refs) and `every` 30 s | `module` (counts and ahead/behind need git) | the key carries the fields the preset reads |
| pull request | `repo` | `every` 5 min after a good read, 45 s after a bad one | `module` (network, through `gh` or `glab`) | the key carries another source's value (the branch) |
| host, home | `daemon` | `never` | `module` | nothing |

## What is built first

The first slice is what an outside program needs to show a per-session value and move it from the bar:

- `sources` at `session` scope, read by `file` (JSON) on `watch`, with managed storage and its cleanup;
- the open set of sources a view declares;
- the `run` action with `refreshes` and signed links;
- plugin `variables`.

The `module` reader, the other scopes' storage, keys over other sources and wanted fields, and bundled plugins are designed here and built when the first of the bar's own sources moves. Until then the type admits only what is built, and a source declaring anything else fails to load with a message naming it.

A plugin's existing `data` (one JSON file beside the definition, or one per checkout) is a `file` source at `daemon` or `repo` scope and keeps its spelling until the plugins that use it move to `sources`.
