# Proposal: Per-session state architecture

## Why this exists

Two features have already needed per-session UI state on disk, and a third (profile switcher) is queued behind it. Each implementation reinvents the file convention. The pattern accumulates state forever (the existing comment at `src/segments/renderer.ts:1192` admits "Sessions accumulate forever; acceptable for v1") and offers no atomicity, no concurrency story, no type safety, and no GC.

We need a single, small abstraction that future state-using features can target. The profile switcher is the right pretext for landing it because the profile is per-session by requirement (the user said so) — meaning the existing global-flag approach in the v1 plan was always wrong.

## Current state

Existing on-disk state:
- `~/.claude/.toolbar-state/<sessionId>` — file presence = expanded boolean. Per-session.
  - Read: `isToolbarExpanded` at `src/segments/renderer.ts:1193`
  - Write/toggle: `toggleToolbarExpanded` at `src/install/index.ts:287`
  - Writes are non-atomic (`writeFileSync` then later `unlinkSync`)
  - No GC: directory grows unboundedly

Existing in-memory state (good model to study):
- `usageCache` in the daemon — keyed by sessionId, with TTL sweep + LRU eviction
  - File: `src/daemon/cache/usage.ts`
  - Pattern: `Map<sessionId, Entry>` with `entries.delete + entries.set` for LRU bumping
  - Sweep loop drops stale entries past a TTL
  - This is the working reference for "how this codebase does session-keyed state"

The two state mechanisms share no abstraction. Their lifecycles, atomicity guarantees, and discovery surfaces are different. A third state type (active profile per session) would mean a third independent implementation.

## Requirements

A per-session state abstraction must:

1. **Single read/write API.** A consumer (renderer, click handler, daemon code) gets/sets state by `(sessionId, key)` without knowing where it's stored. Adding a new state key is one declaration, not a new module.
2. **Type-safe keys.** Each key has a known shape (boolean, string, structured). The compiler catches typos and shape drift.
3. **Atomic writes.** Click-handler writes and renderer reads happen in different processes. A renderer must never see a half-written value. Write-temp-then-rename, or single-file JSON writes (which atomically replace), are acceptable. Per-key files with directory mutations are not.
4. **Bounded accumulation.** Stale sessions get GC'd. Two viable mechanisms:
   - TTL on file mtime (sweep on every Nth write, or on daemon start)
   - Single per-session file with a "last touched" timestamp; GC sweeps by mtime
5. **Concurrency tolerance.** Multiple Claude Code sessions running simultaneously don't corrupt each other. Atomic-rename + per-session-keyed files is sufficient — no global lock required.
6. **Discoverable.** A debug command (or daemon endpoint) lists what state exists for a session. This catches "ghost state" bugs early.
7. **Migration path for existing toolbar-state.** The current `~/.claude/.toolbar-state/<sessionId>` flag must be readable through (or migrated into) the new API. No silent loss of in-flight expanded toolbars.

## Design directions to evaluate

These are sketches. Pick one or hybridize.

### Direction A: One JSON file per session, file-based
- Path: `~/.claude/.powerline-state/<sessionId>.json`
- Shape: `{ toolbar: { expanded: boolean }, profile: { active: string | null }, ... }`
- Read: parse JSON; absent file → empty object
- Write: serialize, write to `<file>.tmp`, atomic-rename
- GC: on each write, if `Math.random() < 0.01`, sweep files older than N days
- Pros: simple, daemon-independent, survives restart, atomic
- Cons: random-sweep GC is fragile; a parser failure on one key breaks the whole file

### Direction B: Daemon-mediated, with disk fallback
- Daemon owns an in-memory `Map<sessionId, SessionState>` with the same TTL/LRU pattern as `usageCache`
- Click handler talks to the daemon (existing protocol at `src/daemon/protocol.ts`) — fast, no disk
- If daemon is down, fall back to a Direction-A-style JSON file so behavior survives daemon restarts
- Pros: cheap reads, well-understood eviction (matches `usageCache`), discoverable via existing daemon-stats command
- Cons: two storage paths; cross-path consistency requires care (in-memory state lost on daemon restart, falls back to stale disk)

### Direction C: Just SQLite
- One file `~/.claude/.powerline-state.db`, table `state(sessionId, key, value, updatedAt)`
- Atomicity, concurrency, discoverability, GC (delete where updatedAt < threshold) — all native SQLite
- Pros: industry-standard, best concurrency story, single artifact
- Cons: heavy dependency for what is currently kilobytes of state; no precedent in this codebase

### Direction D: Daemon-only, no disk
- Daemon owns all session state; renderer reads via daemon protocol; click handler writes via daemon protocol
- State evaporates on daemon restart (which already happens periodically — see `daemon-self-shutdown` work)
- Pros: simplest model, leverages existing infrastructure, no GC
- Cons: state loss on daemon restart is a new UX surprise (user clicks profile button, daemon recycles 30 minutes later, profile silently reverts)

## Tradeoffs / open questions

- **Is daemon-required acceptable?** The daemon is now the default rendering path but the bare command still works (statusline command currently `node bin/cc-candybar …`, no daemon dependency). If we make state daemon-required, we cut off non-daemon users. If we make state disk-based, the daemon path becomes a cache rather than the source of truth.
- **What's the session ID lifecycle?** A session ends when Claude Code exits. We don't get a notification. TTL sweeping on disk works; in-memory state ties to daemon lifetime which has its own (planned) self-shutdown rhythm.
- **Cross-session shared state.** Some future state (theme override?) might be account-wide, not per-session. The abstraction should be `{ scope: "session" | "global", key }`, not session-only.
- **Per-(session, project) scope.** The profile switcher might want per-project, not per-session, defaults. State scoping needs to be data, not hardcoded.
- **How does an existing flag-file consumer migrate?** `isToolbarExpanded` in `renderer.ts:1193` is the live consumer. The migration plan can either (a) rewrite that callsite to use the new API and migrate-on-read, or (b) keep the flag-file path as one specific key in the new API.

## Smallest credible v1

If we want this to be the thing that *unblocks* the profile switcher and not a multi-week rebuild:

- Direction A (JSON files per session) without GC for v1
- A `SessionState` interface with two keys defined: `toolbarExpanded` (migrated from flag file) and `activeProfile` (new)
- A `readSessionState(sessionId)` / `writeSessionState(sessionId, mutator)` API in `src/state/` (new module)
- The `toggleToolbarExpanded` and the new `set-profile` handler both use the same read-modify-write helper
- GC defers to a follow-up; the test added now verifies "this code path doesn't leak across sessions" but the actual cleanup ships separately

This is roughly 100 lines + tests, doesn't lock us out of upgrading to Direction B/C/D later, and lets the profile switcher land on solid ground.

## Verification

- A test that runs two simulated "sessions" concurrently writing state and verifies neither sees the other's data
- A test that simulates an interrupted write (write tmp, crash, recover) and verifies the prior value is intact
- An integration test where the renderer reads state, the click handler writes state, and the renderer sees the new value on next render

## Out of scope

- Sharing state across machines / accounts
- Encryption of state at rest
- A schema migration system (until we have ≥3 state shapes that have evolved)
- Replacing the daemon's `usageCache` pattern (this proposal is about *new* state, not refactoring existing in-memory caches)

## Connection to the other two proposals

- **Toolbar value resolution**: independent. State storage doesn't change DSL shape.
- **DSL ↔ rich-js integration**: independent. The toolbar's render path doesn't care where state lives.

This proposal is the prerequisite for the profile switcher; the other two are prerequisites for any *toolbar* change but the profile switcher itself can land once this proposal is implemented even if the DSL hasn't been reworked yet.
