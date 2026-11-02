# Isolation

Status: design, nothing built.

## Owns

Renderer values in [../contracts.md](../contracts.md), and making state location a value. The values `createDaemon` builds that belong to a renderer stay one per process.

## Why

The primitive is an isolated daemon. It runs the same code and the same verbs as any other, and isolation comes from where it reads and writes, not from what it may do. Restricting verbs would be a dev-mode toggle, which is the wrong perspective at its core.

Today `CC_CANDYBAR_SOCKET` isolates only the socket and lease. `XDG_STATE_HOME` and `XDG_CONFIG_HOME` move the rest, as `prepareIsolatedDaemonEnv` already shows for tests. `pnpm bar` runs a real daemon this way, with every click on a config copy.

## Design

**No absolute path is stored.** Undo history holds paths relative to the state root, full stop. So do `render-origin` and `config-override`. Whole-file snapshots are fine, unless they contain an absolute path, which gets fixed the same way.

Today `settings-history.json` holds absolute paths, so undo in an isolated renderer given a copy could write the real config. With relative paths, that can't be expressed.

**A renderer's state starts from values, never from a copied history.** A new state root holds what its own events produced.

**A renderer's config home is its own.** It can start from a copy of the user's config, because a config file holds no state location.

**The link key lives in the state root**, so each renderer signs with its own.

**`load-config` is a removal candidate.** It lets a click point a session at any absolute `.json` or `.json5` path, which is the one verb whose purpose is to leave the config home.

## To survey

Not done. A future session should have a subagent list:

- Every path stored in state, history, `render-origin`, `config-override`, doctor stores and repo-config books, each marked absolute or relative.
- Every read of `configDir()`, `stateDir()`, `homedir()` and `XDG_*`, confirming each follows the values.
- Everything else a renderer could reach outside its roots through a stored value.

## To probe

- **Claude Code's own files.** `doctor-fix` and `band` setup write Claude settings and plugins. Those are the session's, by design, but confirm none of them holds a renderer path that then breaks another renderer.
- **tmux records.** Each names the socket of the daemon that wrote it, so a second renderer should leave the first's alone. The memory doc says so; two real renderers on one tmux server should confirm it.
- **Values reaching a real renderer.** `CC_CANDYBAR_SOCKET` alone isolates only the socket and lease, and nothing shows yet that `XDG_*` set when Claude Code starts reach a renderer its client spawns. Send one real request to a renderer with its own roots, then check the bar matches and the main renderer's log gains nothing.

## Done when

A test runs two renderers with different roots through every durable verb, and neither root's files nor any stored path mention the other.
