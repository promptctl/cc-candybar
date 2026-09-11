# Backdating: an equal recomputation that invalidates nothing

Read against [salsa-rs/salsa](https://github.com/salsa-rs/salsa) at `e021c01d4939408c89c9325ad2426660117a8b32`
(shallow clone, 2026-09-07), a Rust incremental-computation framework whose memos are the reason
rust-analyzer does not reparse your crate on every keystroke.

## The mechanism

Salsa gives every memoized value **two** revision numbers where an obvious design gives it one, and
backdating is the write that moves only one of them.

A `Revision` is a single global counter, bumped once per input write (`src/revision.rs:11-13`:
"Each time an input is changed, the revision number is incremented"). Each memo
carries `verified_at` — the revision in which someone last confirmed this memo is usable — and,
inside its `QueryRevisions`, `changed_at` — the revision in which this memo's *value* last became
what it is now. The two live in different structs on purpose: `verified_at` is an
`AtomicRevision` on `MemoHeader`, `changed_at` a plain field on the `QueryRevisions` the header
owns.

Those two numbers are what let a query answer a question about the past. Reading a memo does not
report "I was computed in the current revision"; `fetch` reports the memo's own `changed_at`
upward (`src/function/fetch.rs`), and the reading query folds `max` over every input it touched
(`ActiveQuery::add_read`). So a query's `changed_at` is the newest change among its inputs, not the
revision it happened to run in. The question a dependent asks its input is
`maybe_changed_after(revision)`, and the answer is one comparison: `changed_at > revision` means
`VerifyResult::Changed`, otherwise `Unchanged`.

Backdating is what happens after a query has already been forced to re-execute. `execute` runs the
user's function, and if an old memo existed it calls `backdate_if_appropriate` with the old memo
and the *new* `QueryRevisions` before either is stored. Two conditions gate it. The value test is
`C::values_equal(old_value, new_value)` — the `Configuration` trait method the `#[salsa::tracked]`
macro fills in with `old_value == new_value`, i.e. the output type's own `PartialEq`; the `no_eq`
attribute replaces that body with the literal `false`, permanently opting a query out. The
eligibility test is `MemoHeader::can_backdate`, which refuses three cases: the new revisions have
cycle heads, the old memo may be provisional, or **durability decreased**. That last one is the
subtle guard. Durability is a coarse "how often does this kind of input change" lattice; if a value
stayed the same but its inputs became less durable, dependents that cached on the old durability
would stop being re-checked often enough. Becoming *more* durable is fine. `tests/durability.rs`
(`durable_to_less_durable`) is the pinned case.

If both hold, `MemoHeader::backdate` performs exactly one write:
`revisions.changed_at = self.revisions.changed_at`. The new memo keeps its fresh `verified_at`, its
new dependency edges, and its new value; only its "last changed" stamp is rolled back to the old
memo's. Every dependent that later asks `maybe_changed_after(r)` for some `r` at or after that old
revision is told `Unchanged` and never re-executes. Salsa's own book puts the consequence
crisply: a dependency can change in revision R1 while the output's `changed_at` predates R1.

The same rollback carries a correctness assertion worth copying even where the optimization is not.
Backdating must only ever move `changed_at` *backwards*. If the old memo's `changed_at` is
*greater* than the newly computed one, the query produced an equal value while depending on
strictly older inputs than before — which means it branched on state Salsa cannot see (a global, a
non-Salsa field on the database, a filesystem read outside a tracked query). Salsa panics on that
in debug builds and warns with a backtrace in release, and `tests/backdate_untracked_db_field.rs`
constructs the branch deliberately to prove the assertion fires.

To reimplement: give each memoized node a `changed_at` distinct from its `verified_at`; make a
reader's `changed_at` the max over the `changed_at` of everything it read; answer "did you change
since R?" as `changed_at > R`; and after any forced re-execution, if the new value equals the old
and the node's durability did not drop, copy the old `changed_at` onto the new memo instead of
stamping the current revision.

## Evidence

Paths are relative to the Salsa checkout root.

| Fact | Path | Lines | Excerpt |
|---|---|---|---|
| A memo carries two revision stamps in two different structs | `src/function/memo.rs` | 183-190 | `pub(super) struct MemoHeader {` / `    /// Last revision when this memo was verified; this begins` / `    /// as the current revision.` / `    pub(super) verified_at: AtomicRevision,` / `    /// Revision information` / `    pub(super) revisions: QueryRevisions,` |
| `changed_at` is the newest revision in which an input changed | `src/zalsa_local.rs` | 502-504 | `pub(crate) struct QueryRevisions {` / `    /// The most revision in which some input changed.` / `    pub(crate) changed_at: Revision,` |
| Reading a memo reports the memo's `changed_at` upward, not the current revision | `src/function/fetch.rs` | 36-41 | `let revisions = &memo.header.revisions;` / `zalsa_local.report_tracked_read(` / `    database_key_index,` / `    revisions.durability,` / `    revisions.changed_at,` / `    memo.header.cycle_heads(),` |
| A reader's own `changed_at` is the max over its inputs' | `src/active_query.rs` | 117-118 | `self.durability = self.durability.min(durability);` / `self.changed_at = self.changed_at.max(changed_at);` |
| The dependent's answer is one comparison against `changed_at` | `src/function/maybe_changed_after.rs` | 288-292 | `Some(if self.revisions.changed_at > revision {` / `    VerifyResult::changed()` / `} else {` / `    VerifyResult::unchanged_for_memo(&self.revisions)` / `})` |
| Backdating is attempted from `execute`, on the new revisions, only when an old memo exists | `src/function/execute.rs` | 83-92 | `// If the new value is equal to the old one, then it didn't` / `// really change, even if some of its inputs have. So we can` / ``// "backdate" its `changed_at` revision to be the same as the`` / `// old value.` / `self.backdate_if_appropriate(` / `    old_memo,` / `    database_key_index,` / `    &mut completed_query.revisions,` / `    &new_value,` / `);` |
| The gate is eligibility AND value equality | `src/function/backdate.rs` | 22-28 | `if old_memo.header.can_backdate(revisions)` / `    && old_memo` / `        .value()` / `        .is_some_and(\|old_value\| C::values_equal(old_value, value))` / `{` / `    old_memo.header.backdate(index, revisions);` / `}` |
| Eligibility refuses cycle heads, provisional memos, and decreased durability | `src/function/backdate.rs` | 39-45 | `revisions.cycle_heads().is_empty()` / `    && !self.may_be_provisional()` / `    // Careful: if the value became less durable than it` / `    // used to be, that is a "breaking change" that our` / `    // consumers must be aware of. Becoming *more* durable` / ``    // is not. See the test `durable_to_less_durable`.`` / `    && revisions.durability >= self.revisions.durability` |
| The backdate itself is one field write, and moving `changed_at` forward is a reported violation | `src/function/backdate.rs` | 54-58 | `if self.revisions.changed_at > revisions.changed_at {` / `    report_backdate_violation(index, self.revisions.changed_at, revisions.changed_at);` / `}` / (blank) / `revisions.changed_at = self.revisions.changed_at;` |
| Equality is user code, reached through the `Configuration` trait | `src/function.rs` | 78-83 | ``/// Invokes after a new result `new_value` has been computed for which an older memoized value`` / ``/// existed `old_value`, or in fixpoint iteration. Returns true if the new value is equal to`` / `/// the older one.` / `///` / ``/// This invokes user code in form of the `Eq` impl.`` / `fn values_equal<'db>(old_value: &Self::Output<'db>, new_value: &Self::Output<'db>) -> bool;` |
| The macro fills `values_equal` with `==`, and `no_eq` replaces it with `false` | `components/salsa-macros/src/tracked_fn.rs` | 103-115 | `let eq = if let Some(token) = &self.args.no_eq {` / `    if self.args.cycle_fn.is_some() {` / `        return Err(syn::Error::new_spanned(` / `            token,` / ``            "the `no_eq` option cannot be used with `cycle_fn`",`` / `        ));` / `    }` / `    quote!(false)` / `} else {` / `    quote_spanned!(output_ty.span() =>` / `        old_value == new_value` / `    )` / `};` |
| The violation message names untracked reads as the cause | `src/function/backdate.rs` | 99-105 | `"query {:?} returned the same value, but the previous execution changed at {:?} and \` / ` the new execution changed at {:?}. This usually means the query re-executed because \` / ` an input changed, but then branched on untracked state (for example, a global \` / ` variable, a non-salsa field on the database, or filesystem state read outside salsa) \` / ` and no longer read that input. This is usually a bug in the query implementation. \` |
| A test constructs the untracked-branch case and expects the panic | `tests/backdate_untracked_db_field.rs` | 59-61, 79-83 | `#[test]` / `#[cfg_attr(debug_assertions, should_panic(expected = "returned the same value"))]` / `fn db_field_branch_can_trip_backdate_assertion() {` … ``// R4/R5: switch branch via untracked db field, and force re-execution by changing `a`.`` / ``// New execution returns 0 (equal) but depends only on older `b`, triggering the backdate check.`` / `db.set_extra(1);` / `a.set_field(&mut db).to(1);` / `let _ = db_field_branch_query(&db, a, b);` |
| The durability caveat has a named regression test | `tests/durability.rs` | 37-40 | ``// Here, `add3` invokes `add`, which *still* yields 33, but which`` / `// is no longer of high durability. Since value didn't change, we might` / ``// preserve `add3` unchanged, not noticing that it is no longer`` / `// of high durability.` |
| The user-facing contract, including the `no_eq` opt-out | `src/lib.rs` | 156-160 | `//! If a query's dependencies have not changed, Salsa reuses its memoized result. After` / ``//! re-execution, Salsa compares the old and new results with [`PartialEq`]. If they are equal, Salsa`` / `//! preserves the memo's previous "changed at" revision. This optimization is called [backdating];` / `//! it prevents invalidation from propagating to dependents when the result has not changed. The` / ``//! `no_eq` option disables this comparison.`` |
| A dependency may change in a later revision than the output | `book/src/plumbing/fetch.md` | 28 | `* Thanks to backdating, it is possible for a dependency of the query to have changed in some revision R1 but for the *output* of the query to have changed in some revision R2 where R2 predates R1.` |

## What cc-candybar does today

**The equal-value short-circuit is already there, and MobX installs it in both node kinds.** This is
the first thing to say, because the problem statement this mechanism was read against is not
happening.

`BoxNode` stores its value in `observable.box(initial, { deep: false })`
(`src/var-system/store.ts:54`). MobX's `ObservableValue` constructor defaults `equals` to
`comparer.default`, which is `Object.is`, and `prepareNewValue_` returns the `UNCHANGED` sentinel
when `this.equals(this.value_, newValue)` holds — at which point `set` skips `setNewValue_`
entirely, so `reportChanged()` never fires and no observer is marked stale
(`node_modules/mobx/dist/mobx.cjs.development.js`, mobx 6.15.1, lines 1411-1412, 1450-1467,
1484). `ComputedNode` gets the mirror of it: `trackAndCompute` computes the new value and sets
`changed` from `!this.equals_(oldValue, newValue)`, storing and propagating only when `changed`
(same file, 1604, 1680-1699). A `keepAlive` computed whose recomputation lands on the same string
stops the cascade dead at that node. That *is* Salsa's backdating, minus the bookkeeping.

**So the git scenario does not invalidate anything downstream.** `declareGit` subscribes once per
cwd and, on each delivery, writes **one scalar box per field** through `projectGitField`
(`src/var-system/sources.ts:902-950`, the `setBox` at 927) — branch is a string, `dirty` a
boolean, ahead/behind numbers. A `.git/index` touch that leaves every field identical produces a
delivery in which every `setBox` hits MobX's `UNCHANGED` path, so zero observables report a change
and zero computeds re-evaluate. The premise that "every computed downstream of it re-evaluates" is
false at the store.

What the touch *does* cost is one `git status --porcelain=v2 --branch`
(`src/segments/git.ts:1072-1073`). `invalidateRepo` (`src/daemon/cache/git.ts:510-524`) drops every
entry for the repo and calls `refreshSubscribers`, whose loop immediately re-fetches through
`getGitInfoForRoot` (`git.ts:541-568`) — the shell-out `git.ts:435` names as the cold-cache cost.
Backdating cannot help there: the comparison it would perform needs the new value, and obtaining the
new value *is* the expense.

**And the render hot path consults no memo at all.** `renderDsl` walks the whole compiled tree
every tick (`src/dsl/render.ts:834`) and a segment leaf evaluates its template unconditionally —
`segCompiled.template.evaluate(ctx.scope)` (`src/dsl/node-registry.ts:361`), preceded by an
unconditional `evaluateWhen` at 340. Segment templates are not store nodes; only a
`kind: "template"` *variable* becomes a computed (`sources.ts:832-862`). So the per-render cost the
daemon actually pays is a full tree walk plus one `evaluate` per visible segment, and there is no
memoized output anywhere for a `changed_at` stamp to protect. Backdating is a rule for deciding
whether an existing memo may keep its old stamp; with no memo, it has nothing to act on.

**One place already does value-equality gating structurally, and does it well.**
`VariableStore.changeKey` (`store.ts:279-284`) is documented as "a string that changes exactly when
the node's value does", and for a document it is `JSON.stringify(node.read())` over a
sorted-key form. The `depends_on` cache policy compares the joined `changeKey`s through a MobX
`reaction` (`sources.ts:1092-1103`), so a re-scan producing identical content in a different key
order is not a change. `test/var-sources.test.ts:1192` pins the same-value case as a no-re-run.
This is exactly the right shape and the right comment.

**Two places where the short-circuit is genuinely absent.** First, documents. `DocumentCell` puts
an `Outcome<JsonValue>` in `observable.box(shaped(initial), { deep: false })` (`store.ts:138`) with
the default `Object.is` comparer, while `toDocument` (`src/var-system/types.ts:37-51`) builds a
fresh `Object.create(null)` (or a fresh frozen array) for every object at every level on every
scan. A `parse: { json }` source that re-scans byte-identical JSON therefore always produces a new
identity and always reports a change, and every `kind: "template"` computed reading a field of it
re-evaluates once. Second, the timestamp. `BoxNode.set` assigns `this.lastSetAt = Date.now()`
after the `cell.set` regardless of whether MobX accepted the write (`store.ts:62-66`), and
`DocumentCell.set` does the same (`store.ts:146-149`). `lastUpdatedMs()` is therefore "last write
attempt", not "last change" — and `src/daemon/debug.ts:120` reports it to a human as `ageMs`.

## The change

**Verdict: adapt, narrowly. Two edits in one file. Do not lift the two-revision memo.**

The primitive is already in the store; what is missing is that it reaches one node kind by
reference equality against a value the pipeline rebuilds on every scan, and that one derived field
records write attempts rather than changes. Both are Salsa's distinction, at cc-candybar's scale.

**1. `src/var-system/store.ts` — `DocumentCell`'s box compares by value, not identity.** Today the
box's comparer is `Object.is` against a freshly-allocated document; the change is to give it an
`equals` that measures the same thing `changeKey` already measures. Prefer routing it through that
one measure rather than reaching for MobX's `comparer.structural`: `changeKey` is already the
repo's single spelling of "this node's value changed" (`[LAW:one-source-of-truth]`), and a second,
subtly different notion of document equality living inside the cell is precisely the divergence
that comment exists to prevent. This replaces nothing — it closes the gap where the store's own
equal-value rule silently does not apply. Observable difference: a `parse: { json }` source on a
`ttl` or `watch` policy re-scanning unchanged bytes stops invalidating downstream `template`
variables. The comparison is paid once per scan, against a document `toDocument` already walked in
full on the same scan; it is not on the render path.

**2. `src/var-system/store.ts` — `lastSetAt` moves only on a real change.** MobX does not report
back whether it accepted a write, so the honest form is for `set` to consult the node's own equals
first and return early when the value is unchanged, updating neither the cell nor the timestamp.
This replaces the unconditional assignments at `store.ts:65` and `store.ts:148`. That early return
*is* the Salsa split, collapsed correctly for this codebase: `lastSetAt` becomes `changed_at`, and
there is no `verified_at` because nothing in cc-candybar asks when a variable was last confirmed.
Observable difference: the introspection `ageMs` at `src/daemon/debug.ts:120` stops reading near
zero for a variable that last actually changed an hour ago, which is the only reason that field
exists.

**3. `src/daemon/cache/git.ts` — no change.** Adding an equality gate in `doFetch` or
`doRefreshLoop` would suppress a `setBox` loop that MobX already makes free, and it cannot avoid
the `git status` that the fs-watcher fire pays for. Worse, it would sit at the wrong altitude:
`projectGitField` deliberately collapses `absent` and `failed` to the typed zero
(`src/var-system/sources.ts:385-389`), so an equality check downstream of that projection would
treat "no remote configured" and "git could not run" as the same value and hide a transition
between them. This is Salsa's durability refusal in a different costume — the same reason
`can_backdate` declines when a value stayed equal but became less durable. Keep the gate on the
value the store holds, never on a projection that has already thrown information away.

**4. `src/dsl/render.ts` — no change.** There is nothing to backdate. If the per-render template
walk is worth avoiding, the mechanism needed is memoization of the render output, and backdating
would be its equality rule rather than a change of its own. That is a different proposal and should
be argued on its own evidence.

**What Salsa's two-revision memo buys that a MobX `equals` comparer does not**, since that is the
question this lane was opened to answer: a *record*. MobX's `trackAndCompute` compares, returns a
boolean, and keeps no stamp; it can suppress propagation at the moment of recomputation and nothing
more. Salsa's `changed_at` survives the comparison, so any dependent can later be answered about
an arbitrary earlier revision — `changed_at > R` — without anything recomputing. That capability
has exactly one shape of consumer: something outside the graph holding a previous result and asking
"is mine still good?". cc-candybar has no such consumer. The wire protocol is a request carrying
hook JSON and a response carrying a rendered string; the client holds nothing between ticks and
asks nothing about the past. Building a revision counter and a per-node change stamp to serve a
caller that does not exist is carrying cost, and the store's comment at `store.ts:1-10` already
says why a parallel bookkeeping layer is refused. If a future wire capability let the client say
"I still have output X" — the `termCols`/`termRows` hint is the precedent — that is the moment to
build the stamp, and the thing to stamp is the render output, not every store node.

**One hazard this reading surfaced that is nobody's lane but worth a ticket.** Salsa's
`report_backdate_violation` exists because a memoized function that branches on untracked state can
return an equal value while its real inputs moved. cc-candybar can express that today: a
`kind: "template"` variable is a MobX computed (`sources.ts:841`), and the engine registers
`sprigDatetime(clock)` (`src/template-engine/engine.ts:87`), so `{{ now }}` inside such a variable
is a dependency MobX cannot see. That computed is already frozen at its first value — this is not
caused by anything above, and equality gating neither creates nor worsens it. But Salsa has an
assertion for the class and cc-candybar has none, and the cheap version is a loader-level refusal
or warning when a `template` variable's source names a clock function, not a runtime revision
counter. Separate ticket.

## Cost and risk

Build cost is small and contained: two edits in `src/var-system/store.ts`, plus tests. The
document-equality edit needs one test that re-scans identical JSON and asserts a downstream
`template` variable did not recompute — the natural home is `test/var-sources.test.ts`, beside the
`depends_on` same-value test at line 1192 that already pins the sibling behaviour. The timestamp
edit needs one test that sets the same value twice and asserts `lastUpdatedMs()` did not move.

What it breaks: any existing test that drives a document re-scan and asserts a recompute happened,
and any test asserting a fresh `ageMs` after a no-op set. Both are the behaviours being corrected,
so a failure there is the change working; the risk is only that one of them encodes an intent
nobody remembers, which is a reason to read each failure rather than to update it.

What it makes harder later: a value comparer on the document box means a future consumer that
wants to know "the file was re-read" (as opposed to "the content changed") has no observable to
hang on, because that distinction stops being representable in the cell. The right answer if such a
consumer appears is its own atom for the scan event, not a loosened comparer — and that is worth
saying now, because loosening the comparer back is the change that would look like a one-line fix.

Nothing here affects the RSS backstop (`src/daemon/limits.ts`). The comparison allocates nothing
beyond what `toDocument` already allocates on the same scan, and holding the previous document
alive for the duration of the comparison is what the box already does.

The honest measured benefit is small: the store's cascade already dies one level down at every
computed, so the document gap costs roughly one extra re-evaluation per downstream `template`
variable per identical re-scan, and the timestamp gap costs nothing but a wrong number on a debug
surface. Both are worth fixing because they are the store failing to do the thing its own comments
say it does, not because a profile pointed at them.

## Licence verdict

**`Apache-2.0 OR MIT`**, read from the checkout's `Cargo.toml` line 147
(`license = "Apache-2.0 OR MIT"`), inherited by the crate at line 6 via
`license.workspace = true`. Stated plainly because the instruction was to read the LICENSE file:
**this checkout has no file named `LICENSE`**. It ships `LICENSE-APACHE` (201 lines, the verbatim
Apache License 2.0 text) and `LICENSE-MIT` (23 lines, the verbatim MIT permission text), neither of
which carries an SPDX header — `grep -rn SPDX` over the whole checkout returns nothing. The manifest
is therefore the only place in the tree where the SPDX expression is written, and it agrees with the
two licence texts present and with what the survey recorded from the GitHub API.

Both members of that expression are on the maintainer's permitted list, so Salsa's code may be
copied and not merely paraphrased. It happens not to matter here: the two changes proposed above
copy no Rust and add no dependency — they are configuration on a MobX observable — so what crosses
over is the idea, and a comment naming Salsa is the whole of the attribution owed.
