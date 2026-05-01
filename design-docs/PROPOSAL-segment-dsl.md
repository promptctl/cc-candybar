# Proposal: Segment DSL — one DSL for the whole statusline

> **Supersedes** `PROPOSAL-toolbar-value-resolution.md`, `PROPOSAL-toolbar-dsl-rich-integration.md`, and `PROPOSAL-toolbar-dsl-v2.md`. Those proposals scoped fixes / replacements to the *toolbar* DSL. This proposal expands the scope to the whole statusline: every segment, every dynamic value, every cache, expressed in one declarative system.

## Why this exists

The codebase has accumulated five overlapping ad-hoc systems for what is fundamentally one concern — *produce a styled, single-line piece of text from input data*:

1. Each built-in segment is a hand-coded TypeScript class that pulls its own data, formats its own text, and emits its own styling.
2. Dynamic values are fetched independently per segment — git fields shell out from segment code; claude-input fields are read from a shared context object; per-session state lives in `~/.claude/.toolbar-state/<sid>` flag files.
3. The toolbar is a fifth such system: a hand-rolled mini-DSL with its own resolver dispatch (`TOOLBAR_RESOLVERS`), its own ANSI emission (`wrapOsc8`), and its own visibility convention (silent hide on unresolved).
4. There is no caching across renders — every render re-runs every git command, re-reads every file, re-walks every claude-input field.
5. Rendering can happen in two processes (statusline binary in-process, or daemon), with no shared cache, and click handlers mutate state from a third process again.

These systems share a shape but not a vocabulary. Adding any new feature means picking which one to extend, and either extending it consistently (rare) or duplicating it in a sixth way (typical).

This proposal replaces all of them with **one DSL** — a typed, declarative, daemon-resident system that compiles to rich-js primitives, with first-class typed variables, reactive caching across renders, and a single shared template engine.

## Preconditions

This proposal assumes two prior tickets have landed:

- **`brandon-daemon-architecture-5hs.11` (P0)** — daemon-only rendering. The statusline binary is a stdin→socket→stdout shim. All work happens in the daemon. Without this, the reactive cache lives in a process with the wrong lifetime and every variable's value diverges between processes.
- **`brandon-review-toolbar-proposals-3e1.1`** — rich-js gains a markup parser (`[bold]…[/]`, `[link <url>]…[/]`, with nesting). Without this, segment templates cannot carry style markup.

The chunk plan below treats both as gates.

## The three layers

```
┌─────────────────────────────────────────────────────────────────┐
│  Globals  →  default_bg / default_fg / default_empty_value /    │
│              default_separator / default_truncate_marker        │
├─────────────────────────────────────────────────────────────────┤
│  Variables (the value layer)                                    │
│   • declared once, named, typed (string | number | boolean)     │
│   • sources: literal, input, env, file, shell, template, time,  │
│              git                                                 │
│   • daemon-resident MobX store; reactive auto-invalidation      │
│   • per-variable cache policy (TTL / watch_file / depends_on /  │
│              key / never)                                        │
├─────────────────────────────────────────────────────────────────┤
│  Segments (the styling layer)                                   │
│   • single-line, no endpoints, no shell                         │
│   • template = go-template + rich-js style markup, woven        │
│   • layout: width (auto | int), justify, truncate, bg, fg       │
│   • visibility: when (predicate); the only way to hide          │
│   • optional segment-scoped vars sub-block (namespacing only,   │
│              same store)                                         │
└─────────────────────────────────────────────────────────────────┘
```

Built-in segments and user segments are **identical** — same declaration shape, same parser, same code path. Built-ins are simply default entries shipped in the default config, which the user can override or delete.

## Variable system

### Types

Every variable is `string | number | boolean`. Type is inferred from the source kind; explicit casts via filter pipeline (`| int`, `| string`, `| bool`) flex types in templates.

### Source kinds (closed set)

| Kind | Behavior | Inferred type |
|---|---|---|
| `literal` | Static value | from value |
| `input` | Field path into claude's stdin JSON (`session.id`, `cwd`, `model.short`, `state.activeProfile`, …) | string/number |
| `env` | Process env var | string |
| `file` | File contents (whole / first-line / regex group 1); newlines→spaces | string |
| `shell` | Exec command, optional regex group 1 extract; newlines→spaces | string |
| `template` | Go-template referencing other variables, with filter pipeline | from result |
| `time` | `Date.now()` formatted to layout | string |
| `git` | First-class git fields: `branch`, `sha`, `dirty`, `ahead`, `behind`, `stash` (each a separately-named variable) | mixed |

Adding a source kind = code change. Variable declarations cannot define new source kinds.

### Variable shape

```json5
{
  branch: {
    kind: "git", field: "branch",
    cache: { watch_file: ".git/HEAD" },
    default: "(detached)",
  },
  cwd_short: {
    kind: "template",
    template: "{{ .cwd | basename }}",
    // cache: auto-derived from MobX dep tracking
  },
  load_avg: {
    kind: "shell",
    command: "uptime",
    regex: "load average:\\s*([0-9.]+)",
    cache: { ttl: "5s" },
    default: "—",
  },
  toolbarExpanded: {
    kind: "input", path: "state.toolbarExpanded",
  },
}
```

### Cache invalidation

Each source kind has a default policy. User-overridable per variable:

| Source | Default policy | Override |
|---|---|---|
| `literal` | `never` | n/a |
| `input` | per render request | n/a |
| `env` | `never` (per process) | n/a |
| `template` | auto-tracked dependencies | `never`, `ttl` |
| `time` | `ttl: 1s` | any TTL |
| `shell` / `file` / `git` | **must declare one of:** `ttl`, `watch_file`, `depends_on`, `key`, `never` | required |

`depends_on: [varName, …]` — recompute when any listed variable invalidates.
`key: <template>` — recompute when the rendered key string changes.
`watch_file: <path>` — recompute when `path`'s mtime changes (one fs watcher per path; many subscribers).

### Reactive cache (MobX)

The daemon imports `mobx`. Each variable is either:
- A `computed` (for derived sources: `template`, `git` fields that wrap shell, etc.).
- A `box` (for sources without natural reactivity: `input`, `env`, `shell` driven by external triggers like TTL timers or fs watchers).

Templates' references to `.var_name` happen inside `computed` bodies; MobX auto-tracks the dependencies. When a `box` updates (TTL fires; fs watcher fires; render request lands new input JSON), every dependent `computed` invalidates transitively.

The render request is a one-shot **pull** through the graph — no `autorun`, no subscription. This keeps the request path simple: `runInAction(() => updateInputBoxes(payload))`, then read each segment's computed in `layout` order.

### Failure mode

Every variable has one fallback chain: source result → per-variable `default` → global `default_empty_value`. Failures (shell exit ≠ 0, regex no-match, file not found, missing input field) record a `last_error` timestamp and message on the variable for the debug command, but never throw out of the request path.

### Variable scoping

All variables are global to the daemon's MobX store. **No template-level locals.** A segment may include its own `vars:` sub-block; those declarations are still global (same store) but namespaced for clarity. Convention: a segment-local variable is referenced as `.<segment>.<var>`.

## Segment system

### Declaration

```json5
segments: {
  cwd: {
    template: "[bold]{{ .cwd | basename }}[/]",
    // width: "auto", justify: "left", truncate: "right",
    // bg / fg from globals
  },
  branch: {
    template: "{{ .branch }}{{ if .git.dirty }} [red]●[/]{{ end }}",
    when: "{{ ne .branch \"\" }}",
  },
  toolbar: {
    template: `
      [link cpwl://copy/{{ .session.id }}]#{{ .session.id | trunc 8 }}[/]
      [link cpwl://toolbar-toggle/]≫[/]
      {{ if .toolbarExpanded }}
        [link cpwl://set-profile/compact]
          {{ if eq .profile "compact" }}[green]{{ else }}[gray]{{ end }}compact[/]
        [/]
      {{ end }}
    `,  // illustrative; multi-line via JSON5 backtick or YAML block scalar
  },
}
```

Field reference:

| Field | Type | Default | Notes |
|---|---|---|---|
| `template` | string | required | go-template + style markup |
| `width` | `"auto"` \| int | `"auto"` | fixed width pads/truncates |
| `justify` | `"left"` \| `"center"` \| `"right"` | `"left"` | only meaningful when `width` is fixed |
| `truncate` | `"right"` \| `"left"` \| `"middle"` | `"right"` | overflow strategy when fixed-width |
| `bg`, `fg` | color spec | from globals | rich-js color spec |
| `when` | template predicate | always true | the only way to hide |
| `vars` | variable sub-block | empty | namespaced declarations |

### Template

The template string is **go-template + style markup** woven together. The parser interleaves both grammars — markup tags can wrap interpolations, interpolations can produce text inside markup spans, conditionals can switch markup spans:

- `{{ .var }}` — variable interpolation.
- `{{ .var | filter1 arg | filter2 }}` — filter pipeline.
- `{{ if expr }}…{{ else }}…{{ end }}` — conditional.
- `[bold]…[/]`, `[red]…[/]`, `[link <url>]…[/]` — style markup (rich-js parser).
- Markup nests; closing tag `[/]` matches most-recent open. Mismatched tags fail at parse time.

A single segment's template may produce **multiple rich-js cells** when it contains multiple top-level `[link …]…[/]` spans separated by literal text — each link span becomes its own cell with its own `Style({ link })`. This is what makes the toolbar a normal segment instead of a special concept.

### Compilation

At config load (and on hot reload), each segment's template parses to a typed AST: literal-text-nodes, variable-interpolation-nodes, conditional-nodes, style-markup-nodes. The AST is wrapped in a MobX `computed` whose tracked dependencies are exactly the variables it references. A segment's cell-list invalidates iff a referenced variable invalidates.

### Render

At render time, the daemon:
1. `runInAction(() => updateInputBoxes(requestPayload))` — push the new claude input JSON into the `input`-kind boxes.
2. Walk `layout` (the ordered list of segment names).
3. For each: evaluate `when` predicate; if true, read the segment's `computed`, which produces a list of `StripCell`s with `Style`s.
4. Apply per-segment width / justify / truncate.
5. Hand the cells to rich-js `Strip` + `Joiner` (segment-level joiner from globals or theme).
6. `renderToString` → return ANSI to caller.

### Constraints (re-stated)

- **Single-line.** A literal `\n` in evaluated output is a render-time error; surfaced in `debug vars` / `debug segments`.
- **No endpoints.** The renderer's Joiner draws powerline arrows. Templates do not.
- **No direct shell.** All dynamic data flows through `shell`-kind variables, which the daemon executes once and caches.

## Style markup

Lives in rich-js (blocked on `brandon-review-toolbar-proposals-3e1.1`). The DSL imports the parser; the markup grammar is rich-js's, not ours. The DSL's contribution is *interleaving* markup with go-template syntax in one combined parser pass.

## Template engine — go-template subset

We port a subset. The Go `text/template` grammar is small; a faithful subset is feasible to own.

**Supported:**
- `{{ .field }}` and `{{ .field.path }}` — variable / nested-field reference.
- `{{ .field | filter arg arg }}` — filter pipeline.
- `{{ if expr }}…{{ end }}`, `{{ if expr }}…{{ else }}…{{ end }}`.
- `{{ /* comment */ }}`.
- Literals: strings (`"..."`), numbers, booleans.
- Boolean exprs via filters: `{{ if eq .x "compact" }}`, `{{ if and (eq .a 1) (gt .b 2) }}`.

**Deferred (until a real need surfaces):**
- `{{ range }}` / iteration.
- `{{ define }}` / template composition.
- `{{ with }}` scope shadowing.

**Rejected:**
- Template-level variable assignment (`{{ $x := … }}`). Use the `vars` sub-block.
- Custom function definitions inside templates.

## Filter library — sprig subset

A closed, named subset:

| Filter | Behavior |
|---|---|
| `trunc N` | First N chars (or last if N<0) |
| `default V` | Replace empty with V |
| `lower` / `upper` | Case |
| `replace OLD NEW` | Substring replace |
| `basename` / `dirname` | Path |
| `trim` / `trimPrefix` / `trimSuffix` | Trim |
| `split SEP` / `join SEP` | List ↔ string |
| `int` / `string` / `bool` | Type cast |
| `printf FMT` | Format string |
| `eq` / `ne` / `lt` / `gt` / `le` / `ge` | Comparison (binary) |
| `and` / `or` / `not` | Boolean (var-arity) |
| `has` / `hasPrefix` / `hasSuffix` / `contains` | Substring tests |

The list is closed; extension is a code change. Chunk 7 (built-in library migration) may surface a need to add one or two; that's expected and budgeted.

## Daemon protocol

The daemon currently speaks one message kind: render request → ANSI string. We add two:

### `click`
```
request:  { kind: "click", verb: string, args: string[], sessionId: string, projectDir?: string }
response: { ok: true } | { ok: false, error: string }
```

The daemon dispatches `verb` to a registered handler. Handlers mutate state via the per-session-state API. State mutations cascade through the MobX store (`runInAction`); any variable that depends on the mutated state-key invalidates; any segment whose template reads those variables re-evaluates on next render.

**No event is pushed to anyone.** The statusline binary is short-lived and was not running when the click happened. It will pull the new state on the next render request claude triggers. There is no client to notify.

### `debug`
```
request:  { kind: "debug", what: "vars" | "segments" | "config" }
response: { ok: true, data: ... }
```

Backs the `claude-powerline vars` introspection command and similar.

The render request stays as today: `{ kind: "render", payload }` → `{ ok, output: string }`.

## Config format

JSON5 (`.claude-powerline.json5`). Allows comments, trailing commas, single quotes, multi-line strings via backtick — the things JSON forbids that make handwriting templates bearable.

The daemon detects the file extension and parses accordingly. The legacy strict-JSON `.claude-powerline.json` continues to load via the same parser (JSON5 is a superset of JSON).

Top-level shape:

```json5
{
  globals: {
    default_bg: "black",
    default_fg: "white",
    default_empty_value: "—",
    default_separator: " ",
    default_truncate_marker: "…",
  },
  variables: { /* see above */ },
  segments: { /* see above */ },
  layout: ["cwd", "branch", "toolbar"],
}
```

## Built-in segment & variable libraries

Every existing built-in segment ships as a default config block — same shape as user-declared. The shipped TypeScript classes for built-in segments are **deleted**. Same for built-in variables: every standard input-JSON field, every git field, every common time/env/file is a default variable declaration in the shipped config.

This is the proof of expressiveness: *if every existing built-in can be expressed in the DSL, the DSL is complete enough.* Migration is the integration test.

## Hot reload

The daemon watches the user's config file. On change:
1. Re-parse the file (JSON5 → typed declarations).
2. Diff against current declarations.
3. For unchanged declarations: keep the existing MobX node and its cached value.
4. For changed declarations: replace the node; downstream dependents auto-invalidate.
5. For removed declarations: drop the node.

A single hot-reload pass costs a parse and a diff; only changed nodes recompute. Editing a config file does not trigger a full re-render; the next render request pulls the (mostly cached) new state.

## Bite-sized chunks

Dependency-ordered. Each chunk ships independently with tests. Tickets to be filed once this proposal is accepted.

### Chunk 0a — Daemon-only architecture (PRECONDITION)
**Existing ticket: `brandon-daemon-architecture-5hs.11`** (P0).

### Chunk 0b — rich-js markup parser (PRECONDITION)
**Existing ticket: `brandon-review-toolbar-proposals-3e1.1`**.

### Chunk 1 — MobX-backed variable graph (foundations)
- Daemon-resident MobX store; variable types; type-checked filter casts.
- Source kinds shipped in this chunk: `literal`, `input`, `env`.
- Cache policies: `never`, per-render.
- Tests: dependency tracking, type checking, default fallbacks, MobX invalidation under various dep patterns.

### Chunk 2 — Go-template subset port + sprig-subset filters
- Parser and evaluator for the subset above.
- Filter library (closed set).
- Tests: golden parse-tree round-trips; evaluation against fixture variable contexts; useful error messages on unbalanced/unknown syntax.

### Chunk 3 — `shell` / `file` / `template` / `time` / `git` source kinds
- Plug onto chunk 1.
- Cache policies: `ttl`, `watch_file`, `depends_on`, `key`.
- One fs watcher per `watch_file` path; many subscribers.
- One TTL sweep timer per TTL bucket.
- Tests: shell command failure → default; regex no-match → default; file watch trigger → invalidation; time TTL.

### Chunk 4 — rich-js style-markup integration
- Once chunk 0b lands, wire its parser into the segment template parser.
- Combined parser for `{{ ... }}` + `[style]...[/]` interleaved.
- Tests: combined templates parse to expected mixed AST; nested styles; link with URL containing `]`; conditionals around markup spans.

### Chunk 5 — Segment compiler & renderer
- Segment AST + MobX store → list of rich-js `StripCell`s with `Style`s.
- Apply `width` / `justify` / `truncate`.
- Apply globals defaults.
- `when` predicate evaluator (reuses chunk-2 engine).
- Tests: width handling, justify alignment, multiple cells from one segment (toolbar shape), overflow truncation, `when` hides correctly.

### Chunk 6 — Top-level config loader (JSON5) + validator
- JSON5 parsing.
- Cycle detection across variables.
- Reference resolution: every `.var_name` in templates exists; every `depends_on` target exists; every `layout` entry exists.
- Validation surfaces with file:line and useful errors.
- Tests: every known invalid config fails with a useful message; valid configs load deterministically.

### Chunk 7 — Built-in variable & segment library + delete legacy
- Ship the standard library as the default config: input fields, git fields, time/env, the existing built-in segments (cwd, branch, model, sessionId, toolbar, claude-usage, …).
- **Delete the TypeScript-coded segment classes** — `src/segments/*.ts`, `parseToolbarDsl`, `TOOLBAR_RESOLVERS`, `wrapOsc8`, `interpolateToolbarText`, `applyClickActions`'s OSC 8 hand-rolling.
- Tests: byte-identical output for golden samples before vs after migration; the existing test suite passes (tests rewritten as needed).

### Chunk 8 — Daemon protocol additions (`click` + `debug`)
- Click handler binary becomes a daemon-IPC shim — no in-process dispatch, no direct disk mutation.
- Verb handlers (`set-profile`, `toolbar-toggle`, `copy`, `open-vscode`, …) live in the daemon, mutate state via the per-session-state API.
- `debug vars` / `debug segments` / `debug config` introspection.
- Tests: click → state mutation → next render reflects the change; debug commands return correct snapshots.

### Chunk 9 — Hot reload
- File watcher on user config.
- Diff-and-replace declarations in MobX store.
- Tests: edit-while-running; no spurious recomputes for unchanged variables.

### Chunk 10 — Tooling
- JSON Schema export for editor autocomplete.
- `claude-powerline lint <config>` validator command.
- `claude-powerline vars` debug CLI (already in chunk 8 as `debug vars`).

## Cross-cutting dependencies

```
[chunk 0a:   daemon-only]    ─┐
                              ├─→  everything below
[chunk 0b:   markup parser] ─┘

[chunk 1: MobX vars]  ─→  [chunk 2: template engine]
                                  │
                                  ▼
            [chunk 3: more sources] ─→ [chunk 4: markup integ] ─→ [chunk 5: segment render]
                                                                          │
                                                                          ▼
                                                          [chunk 6: config loader]
                                                                          │
                                                                          ▼
                                                  [chunk 7: built-in lib + delete legacy]
                                                                          │
                                                                          ▼
                              [chunk 8: protocol] ─→ [chunk 9: hot reload] ─→ [chunk 10: tooling]
```

## Out of scope

- The `cpwl://` URL contract (unchanged; verb handlers continue to read it).
- Theming / palette work (lands separately under `brandon-richjs-renderer-rewrite-bwr.3`; slots into `bg` / `fg` fields without DSL changes).
- Multi-line statuslines (segments are single-line by constraint; the wrap layer is rich-js's FlexStrip, unchanged).
- Per-(session, project) state scoping (`state.<key>` variables don't care about scoping at this layer).
- Cross-machine / cross-account state.
- The per-session state storage backend itself (kept under the existing `PROPOSAL-per-session-state.md`; this DSL only consumes its `state.<key>` variables).

## Open questions remaining

- **Multiline templates in JSON5**: even with JSON5, templates with embedded quotes and newlines are ugly. JSON5 backtick strings help; YAML block scalars would be cleaner. Possible to support both `.json5` and `.yaml` as front-ends to the same internal AST. Defer until a real config drives the answer.
- **Filter library final list**: chunk 2's tentative list may grow during chunk 7 migration. Acceptable to add filters during chunk 7 if a built-in segment turns out to need one.
- **Range / iteration in templates** (`{{ range }}{{ end }}`): unclear whether any built-in needs it. Defer; add when a real need surfaces.
- **Per-variable last-error retention policy**: keep last N errors? Just the most recent? Cheap to start with most-recent; revisit if debugging needs more.
- **Daemon click-handler registration**: handlers ship in code (not declarable in config). Keep it that way? Yes — verb dispatch is sensitive enough that it stays in TypeScript.

## Verification

The proposal is verified by chunk 7: every existing built-in segment is expressible in the DSL with byte-identical output for representative golden samples. If chunk 7 surfaces a built-in that *cannot* be expressed without growing the DSL, that's a proposal-level signal to revisit — not a chunk-level "add a hack" outcome.

The reactive cache is verified by:
- Render-cost measurement: a render with no input changes touches no shell commands and no file reads.
- A click-handler-mutation integration test: click → state variable changes → exactly the dependent segments invalidate; unaffected segments serve from cache.

The daemon-only invariant is verified by chunk 0a's tests, which the rest of this work assumes.
