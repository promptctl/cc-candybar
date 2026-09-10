---
name: rust-port
description: Loads for any design, planning, spike, or implementation work on porting the cc-candybar daemon to Rust — a request that says "rust port", "rewrite in rust", "rust daemon", "port the var-system / template engine / rich text to rust", "reactive_graph", or the memory diagnosis that precedes the port (vmmap, V8 heap statistics over time, why RSS breaches). It carries the port's hard boundaries, the design-first workflow per component, the phase sequence with its exit criteria, the parity and licence gates, and what "done" means; the reasoning and the facts live in design-docs/RUST-PORT.md. It is not for ordinary work on the TypeScript daemon or on the existing rust-client — those need no port context, and loading it would frame a bug fix as port work.
---

# Porting the daemon to Rust

## The doc is the source of truth

`design-docs/RUST-PORT.md` holds every fact and every reason. Read it first — `Summary`, then the sections your work touches (`Component map` before any crate, `Reactive runtime` before the store, `Sequencing` before claiming a phase is done). This skill holds workflow and hard constraints, never the doc's reasoning — and neither do you. When a decision changes, edit the doc — `Open questions` for a spike's outcome, the section that carries the fact otherwise — in the same PR as the code. A skill that argues with the doc is drift; the doc wins, and you fix the skill.

## Boundaries — the lines nothing will re-ask

The code you build keeps reminding you of the destination and never of these.

- **Behaviour-preserving.** Same socket path (`/tmp/cc-candybar-$UID/socket`), same wire format and protocol version, same config files and resolution order, same rendered bytes for the same payload. A feature change or a TS bug fix is a separate ticket on the TS daemon FIRST, then ported. It is never smuggled into the port.
- **Permissive licences only.** MIT, Apache-2.0, BSD, Zlib, MIT/Apache dual. Before adding any crate, read the licence from the crates.io licence field and record it beside the dependency. GPL, LGPL, MPL, AGPL, and unlicensed are refused — no "it's only a build dep", no exception.
- **The laws carry over verbatim.** Every `[LAW:…]` in CLAUDE.md is cited inline in Rust exactly as in TS: `// [LAW:one-source-of-truth] reason`, or `// [LAW:…] exception: reason`. A ported module that dropped its law markers is not ported.
- **The TS daemon keeps shipping through phase 3**, fixes and releases as before. Nothing in `src/` is deleted or degraded during phases 0–3.
- **No parallel renderer, ever.** At cutover the TS daemon is deleted, not kept as a fallback. Two renderers is what every law in this repo exists to prevent.
- **Phase N+1 does not start until phase N's exit criterion is met and recorded in `Sequencing`.** A phase you feel is done but have not written down is not done.

## Design first, for every component

Before writing Rust for a module:

1. Read the TS module AND its tests. The tests are the behaviour; the module is one implementation.
2. Write the Rust type shapes first. Every discriminated union becomes an `enum`, its arms enumerated from the TS TYPE, never from the TS control flow. `Presence = present | absent | Unchecked{path,error}` becomes an enum with three arms and every `match` over it is total — no wildcard arm, no `unreachable!()`.
3. For any predicate or parser, write the accept/reject table before the function.
4. Name which law each type enforces, in its doc comment.
5. Only then implement.

`What the port preserves` and `Component map` say which modules exist and what each guards; this list is the order you do them in.

## The three libraries (phase 1)

Three crates, per `Component map`: styled text and colour (from rich-js — OKLCH lives there, the daemon keeps no colour math), the template engine (from go-template-js, an own port: Go syntax, an opaque styled-text value flowing through typed functions — `Template engine` and `What the landscape shows` record why no existing crate fits), and the reactive runtime (the MobX subset). The maintainer has ported the first two once already; the runtime is the one with a real decision in it.

## The reactive runtime

The MobX surface is six primitives — signal, keepAlive computed, reaction, runInAction, createAtom, untracked — in three files: `src/var-system/store.ts`, `src/var-system/sources.ts`, `src/daemon/session-state.ts`. The doc's `Reactive runtime` section and its `Translation points` carry the mapping onto `reactive_graph` and the own-runtime alternative; this skill does not repeat them, so they cannot drift.

A phase-1 spike decides between the two on those translation points, and its outcome is written to the doc's `Open questions`. keepAlive-style caching with zero observers is verified by a test before any code relies on it. Do not skip the spike because one option "seems obviously fine".

## Workflow

Git, every time: clean tree; main at 0 ahead / 0 behind, or stop and report the state; branch; commit the finished work; push; open a PR — and invoke `memento:address-pr-reviews` on the PR in the same response as opening it. Run `lit quickstart` first; each phase is an epic, each component a child ticket; a ticket closes when merged, never when green.

## Verification

- `cargo test` per crate, and the Rust counterpart of each TS test the component had.
- **The byte-parity gate (phase 2 exit).** Drive BOTH daemons over isolated sockets with the same request JSON and diff the response bytes. Isolation: `CC_CANDYBAR_SOCKET` set to a short path (under 104 chars), each daemon's PID captured at spawn and killed by PID (never by socket lookup), export + spawn + verify + kill in ONE shell call, and the user's real daemon never touched.
- **Memory.** RSS over time under the maintainer's real session count — the live daemon, not a synthetic render loop.

## Phase 0: diagnose before you justify

`Why rewrite` names the reason; the measurement decides whether it is true. `vmmap` the live daemon and sample `v8.getHeapStatistics()` / `process.memoryUsage()` over time. Exit: one sentence in `Why rewrite` stating what the non-heap RSS is, with the measurement. If most resident memory is file-backed pages or subprocess churn, a port reproduces it — which is why this comes first.

## Temptations, rehearsed

- "Keep the TS daemon as a fallback for a release or two." That is a parallel renderer with a shutdown date nobody will honour. Delete it at cutover.
- "The reviewer says this crate is unmaintained; the maintained one is MPL." Refused. Write the code or find a permissive crate.
- "This union has five arms in TS but only three are reachable; I'll model three." Model five. The type is the program; reachability is today's control flow.
- "I found a TS bug; I'll fix it in the Rust version only." Ticket on the TS daemon first, then port the fix. Otherwise the parity diff lies.
- "The parity diff is one byte of whitespace, close enough." One byte is a different terminal cell. The gate is byte-equal.
- "The Go spec has this template feature; the DSL doesn't use it, but I'll add it." The engine serves the config DSL, not the spec. Port what the tests pin.

## Done

A phase is done when its `Sequencing` exit criterion is met AND recorded in the doc. The port is done when `cc-candybar install` stages the Rust daemon, the TS daemon and its bundle are deleted, `scripts/check-protocol.mjs` is deleted because one crate holds the constants, and every test that pinned daemon behaviour has a Rust counterpart or a recorded reason it does not. Short of that, report the phase and its state; do not call it done.
