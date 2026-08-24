<!--
  Interaction authoring reference — written for an AGENT config author.

  Snippet contract (enforced by test/doc-snippets.test.ts):
    ```json5 check:pass   — a COMPLETE config file; must exit 0 under `cc-candybar check`.
    ```json5 check:fail   — a COMPLETE config file; must exit 1, and the next
    ```error              — block must quote a substring of check's actual stderr.
  Every ```json5 block in this file MUST carry one of the two annotations.
  Do not edit a snippet or a quoted error without running the test — the quoted
  strings are asserted against the real loader, not transcribed.
-->

# Interaction authoring: actions, menus, groups

You are authoring a cc-candybar config **you cannot see rendered**. Every
mistake you make either becomes a load error (text you can read) or a wrong
pixel (which you cannot). This surface is designed so that the mistakes that
matter are load errors. Your loop:

```
edit config  →  cc-candybar check <path>  →  read exit code + stderr  →  repeat
```

Exit contract:

| exit | meaning |
|------|---------|
| 0 | config loads and renders — warnings (advisory only) on stderr |
| 1 | config is invalid — the diagnostic on stderr names the path, line, and fix |
| 2 | usage error / the named file could not be read |

Run `cc-candybar check` **after every edit**, before reporting done. It runs
the daemon's exact pipeline (parse → merge on the bundled default → validate →
register → render against a rich representative payload), so "check exits 0"
and "the daemon renders it" are one fact. It also fails (exit 1) when a
segment's template throws at evaluation — the state a user would see as a `⚠`
error cell in the bar. `cc-candybar lint` is an alias; `cc-candybar schema`
prints the JSON Schema.

A user config **merges onto the bundled default** by name (globals per-field;
variables/segments/actions/looks/helpers per-name; `root` replaces wholesale).
Declare only what differs. The bundled default already declares `session.id`,
`theme.effective`, `look.effective`, `term.cols`, every built-in segment, and a
looks stdlib (`none`, `vivid`, `muted`, `dim`, `bright`, `inverted`) — never
re-declare them.

## The decision rule

One rule, applied once per interactive element:

- **Pick a value from an option domain** (theme, style, look) → `{{ menu "applyAction" }}`
  in a segment template. One call = trigger glyph + drop-below picker + all
  backing state, synthesized.
- **Collapse/reveal arbitrary layout** (a details drawer, a links panel) →
  `{ kind: "group", … }` in `root`.
- **A single click effect** (copy, open, cycle, step) → `{{ action "name" … }}`
  bound to a declared action.
- `{{ picker }}` is the desugaring `{{ menu }}` compiles to. Understand it
  (examples/demo-actions.json5 spells it out), **never author it** — hand-wiring
  the page cursor and the when-gated reveal row is how configs silently freeze
  on page 0.

## Actions: the behavior table

Interaction is decoupled by **name**: the `actions:` block declares what a
click does; templates bind clickable regions to those names. The click gate on
the wire is derived from the same declarations, so a template cannot smuggle an
un-gated write.

An action declares exactly one of `set` / `persist` / `copy` / `open` /
`reset` / `undo` / `redo`; a `set` or `persist` declares exactly one value
source:

| declaration | click effect |
|---|---|
| `{ set: key, to: "value" }` | write the literal value to **SessionState** (per-session, until the session ends) |
| `{ set: key, from: "themes" \| "styles" \| "looks" \| "charsets" \| "colorCompatibilities" \| [...] }` | write the option the template binds (picker/menu domain) — a registered domain name, or an inline array of literal values needing no registration |
| `{ set: key, min: 0, max: 60, by: 2 }` | step the current value by `by`, wrapping in `[min, max]` |
| `{ set: key, int: true }` | write any integer the render binds (a page cursor) |
| `{ set: key, cycle: ["a", "b", "c"] }` | write the **successor** of the current value, wrapping; order members default-state-first |
| `{ persist: field, to \| from \| min/max/by \| cycle, … }` | the SAME four value sources as `set`, but writes the **config `globals` default** durably (every session, survives daemon restart) instead of one session — see below. No `int` arm: a page cursor is never persisted. |
| `{ reset: field }` | clear one persisted `globals` field, restoring the config-file/bundled value |
| `{ undo: true }` | step the overrides layer's **global history** one entry back — restores whatever a PRIOR `persist`/`reset` write changed, any key, not just the one this action names (it names none) |
| `{ redo: true }` | re-apply the most recently undone entry |
| `{ copy: "template" }` | copy the evaluated template to the clipboard |
| `{ open: "template" }` | open the evaluated target in the editor |

A `set` action writing SessionState needs a matching `state` **variable** to
read the value back into templates: `{ kind: "state", key: "<same key>",
default: "…" }`. (The one exception: never declare state for a `{{ menu }}` —
its state is synthesized, see below.) A `persist` action reads its current
value back through whatever variable already projects that `globals` field —
every persistable field has one, declared by the bundled default: `palette` →
`theme.effective`, and every other field → `<field>.effective` (`look`,
`style`, `charset`, `colorCompatibility`, `autoWrap`, `padding`). A `persist`
action over a field with no such variable (a hand-authored globals field with
no projection of its own) still writes correctly; it just has no "current
selection" highlight.

The canonical control-strip config — cycle chip, bounded stepper, copy/open
toolbar:

```json5 check:pass
{
  variables: {
    workMode: { kind: "state", key: "work-mode", default: "focus" },
    "hue.step": { kind: "state", key: "hue-step", default: "14" },
    project_dir: { kind: "input", path: "workspace.project_dir", default: "" },
  },
  actions: {
    cycleMode: { set: "work-mode", cycle: ["focus", "review", "debug"] },
    hueDown: { set: "hue-step", min: 0, max: 60, by: -2 },
    hueUp: { set: "hue-step", min: 0, max: 60, by: 2 },
    copySession: { copy: "{{ .session.id }}" },
    openProject: { open: "vscode://file/{{ urlEncode .project_dir }}" },
  },
  segments: {
    controls: {
      template: '{{ action "cycleMode" "🎯 focus" "🔍 review" "🐛 debug" }} ⬡ {{ action "hueDown" "◀" }} {{ .hue.step }}° {{ action "hueUp" "▶" }} {{ action "copySession" "⎘ id" }} {{ action "openProject" "↗ proj" }}',
      bg: "surface", fg: "foreground",
    },
  },
  root: { v: ["controls"] },
}
```

`{{ action "name" display [boundValue] }}` arity rules:

- Every kind needs at least one display (the clickable text).
- A **cycle** action takes either **one display per member** (positional — the
  current member's display renders, so the glyph names the current state and
  the click delivers its successor) or exactly one static display. Nothing else.
- Every other kind takes one display plus an optional bound value
  (`{{ action "applyTheme" . }}` inside a picker binds the option as the value).
- A bare `{{ action }}` on a `set … int` action must render a **numeric**
  display — the display *is* the integer written; a non-integer is rejected
  loudly at click time.

### Inline option domains — a picker with no registration

`from` names a domain (`"themes"`, `"styles"`, `"looks"`) OR **is** the domain:
an array of literal values needs no name and no registration. Use this for any
picker whose options are just a fixed authored list — `{{ menu }}` works
exactly the same over it:

```json5 check:pass
{
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    sortOrder: { kind: 'state', key: 'sort-order', default: 'asc' },
  },
  actions: {
    applySort: { set: 'sort-order', from: ['asc', 'desc'] },
  },
  segments: {
    sortControl: {
      template: '↕ {{ .sortOrder }} {{ menu "applySort" }}',
      bg: "surface", fg: "foreground",
    },
  },
  root: { v: ["sortControl"] },
}
```

### `persist` / `reset` — writing the config default, not a session pick

Every other `set` in this doc changes what the CURRENT session sees. `persist`
changes what EVERY session sees, from the next reload on — it writes into a
daemon-owned overrides layer merged on top of your config file (bundled
default < config file < persisted overrides < active preset < session pick,
in that order: a session's own `set` pick still wins over a persisted default
for that one session). The config file on disk is never touched — a `persist`
write is never something `cc-candybar check` or a `git diff` on your config
will show.

The `active preset` layer is a whole alternative arrangement: a named `root`
and/or display-`globals` fragment, declared in a top-level `presets:` block and
picked per session. It sits to the right of persisted overrides because the
chain is ordered by how late each layer is decided — everything left of the
preset is read once when the config loads and is shared by every session, while
the preset and the session pick are both resolved on every render. That is what
makes switching to a `compact` preset actually change the padding of a user who
once persisted a padding they liked, and what keeps their next click on padding
winning over the preset.

Reach for `persist` when the picked value should become the new normal, not
a one-off for this conversation — a theme you want every future session to
open in, not just this one. Pair it with `reset` so a persisted choice is
always undoable from the bar itself:

```json5 check:pass
{
  actions: {
    applyThemeForever: { persist: "palette", from: "themes" },
    forgetTheme: { reset: "palette" },
  },
  segments: {
    themeControls: {
      template: '{{ action "applyThemeForever" "nord" }} {{ action "forgetTheme" "↺" }}',
      bg: "surface", fg: "foreground",
    },
  },
  root: { v: ["themeControls"] },
}
```

`applyThemeForever` needs no matching `state` variable and no `session.id`
plumbing of its own — the loader still requires the global `session.id`
anchor the moment any `set`/`persist`/`reset` action exists (it rides the
click for error-surfacing, same as `set`), but reading `.session.id` back is
never required for `persist` the way `{ kind: "state" }` is for `set`.

### Persisting the display globals: charset, colorCompatibility, autoWrap, padding

These four `globals` fields have no SessionState half — no user ever picks
them per-session, only as a config default — so `persist` is their ONLY
seam, and `charsets`/`colorCompatibilities` are registered domains exactly
like `themes`/`styles`, sourced from the same enums the loader validates
`globals.charset`/`globals.colorCompatibility` against (no second list to
drift out of sync). `autoWrap` is boolean, so it persists as a two-member
`cycle`; `padding` is a bounded range, so it persists as a stepper pair —
neither needs a registered domain.

```json5 check:pass
{
  actions: {
    applyCharset: { persist: "charset", from: "charsets" },
    applyColorCompat: { persist: "colorCompatibility", from: "colorCompatibilities" },
    toggleWrap: { persist: "autoWrap", cycle: ["true", "false"] },
    paddingDown: { persist: "padding", min: 0, max: 16, by: -1 },
    paddingUp: { persist: "padding", min: 0, max: 16, by: 1 },
  },
  segments: {
    charsetControl: {
      template: '{{ .charset.effective }} {{ menu "applyCharset" }}',
      bg: "surface", fg: "foreground",
    },
    colorControl: {
      template: '{{ .colorCompatibility.effective }} {{ menu "applyColorCompat" }}',
      bg: "surface", fg: "foreground",
    },
    wrapToggle: {
      template: '{{ action "toggleWrap" "wrap: on" "wrap: off" }}',
      bg: "surface", fg: "foreground",
    },
    paddingControl: {
      template: '{{ action "paddingDown" "◀" }} padding {{ .padding.effective }} {{ action "paddingUp" "▶" }}',
      bg: "surface", fg: "foreground",
    },
  },
  root: { v: [
    { h: ["directory", "model"] },
    { h: ["charsetControl", "colorControl", "wrapToggle", "paddingControl"] },
  ] },
}
```

`{{ .charset.effective }}` / `{{ .colorCompatibility.effective }}` /
`{{ .padding.effective }}` are the bundled default's projections of the
resolved config value — the same seam `{{ .theme.effective }}` rides for
`palette` — so each trigger's label is always the value that actually
rendered, never a restated guess. A charset or padding change takes effect
on the very next render, live, with no daemon restart: `persist` writes the
overrides file, which rides the config file's own watcher.

### Picking a whole arrangement: `presets`

A preset changes several of those things at once. Declare it in the top-level
`presets:` block as a named fragment carrying a `root`, a `globals` delta, or
both, and pick it with the ordinary `set` seam over the `presets` domain — the
domain is your own block's names, plus `"default"`, the identity fragment that
means "this config's own `root` and `globals`, unchanged". `"default"` is
always selectable, whether or not you declare it, so a menu can always get back
to where it started.

The bundled default ships two ready-made presets on top of its own two-row
`"default"` arrangement, merged by name under anything you declare: `"compact"`
— one row (directory, git, context) at `padding: 0`, for narrow terminals and
split panes — and `"verbose"` — the default's own rows plus a third,
surfacing every segment the default declares but leaves opt-in (`gitPr`,
`burnrate`, `speed`, `tokenSparkline`). Both carry a standalone `▦` preset
picker in place of the default's full settings drawer, so switching to either
never strands a session without a way back. Try them without writing a config
at all — click `▦` beside the settings drawer — or pin one as your default
with `globals: { preset: "compact" }`.

```json5 check:pass
{
  variables: {
    'session.id': { kind: 'input', path: 'session_id', default: '' },
    activePreset: { kind: 'state', key: 'preset', default: 'default' },
  },
  actions: {
    applyPreset: { set: 'preset', from: 'presets' },
  },
  segments: {
    presetControl: {
      template: '▦ {{ .activePreset }} {{ menu "applyPreset" }}',
      bg: "surface", fg: "foreground",
    },
  },
  presets: {
    compact: { globals: { padding: 0 }, root: { v: ["presetControl"] } },
    roomy: { globals: { padding: 2 } },
  },
  root: { v: [
    { h: ["directory", "model"] },
    "presetControl",
  ] },
}
```

A fragment may carry `root` and `globals` and nothing else. The rule behind
that is lifetime: a preset carries what the bar *resolves* on every render,
never what the daemon *registers* once per process. `variables` and `actions`
are registered once — the timers, watchers and click gate they build are shared
by every session on that project — so a per-session pick cannot reach them, and
naming one in a preset is a load error. A preset's `globals` also may not carry
`preset`, which would make a second authority on which preset is active.

Each preset's `root` goes through the same layout validator the top-level
`root` does, so a stray segment name fails at load with the preset in the path
(`presets.compact.root`), not silently at click time.

### Pinning a preset as the default: `persist` / `reset`

A `set` pick over `presets` is a per-session preview, exactly like `set:
"palette"` — it changes what THIS session sees, from the next render, with no
daemon restart. Pin one as the config default the SAME way you would a
theme: `persist: "preset"` writes it into the overrides layer `set` never
touches; `reset: "preset"` clears it. Nothing about `preset` makes this a
special case — it is just another `Globals` field name to `persist`/`reset`,
the same zero-engine-edits seam `segments.<name>.palette` rides above.

```json5 check:pass
{
  actions: {
    pinPreset: { persist: "preset", from: "presets" },
    unpinPreset: { reset: "preset" },
  },
  segments: {
    pinControl: {
      template: '📌 {{ menu "pinPreset" }} {{ action "unpinPreset" "↺" }}',
      bg: "surface", fg: "foreground",
    },
  },
  presets: {
    compact: { globals: { padding: 0 } },
  },
  root: { v: ["pinControl"] },
}
```

`persist: "preset"` carries one risk no other persisted field does. The
overrides file `persist` writes to is ONE file shared by every project this
daemon serves, but `presets` is a per-config domain — the second one, after
`looks` — so the name a pin wrote for one project's config may not exist in
the config of the next project this daemon renders. That case is handled the
same way a stale session pick already is: the name collapses to `"default"`,
visibly, rather than failing the whole render. It is never a load error,
because the config that is loading it did not author it — only a preset name
you actually typed into `globals.preset` in your OWN config file gets the
load-time typo check, the same distinction `segments.<name>.palette` draws
between a name your config declares and one it doesn't.

### Editing a preset's layout: `removeSegment` / `insertSegment`

A preset's `root` is data you write once. `removeSegment` and `insertSegment`
are the click-driven seam for changing it: `persist` a *structural* edit
against `presets.<name>.rootOps` (a reserved suffix distinct from the preset's
own `root` field — see below) instead of naming a value source. Both are
fully literal — the segment name(s), and for `insertSegment` an `anchor` and a
`relation` of `"before"` or `"after"` — so each declared action is exactly one
legal request, gated the same one-value way a literal `persist … to` already
is.

```json5 check:pass
{
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    dropModel: { persist: "presets.compact.rootOps", removeSegment: "model" },
    addGitPr: { persist: "presets.compact.rootOps", insertSegment: "gitPr", anchor: "directory", relation: "after" },
  },
  segments: {
    editControl: {
      template: '{{ action "dropModel" "-model" }} {{ action "addGitPr" "+gitPr" }}',
      bg: "surface", fg: "foreground",
    },
  },
  presets: {
    compact: { root: { h: ["directory", "model"] } },
  },
  root: "editControl",
}
```

Position is addressed by the segment's own NAME, never by a sibling index — an
index would point at the wrong node the moment an earlier edit shifted the
tree under it. Clicks accumulate: each one appends one op to a log stored
alongside the preset (never touching the preset's own declared `root`, and
never your config file), and the daemon replays the whole log on top of the
declared root every time it resolves that preset — so a remove and an insert
from two separate clicks both land, in order, instead of the second clobbering
the first. `reset: "presets.compact.rootOps"` clears the whole log at once,
restoring the preset's declared root (a `set` twin doesn't exist either: a
structural edit is always a durable write, the same way `persist`'s other
arms already are). For undoing ONE op at a time instead of the whole log, see
`undo`/`redo` below — the same global history mechanism steps a layout edit
back exactly as it steps any other persisted write.

A stale op — one naming a segment a later config change removed — is silently
dropped when replayed, the same recovery `segments.<name>.palette` already
gets for the identical situation: nothing left to apply it to, and nothing
worth failing the whole render over.

### Picking which segment to insert: `insertSegmentFrom`

`insertSegment` is fully literal — the segment name is fixed at config-author
time. `insertSegmentFrom` is its domain-sourced sibling: the same tree op,
but the segment name is whatever the template's bound option resolves to at
render, exactly the `to`-vs-`from` split every other value source already
draws. `anchor`/`relation` stay literal (the POSITION is still author-time
data); only WHICH segment lands there is picked live — so a `{{ menu }}` can
drive a structural edit the same way it drives an ordinary `persist … from`:

```json5 check:pass
{
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    addAfterGit: { persist: "presets.compact.rootOps", insertSegmentFrom: ["gitPr", "model"], anchor: "git", relation: "after" },
  },
  segments: {
    editControl: {
      template: '+{{ menu "addAfterGit" }}',
      bg: "surface", fg: "foreground",
    },
  },
  presets: {
    compact: { root: { h: ["directory", "git"] } },
  },
  root: "editControl",
}
```

The domain works exactly like any other `from` — a registered name or an
inline array — so an option domain built specifically for this position (e.g.
"every segment not already in this preset's tree") registers or is authored
inline like any other; nothing about the target being a tree makes the domain
itself special. The gate mirrors `insertSegment`'s: the derived allow-list is
the encoded op token for every domain member, so a click naming a segment the
domain never listed decodes to nothing the gate admits.

### Undoing/redoing any persisted write: `undo` / `redo`

`reset` clears ONE named key outright — the coarse "forget this override"
case. `undo`/`redo` are its fine-grained siblings: they step ONE GLOBAL
history over every `persist`/`reset` write ever made to the overrides
layer — a theme pin, a padding nudge, a segment-palette override, a
`removeSegment`/`insertSegment` structural edit — back and forth, one entry
at a time, regardless of which key or which config declared the action that
made the write. Neither carries a key: there is nothing to name, since the
history itself decides which entry moves.

```json5 check:pass
{
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    pinDracula: { persist: 'palette', to: 'dracula' },
    back: { undo: true },
    fwd: { redo: true },
  },
  segments: {
    bar: {
      template: '{{ action "pinDracula" "🎨" }} {{ action "back" "◀" }} {{ action "fwd" "▶" }}',
      bg: "surface", fg: "foreground",
    },
  },
  root: "bar",
}
```

The history is **daemon-global, not per-session** — `config-overrides.json`
already has exactly one writer and no session-scoping (a `persist` write is
daemon-global by design), so `undo`/`redo` step that same file rather than
inventing a session axis it doesn't otherwise have. Two sessions can see each
other's undos; that is the deliberate consequence of one shared bar default,
not a bug.

Clicking `undo` with nothing to undo — or `redo` with nothing to redo — is a
loud, transient message in the bar (the same `click.error` channel any failed
click surfaces through), never a silent no-op. A fresh `persist`/`reset`
write after an `undo` abandons whatever was undone (the classic redo-stack
branch: `redo` truncates rather than staying reachable past a new edit). The
history is bounded — old entries fall off once a generous cap is exceeded —
so a long-running daemon's history file cannot grow without limit.

## Edit mode: `+`/`-` chrome for free

Composing the layout by hand-writing `removeSegment`/`insertSegmentFrom`
actions per position works, but doesn't scale to "every segment gets a `-`,
every gap gets a `+`" — that would mean authoring one action per segment per
preset. Edit mode does that authoring for you: reference the ONE reserved
action `edit.toggle` anywhere in your bar, and every preset's resolved layout
gets `-`/`+` chrome spliced in for free, gated behind the same on/off state
your trigger toggles.

```json5 check:pass
{
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  segments: {
    directory: { template: '~/project', bg: 'surface', fg: 'foreground' },
    git: { template: '⎇ main', bg: 'surface', fg: 'foreground' },
    editControl: { template: '{{ action "edit.toggle" "✎" }}', bg: 'surface', fg: 'foreground' },
  },
  root: { v: [ { h: ['directory', 'git'] }, 'editControl' ] },
}
```

**`edit.toggle` is the entire declaration.** Referencing it anywhere is what
opts a config in — the loader detects the reference (the same AST-based
detection `{{ menu }}` uses to find its own placements) and, only then,
synthesizes:

- `edit.mode` — a `state` variable, closed by default, and `edit.toggle`
  itself — a binary `cycle` action flipping it open/closed. Wire your own
  trigger to it, or copy `editControl` above verbatim.
- For **every** preset (the `"default"` floor included) and every ordinary
  segment in its resolved root: a `-` (a synthesized `removeSegment` action
  behind `{{ action }}`) immediately after it, and a `+` (a synthesized
  `insertSegmentFrom` action behind `{{ menu }}`, ranging every declared
  segment not already in that preset's tree) before and after each run —
  so N segments in a row read `+ [seg1 -] + [seg2 -] + … + [segN -] +`.
  Every affordance is gated `when: {{ eq .edit.mode "open" }}` — invisible
  until the toggle opens, present in the compiled tree either way.

**This is demand-driven, not automatic.** A config that never references
`edit.toggle` gets none of this — no toggle, no chrome, and critically no
new `session.id` requirement, so a fully static bar is untouched by the
feature's mere existence. Reference it once, anywhere, and the whole
mechanism switches on for every row in every preset.

**It's a splice, not a render branch.** Edit mode is not a special render
mode — `-`/`+` are ordinary `SegmentDecl`s with ordinary `removeSegment`/
`insertSegmentFrom` actions, spliced into the SAME tree shape `kind: "group"`
sugar already lowers into. Toggling `edit.mode` changes which `when`
predicates pass; it never changes what code runs. Padding, charset, and
strip style apply to chrome exactly as they apply to any segment you'd write
by hand.

**Clicks land in the SAME `presets.<name>.rootOps` op log** `removeSegment`/
`insertSegmentFrom` already write to — so `undo`/`redo` (above) cover an
edit-mode click for free, and a structural edit made through edit mode
survives a daemon restart exactly like a hand-authored one.

Segments already under a reserved namespace (`groups.`/`menus.`/`edit.`
itself) are excluded from both halves — removing a group's own toggle or a
menu's own host segment would strand its synthesized siblings, so edit mode
only ever touches ordinary content.

**The bundled default ships this on** (brandon-layout-edit-2gc.4): its
`toolbar` segment's template ends with `{{ action "edit.toggle" "✎ edit"
"✎ done" }}`, one more clickable glyph alongside the tray's existing
copy/open actions — not a new segment. Two things fall out of that choice,
worth knowing before you wire your own trigger:

- **Referencing `edit.toggle` reaches every merged config, not just the file
  that declares it.** `mergeWithDefault` merges `segments`/`actions`/
  `variables` by name, so once the bundled default's `toolbar` references
  the toggle, EVERY user config that doesn't override `toolbar` inherits the
  reference too — even one whose own `root` never mentions `toolbar` at all.
  "Anywhere" (above) really does mean anywhere in the merged config, not
  just your own file. The chrome this synthesizes stays inert for such a
  config (nothing in it can ever set `edit.mode` to `"open"`), but it is
  real, always-compiled tree structure — a test asserting a preset's exact
  segment list needs to filter out `edit.`-namespaced names, the same way a
  `kind: "group"`-using test already filters `groups.`-namespaced ones.
- **A trigger hosted on an ordinary segment is exactly as removable as that
  segment, once edit mode is open.** `toolbar`'s own `-` removes the WHOLE
  tray — the `edit.toggle` glyph included — same as removing any other
  segment. This is not a special edit-mode hazard: it is bounded and
  self-recoverable exactly like every other removal (the tray is still a
  declared segment, so any `+` elsewhere in the still-open chrome can insert
  it right back), and folding the trigger into an EXISTING multi-action
  segment — rather than giving it a dedicated one — means removing it takes
  a deliberate, legible click ("remove my whole quick-action tray") instead
  of a single easy-to-fat-finger glyph of its own.

### Knowing when a preset's layout has been edited: `.preset.customized`

Edit mode's `+`/`-` clicks land in `presets.<name>.rootOps` — an accumulated
op log, replayed onto the preset's declared `root` on every reload. That
means a preset's *rendered* layout can silently drift from the literal
`root:` you can see in your config file: nothing in the bar told you an
earlier click session left ops sitting there.

`.preset.customized` is that signal — a boolean input var, true exactly when
the ACTIVE preset (`.preset.effective`) currently has at least one op that
still DECODES (not merely a non-empty log: a token list that is entirely
malformed — hand-edited, or written by a previous protocol version —
replays as zero ops, and the signal agrees with that, never showing
"customized" over a tree that's actually byte-identical to the declared
root). It checks decode, not whether the op still resolves against your
CURRENT tree — a later hand-authored edit that removes a segment a stored
op still names turns that op into a no-op at replay (the same stale-op
skip a live restart already applies), and the signal doesn't chase that:
a rare, later-edit-triggered "customized" over a tree that hasn't actually
changed is the accepted cost of a cheap per-render check over a full tree
diff. Reference it in a `when` and pair it with `reset` over the SAME
`presets.<name>.rootOps` key `removeSegment`/`insertSegmentFrom` already
write to — clearing it drops the accumulated ops and restores the literal
declared root on the next reload, with no new gate to register (the key is
already writable the moment any structural-edit action targets it).

```json5 check:pass
{
  // `.preset.customized` reads the ACTIVE preset's op log
  // (`.preset.effective`) — pin "compact" as the default so it's the one
  // `dropModel`/`resetCompactLayout` (and this example's own narrative)
  // are actually about, exactly like `persist: "preset"` above pins one
  // for real.
  globals: { preset: "compact" },
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    dropModel: { persist: "presets.compact.rootOps", removeSegment: "model" },
    resetCompactLayout: { reset: "presets.compact.rootOps" },
  },
  segments: {
    directory: { template: '~/project', bg: 'surface', fg: 'foreground' },
    layoutStatus: {
      template: '{{ action "resetCompactLayout" "↺ layout customized" }}',
      when: '{{ .preset.customized }}',
      bg: "surface", fg: "foreground",
    },
  },
  presets: {
    compact: { globals: { padding: 0 } },
  },
  root: { v: ["directory", "layoutStatus"] },
}
```

**Edit mode synthesizes this for you too.** Referencing `edit.toggle`
(above) doesn't just splice `-`/`+` per gap — it also prepends this exact
banner, `when`-gated the same way, above every preset's chrome-spliced root,
targeting that preset's own `rootOps` key. You only need to author it
yourself in a config that edits `presets.<name>.rootOps` WITHOUT wiring edit
mode at all (the pattern above).

### Persisting a per-segment field: `segments.<name>.palette`

Every `persist`/`reset` target so far has named a `globals` field — the
whole-bar default. A segment's own `palette:` (overrides `globals.palette`
for that ONE segment, ignoring the session theme entirely — see the segment
config reference) is a *different* field shape, but the SAME mechanism
reaches it: spell the target `segments.<name>.palette` instead of a bare
`globals` field name, where `<name>` is a segment your config actually
declares.

```json5 check:pass
{
  actions: {
    applySidebarPalette: { persist: "segments.sidebar.palette", from: "themes" },
    resetSidebarPalette: { reset: "segments.sidebar.palette" },
  },
  segments: {
    sidebar: { template: "sidebar", bg: "surface", fg: "foreground" },
    sidebarPaletteControl: {
      template: '🎨 {{ menu "applySidebarPalette" }} {{ action "resetSidebarPalette" "↺" }}',
      bg: "surface", fg: "foreground",
    },
  },
  root: { v: [{ h: ["sidebar", "sidebarPaletteControl"] }] },
}
```

This is genuinely zero engine edits over the `globals`-field case — the
option-domain-as-data seam (`from: "themes"`), the derived write gate
(`deriveConfigActionValidators`), and the write path itself are all the
SAME code, unaware the key happens to name a segment rather than a
`globals` field. Only the key's own SHAPE differs, and only `<name>` is
config data: any segment you declare can get its own palette-persist
control this way. Two constraints are specific to this shape, both caught
at load time: `<name>` must be a segment your config declares (a typo or a
segment you haven't written yet is a load error naming the segments you
DO have), and the value source must be `to`/`from`/`cycle` — never a
bounded stepper (`min`/`max`/`by`), because a palette is a NAME, not a
number.

Like the four display-globals steppers above, a segment's `palette:` has no
SessionState half — `persist` is its only seam, so there is no session
`set` twin to pair it with.

### The bundled settings drawer

The bundled default (`DEFAULT_DSL_CONFIG`) ships every knob above already
wired into the bar, with zero authoring required: a `kind: "group"` named
`settings` sits on the identity row beside the quick-action tray, collapsed by
default (`⚙ settings ▸`, visually silent until clicked). Opening it drops a
row of eight controls immediately below: `themeControl`, `lookControl`,
`styleControl`, `charsetControl` / `colorCompatControl` /
`wrapToggleControl` / `paddingControl` (the four `persist` steppers from the
section above), and `directoryPaletteControl` (the `segments.directory.
palette` demo from the section above). The group's own synthesized toggle
lives under the reserved name `groups.settings` — see the `kind: "group"`
section below for what a group name reserves.

`themeControl` / `lookControl` / `styleControl` each carry TWO menus, one
per tier: the first (`applyTheme` / `applyLook` / `applyStyle`, session
`set`) is a per-conversation preview — try a theme without committing anyone
else to it. The second, behind the 📌 glyph (`applyThemeForever` /
`applyLookForever` / `applyStyleForever`, `persist`), pins the choice as the
config DEFAULT every session opens into from then on, paired with a `↺`
reset (`resetTheme` / `resetLook` / `resetStyle`) exactly like the four
`persist` steppers. The PERSIST tier shares one `{{ menu }}` accordion key
(`"pickersForever"`) across all three controls, so opening one closes the
others. The PREVIEW tier is narrower: `applyTheme` and `applyLook` share
`"pickers"` (pre-dating this pairing — see the two-menu accordion example
above), but `applyStyle`'s preview menu has no key at all — it's
independent, opens alongside either. Either way, opening a preview menu
never closes a persist menu or vice versa — they answer different questions
("what does THIS session look like" vs. "what should EVERY session default
to") and closing one to open the other would conflate them. Precedence is
unchanged either way: a session's own preview pick still wins over a
persisted default for that one session.

A user config's `root:` **replaces the bundled default's wholesale** (see the
top-level project docs), so removing the drawer — or reshaping it — is a
matter of authoring your own `root` without a `settings` group in it. This
reproduces the bundled default's two rows minus the drawer:

```json5 check:pass
{
  root: { v: [
    { h: ["directory", "gitaculous", "toolbar"] },
    { h: ["model", "context", "cacheTimer", "block", "weekly"] },
  ] },
}
```

The eight constituent segments (`themeControl` / `lookControl` /
`styleControl` / `charsetControl` / `colorCompatControl` / `wrapToggleControl`
/ `paddingControl` / `directoryPaletteControl`) and their backing actions
(`applyTheme` + `applyThemeForever` + `resetTheme`, `applyLook` +
`applyLookForever` + `resetLook`, `applyStyle` + `applyStyleForever` +
`resetStyle`, `applyCharsetForever` + `resetCharset`,
`applyColorCompatForever` + `resetColorCompat`, `toggleWrapForever` +
`resetAutoWrap`, `paddingDownForever` / `paddingUpForever` + `resetPadding`,
`applyDirectoryPaletteForever` + `resetDirectoryPalette`) stay declared in
the merged config either way — merge-by-name lets you keep the drawer but
swap one control's behavior (e.g. override `actions.applyCharsetForever` to
bind a different domain) without touching `root` at all.

## `{{ menu "applyAction" }}` — the picker disclosure

The apply-action name is the menu's **entire declaration**. The loader
synthesizes everything else under the reserved `menus.*` namespace: the
open/closed state, the ▸/▾ toggle glyph, the page cursor (state var + int
action), and the click gates. The body is a paged picker over the apply
action's option domain, dropped onto the line below the enclosing row while
open.

```json5 check:pass
{
  actions: {
    applyTheme: { set: "theme", from: "themes" },
  },
  segments: {
    themeControl: {
      template: '🎨 {{ .theme.effective }} {{ menu "applyTheme" }}',
      bg: "surface", fg: "foreground",
    },
  },
  root: { v: [
    { h: ["directory", "model"] },
    "themeControl",
  ] },
}
```

Rules that fall out of the synthesis:

- **Declare only the apply action.** No page action, no page state var, no
  open-state var, no when-gated picker row. If you find yourself declaring a
  variable named anything like `themePage`, you are hand-building the
  desugaring — delete it and let `{{ menu }}` synthesize.
- The trigger is **any template content you like** — the text around
  `{{ menu }}` is yours, dynamic values welcome (`{{ .theme.effective }}`
  above). The menu emits only its own ▸/▾ glyph. (Contrast: a group's `label`
  is a static string — see groups below.)
- A `{{ menu }}` lives **only in a segment's `template`** — not in `bg`/`fg`/
  `when`, not in a shared helper — and a menu-hosting segment is placed **once**
  in the layout.
- The apply name must be a **string literal**, and its options dict fully
  literal — identity is gated at load, before any render.

Rare knobs travel as **one trailing `(dict …)`** — note Go template syntax:
**space-separated, no commas**:

| option | type | default | meaning |
|---|---|---|---|
| `closeOnPick` | bool | `false` | picking an option also closes the menu (default: stay open to try options in a row) |
| `paged` | bool | `true` | paginate the body to the terminal width with ←/→ (a short domain shows one page, no arrows); `false` wraps instead |
| `key` | string | omitted | accordion grouping: menus sharing a key are mutually exclusive — opening one closes the others. Omitted = independent |

Two menus in an accordion (one open at a time), the style pick closing its
menu:

```json5 check:pass
{
  actions: {
    applyTheme: { set: "theme", from: "themes" },
    applyStyle: { set: "style", from: "styles" },
  },
  segments: {
    themeControl: {
      template: '🎨 {{ .theme.effective }} {{ menu "applyTheme" (dict "key" "pickers") }}',
      bg: "surface", fg: "foreground",
    },
    styleControl: {
      template: '✦ style {{ menu "applyStyle" (dict "key" "pickers" "closeOnPick" true) }}',
      bg: "surface", fg: "foreground",
    },
  },
  root: { v: [
    { h: ["directory", "model"] },
    { h: ["themeControl", "styleControl"] },
  ] },
}
```

## `looks`: named theme adaptations (the third option domain)

A **look** is a named color *transform* applied on top of whatever base theme
is active — not a palette. Because it is a transform, every look composes with
every theme: pick theme, then pick look. Declare looks in the top-level
`looks:` block; each axis mirrors a rich-js ThemeKey field verbatim, all
optional, absent = identity:

| axis | meaning |
|---|---|
| `hueShift` | degrees, additive rotation (error/success/warning stay hue-locked) |
| `chromaScale` | saturation multiplier — `0` grayscale, `1` identity, must be `>= 0` |
| `lightnessScale` | lightness multiplier — `1` identity, `-1` inverts |
| `lightnessShift` | lightness additive, applied after the scale |

Selection reuses the standard seam: one session key (`look`), one action with
`from: "looks"`, one `{{ menu }}`. `globals.look` sets the config default
(session pick wins); `.look.effective` is the daemon-resolved active name for
trigger labels. The bundled stdlib (`none`, `vivid`, `muted`, `dim`, `bright`,
`inverted`) merges under your names — `none` is the identity look and the
resolution floor. A per-segment `palette:` pin ignores the look, exactly as it
ignores the session theme.

```json5 check:pass
{
  looks: {
    vapor: { hueShift: 40, chromaScale: 1.2 },   // stdlib inherited beside it
  },
  actions: {
    applyLook: { set: "look", from: "looks" },
  },
  segments: {
    lookControl: {
      template: '◐ {{ .look.effective }} {{ menu "applyLook" }}',
      bg: "surface", fg: "foreground",
    },
  },
  root: { v: [
    { h: ["directory", "model"] },
    "lookControl",
  ] },
}
```

The block validates loudly: axis names outside the four, non-finite numbers,
and negative `chromaScale` are load errors, and `globals.look` must name a
declared look (checked after the merge, so naming a stdlib look is fine):

```json5 check:fail
{
  looks: {
    neon: { saturation: 2, chromaScale: -1 },
  },
}
```

```error
Unknown look key "saturation". Expected one of: hueShift, chromaScale, lightnessScale, lightnessShift
```

## `kind: "group"` — the layout disclosure

A group collapses an arbitrary layout subtree behind a synthesized ▸/▾ toggle
segment. Declared inline in `root`:

`{ kind: "group", name, label, children, open?, direction?, key?, bg?, fg?, when? }`

- `name` — an identifier (letters/digits/`_`, not starting with a digit, never
  `"closed"`); it names the synthesized `groups.*` artifacts.
- `label` — the toggle's display text. **Static string only** — it is spliced
  into a synthesized template at load. Dynamic labels are deliberately
  unsupported; if the trigger must be dynamic, use `{{ menu }}` (any-template
  trigger) or author the raw grammar yourself.
- `key` — same accordion semantics as the menu option: siblings sharing a key
  are mutually exclusive. **Nested** groups must use *distinct* keys (a closed
  parent hides its children; child open-state persists invisibly).
- `open: true` — initially open; at most one group per shared key.
- `direction` — how the body container stacks (`vertical` default).

The accordion drawer:

```json5 check:pass
{
  segments: {
    sessionDetails: { template: '🪪 {{ trunc 8 .session.id }}', bg: "surface", fg: "foreground" },
    links: { template: '{{ link "https://github.com/promptctl/cc-candybar" "↗ repo" }}', bg: "surface", fg: "foreground" },
  },
  root: { v: [
    { h: ["directory", "model"] },
    { h: [
      { kind: "group", name: "details", label: "session details", key: "drawer", children: ["sessionDetails"] },
      { kind: "group", name: "links", label: "links", key: "drawer", children: ["links"] },
    ] },
  ] },
}
```

The `groups.` and `menus.` namespaces are **reserved** in all three sections
(variables, actions, segments) — synthesis owns them unconditionally, whether
or not any group/menu exists in your config.

## Mistakes and the errors they produce

Each entry: the wrong config, then the exact text `cc-candybar check` prints.
These are asserted against the real loader by CI — trust them over any other
spelling you have seen.

### The removed `{{ menu }}` positional tail

Old configs (and old training data) spell
`{{ menu "applyTheme" "themePage" false true }}`. That surface is gone — the
page cursor is synthesized and the knobs are named:

```json5 check:fail
{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: '🎨 {{ menu "applyTheme" "themePage" false true }}' } },
  root: { v: ["trigger"] },
}
```

```error
has a {{ menu }} with more than two arguments — the positional tail ("pageAction" closeOnPick paged "key") was removed: the page cursor is now synthesized from the menu's identity, and rare knobs are named options in ONE trailing dict — write {{ menu "applyTheme" }} or {{ menu "applyTheme" (dict "closeOnPick" true "paged" false "key" "pickers") }} (defaults: closeOnPick false, paged true, no key)
```

### A mistyped or unknown menu option

Option names are case-sensitive; the error restates the full legal vocabulary
with defaults:

```json5 check:fail
{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: '{{ menu "applyTheme" (dict "closeonpick" true) }}' } },
  root: { v: ["trigger"] },
}
```

```error
unknown {{ menu }} option "closeonpick" — the options dict takes "closeOnPick" (bool, default false), "paged" (bool, default true), "key" (string, accordion grouping)
```

### Commas inside `(dict …)`

Go template arguments are space-separated. A JSON-style comma is a template
parse error:

```json5 check:fail
{
  actions: { applyStyle: { set: "style", from: "styles" } },
  segments: { trigger: { template: '{{ menu "applyStyle" (dict "key" "pickers", "closeOnPick" true) }}' } },
  root: { v: ["trigger"] },
}
```

```error
Template parse error in segments.trigger.template: expected `)`
```

### A dynamic value in the options dict

Menu identity is gated at load; every option value must be a literal:

```json5 check:fail
{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: '{{ menu "applyTheme" (dict "key" .group) }}' } },
  root: { v: ["trigger"] },
}
```

```error
whose options (dict …) is not fully literal — every option value must be a literal so the menu can be gated at load (a dynamic entry like (dict "key" .x) cannot)
```

### A `{{ menu }}` outside a segment template

A menu derives its identity from the segment it sits in, so it is valid only
in `template` — not `bg`/`fg`/`when`, and not in a shared helper:

```json5 check:fail
{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: "🎨", when: '{{ menu "applyTheme" }}' } },
  root: { v: ["trigger"] },
}
```

```error
uses {{ menu }} in its "when" — a menu is only valid in a segment's "template" (its placement is published only there; "when" needs a predicate). Move the {{ menu }} into the template.
```

```json5 check:fail
{
  helpers: { themeMenu: '{{ menu "applyTheme" }}' },
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: '{{ template "themeMenu" }}' } },
  root: { v: ["trigger"] },
}
```

```error
helper "themeMenu" uses {{ menu }}, but a menu must live directly in a segment template — its identity is derived from the segment it sits in, which a shared helper does not have. Inline the {{ menu }} call into each segment that needs it.
```

### A menu-hosting segment placed twice

```json5 check:fail
{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: '🎨 {{ menu "applyTheme" }}' } },
  root: { v: [ "trigger", { h: ["trigger"] } ] },
}
```

```error
hosts a {{ menu }} and is placed in the layout more than once — a menu's open-state is keyed by segment name, so the copies would share one state (clicking one would toggle both). Give each placement its own named segment.
```

### Squatting a reserved namespace

```json5 check:fail
{
  variables: { "menus.mine": { kind: "state", key: "x", default: "" } },
}
```

```error
"menus.mine" is in the reserved "menus." namespace (synthesized by {{ menu }} helpers) — rename it
```

### A typo'd action or variable name

Every `{{ action }}`/`{{ menu }}`/`{{ picker }}` reference and every dotted
variable read is resolved at load against the merged config:

```json5 check:fail
{
  segments: { trigger: { template: '{{ action "applyThmee" "🎨" }}' } },
  root: { v: ["trigger"] },
}
```

```error
template references unknown action "applyThmee"
```

```json5 check:fail
{
  segments: { trigger: { template: '{{ .curent_dir }}' } },
  root: { v: ["trigger"] },
}
```

```error
Template references unknown variable ".curent_dir"
```

### Two value sources on one `set`

```json5 check:fail
{
  actions: { broken: { set: "theme", to: "dracula", from: "themes" } },
}
```

```error
a set action declares exactly one value source: "to" (a literal value), "from" (an option domain — a registered domain name like "themes"/"styles"/"looks", or an inline array of literal values), "min"/"max"/"by" (a bounded step), "int" (an unbounded integer cursor), or "cycle" (an enumerated domain stepped in order) — found: to, from
```

### Wrong display count on a cycle action

Three members need three displays (one per member) or exactly one static
display. This one surfaces at the render stage — in the bar it would be a `⚠`
error cell you cannot see; `check` fails it for you:

```json5 check:fail
{
  actions: { cycleMode: { set: "work-mode", cycle: ["focus", "review", "debug"] } },
  segments: { chip: { template: '{{ action "cycleMode" "🎯 focus" "🔍 review" }}' } },
  root: { v: ["chip"] },
}
```

```error
segment "chip": action "cycleMode" cycles 3 members; bind one display per member (3) or one static display, got 2
```

### An unclosed template action

```json5 check:fail
{
  segments: { trigger: { template: '{{ action "x" ' } },
  root: { v: ["trigger"] },
}
```

```error
Template parse error in segments.trigger.template: unclosed action
```

### Nested groups sharing a key

Siblings share a key (accordion); an ancestor and descendant never do — one
key cannot hold two open names:

```json5 check:fail
{
  segments: { info: { template: "hi" } },
  root: { v: [
    { kind: "group", name: "outer", label: "outer", key: "drawer", children: [
      { kind: "group", name: "inner", label: "inner", key: "drawer", children: ["info"] },
    ] },
  ] },
}
```

```error
group "inner" shares key "drawer" with its ancestor group "outer" — a shared key holds ONE open group, so an ancestor and a descendant cannot share one. Sibling accordions share a key; nested groups use distinct keys.
```

### A `persist`/`reset` naming an undeclared segment

`segments.<name>.palette` must name a segment your config actually declares
— a typo (or a segment you haven't written yet) is a load error, not a
click-time surprise:

```json5 check:fail
{
  actions: { applyGhostPalette: { persist: "segments.ghost.palette", from: "themes" } },
  segments: { sidebar: { template: "sidebar" } },
}
```

```error
names segment "ghost" which is not declared
```

### A bounded stepper over a segment palette

A palette is a NAME, not a number — `min`/`max`/`by` has no meaning here;
use `to`, `from`, or `cycle` like every other palette-shaped target:

```json5 check:fail
{
  actions: { bumpSidebarPalette: { persist: "segments.sidebar.palette", min: 0, max: 5, by: 1 } },
  segments: { sidebar: { template: "sidebar" } },
}
```

```error
is a segment palette target and cannot use a bounded stepper (min/max/by) — use "to", "from", or "cycle" instead
```

### `removeSegment` naming an undeclared segment

Same load-time check as `segments.<name>.palette`, one seam over:

```json5 check:fail
{
  actions: { dropGhost: { persist: "presets.compact.rootOps", removeSegment: "ghost" } },
  segments: { sidebar: { template: "sidebar" } },
  presets: { compact: { root: "sidebar" } },
}
```

```error
removeSegment "ghost" is not a declared segment
```

### A value source other than `removeSegment`/`insertSegment`/`insertSegmentFrom` over a `rootOps` target

`presets.<name>.rootOps` addresses a tree, not a scalar — `to`/`from`/`cycle`/
a bounded stepper have no meaning as a tree op:

```json5 check:fail
{
  actions: { bumpLayout: { persist: "presets.compact.rootOps", min: 0, max: 1, by: 1 } },
  segments: { sidebar: { template: "sidebar" } },
  presets: { compact: { root: "sidebar" } },
}
```

```error
can only be paired with "removeSegment", "insertSegment", or "insertSegmentFrom"
```

## Before you report done

1. `cc-candybar check <path>` exits 0.
2. stderr shows no warnings you have not read and accepted.
3. You declared **no** `menus.*`/`groups.*` names, no page cursors, no
   open-state vars — if a menu needed backing state, you let it synthesize.
4. Anything you could not express with `{{ menu }}`, a group, or a named
   action: read examples/demo-actions.json5 for the raw mechanism before
   inventing a new shape.
5. If you added a `persist` action, you paired it with a `reset` (the
   drawer's convention — an undoable default is always undoable from the
   bar itself), and you verified it with an actual restart: render once,
   kill the daemon, start it fresh, render again with a brand-new
   `session.id`. `check` validates your config structurally (parse, merge,
   validate, render) but never simulates clicks, so it cannot catch a
   `persist` action that targets a valid but unintended Globals field (a
   typo'd field name IS caught at load time — this is about a real field,
   just the wrong one). Watch out for the session-pick trap specifically: if
   you're ALSO testing the matching `set` action in the same session, that
   session's own pick will keep winning over your persisted default (by
   design — see "persist / reset" above), which can look like the persist
   write silently failed when it didn't.
