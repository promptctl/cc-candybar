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
variables/segments/actions/looks/helpers/`root.rows` per-name; a whole tree at
`root` replaces every row).
Declare only what differs. The bundled default already declares `session.id`,
`theme.effective`, `look.effective`, `term.cols`, every built-in segment, and a
looks stdlib (`none`, `vivid`, `muted`, `dim`, `bright`, `inverted`) — never
re-declare them.

## The decision rule

One rule, applied once per interactive element:

- **Pick a value from an option domain** (theme, style, look) → `{{ menu "applyAction" "▸" "▾" }}`
  in a segment template. One call = a clickable trigger whose text you write +
  drop-below picker + all backing state, synthesized.
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
`reset` / `undo` / `redo` / `doctor` — or, for one control that writes *either* store,
`set` and `persist` together with a `persistWhen` selector. A `set`, a
`persist`, or a dual declares exactly one value source:

| declaration | click effect |
|---|---|
| `{ set: key, to: "value" }` | write the literal value to **SessionState** (per-session, until the session ends) |
| `{ set: key, from: "themes" \| "styles" \| "looks" \| "charsets" \| "colorCompatibilities" \| [...] }` | write the option the template binds (picker/menu domain) — a registered domain name, or an inline array of literal values needing no registration |
| `{ set: key, min: 0, max: 60, by: 2 }` | step the current value by `by`, wrapping in `[min, max]` |
| `{ set: key, int: true }` | write any integer the render binds (a page cursor) |
| `{ set: key, cycle: ["a", "b", "c"] }` | write the **successor** of the current value, wrapping; order members default-state-first |
| `{ persist: field, to \| from \| min/max/by \| cycle, … }` | the SAME four value sources as `set`, but writes `globals.<field>` into your **config file** (every session, survives daemon restart) instead of one session — see below. No `int` arm: a page cursor is never persisted. |
| `{ set: key, persist: field, persistWhen: selectorKey, to \| from \| min/max/by \| cycle, … }` | ONE control, TWO destinations: write the same value to SessionState or to the durable `globals` default, chosen at click time by the boolean value of `selectorKey` — see below |
| `{ reset: field }` | delete `globals.<field>` from your config file, so the bundled default shows through again |
| `{ set: key, persist: field, persistWhen: selectorKey, … }` (durable click) | releases the session key as part of the same write, so the committed default is visible to the session that committed it |
| `{ undo: true }` | step the config file's edit history (one stack per file) one entry back — restores whatever a PRIOR `persist`/`reset`/layout edit changed, any key, not just the one this action names (it names none) |
| `{ redo: true }` | re-apply the most recently undone entry |
| `{ copy: "template" }` | copy the evaluated template to the clipboard |
| `{ open: "template" }` | open the evaluated target in the editor |
| `{ doctor: "run" }` | run every doctor check over the facts the session's last render reported and write the report into SessionState (the settings menu's `🩺 doctor` button) |
| `{ doctor: "fix", check: "tmuxTruecolor" }` | re-probe that ONE check at click time and perform the fix its fresh verdict carries; refused loudly when there is nothing left to fix. `check` must name a bundled check — any other name is a load error |

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

Every example below authors `fg:` and no `bg:`. A segment with no `bg:` wears
a tint the theme derives from the segment's position in its row, so neighbours
differ without anyone choosing colours. An authored `bg:` is reserved for
meaning — a threshold's `error`, an alert's `warning` — and paints over the
tint.

The canonical control-strip config — cycle chip, bounded stepper, copy/open
toolbar:

```json5 check:pass
{
  variables: {
    workMode: { kind: "state", key: "work-mode", default: "focus" },
    detail: { kind: "state", key: "detail", default: "1" },
    project_dir: { kind: "input", path: "workspace.project_dir", default: "" },
  },
  actions: {
    cycleMode: { set: "work-mode", cycle: ["focus", "review", "debug"] },
    detailDown: { set: "detail", min: 0, max: 3, by: -1 },
    detailUp: { set: "detail", min: 0, max: 3, by: 1 },
    copySession: { copy: "{{ .session.id }}" },
    openProject: { open: "vscode://file/{{ urlEncode .project_dir }}" },
  },
  segments: {
    controls: {
      template: '{{ action "cycleMode" "🎯 focus" "🔍 review" "🐛 debug" }} ◧ {{ action "detailDown" "◀" }} {{ .detail }} {{ action "detailUp" "▶" }} {{ action "copySession" "⎘ id" }} {{ action "openProject" "↗ proj" }}',
      fg: "foreground",
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
      template: '↕ {{ .sortOrder }} {{ menu "applySort" "▸" "▾" }}',
      fg: "foreground",
    },
  },
  root: { v: ["sortControl"] },
}
```

### `persist` / `reset` — writing the config file, not a session pick

Every other `set` in this doc changes what the CURRENT session sees. `persist`
changes what EVERY session sees, from the next reload on — it writes the value
into your config file itself, in place. Exactly one value span changes; every
other byte of the file (comments, blank lines, key order, quote style, trailing
commas) is preserved. There is no second durable store: the precedence chain is
bundled default < config file < active preset < session pick < edit mode, so a
session's own `set` pick still wins over the file's default for that one
session. A `persist` click is a hand edit as far as the file can tell:
`git diff` on your config shows it, `cc-candybar check` validates it, and
nothing in the file records which of the two made it. No config file for any
software on the planet shows whether the application's settings menu updated
it or a human found it and hand-edited it, and this one is no different.

`reset` is the delete half: it removes the path `persist` writes
(`globals.<field>`), so the bundled default shows through again. A path your
file never authored is left alone — nothing is written and nothing enters the
edit history.

The file a click writes is the config file your session's config search
resolves to at the moment of the click — the same search the render runs
(an explicit path — a load-config pick, `--config`, or `$CC_CANDYBAR_CONFIG` —
else a project `.cc-candybar.json5`, else the cwd `.cc-candybar.json5`, else
the XDG `config.json5`), so it is the
file the next render reads. When no config file exists yet, the first `persist`
creates one — at the explicit path if one is set, else
`$XDG_CONFIG_HOME/cc-candybar/config.json5`. A click from a session that
has not rendered yet has no file to write and fails loudly (`has not rendered
yet — no config file to write`) rather than guessing.

The `active preset` layer is a whole alternative arrangement: a named `root`
and/or display-`globals` fragment, declared in a top-level `presets:` block and
picked per session. It sits to the right of the config file because the
chain is ordered by how late each layer is decided — everything left of the
preset is read once when the config loads and is shared by every session, while
the preset and the session pick are both resolved on every render. That is what
makes switching to a `compact` preset actually change the padding of a user who
once persisted a padding they liked, and what keeps their next click on padding
winning over the preset.

The same rule puts `edit mode` last: entering edit mode is decided later than
any pick, so its `editGlobals` fragment (see "Edit mode's own look" below)
outranks even a session pick — and only while the mode is on. Nothing is saved
when it turns on or restored when it turns off; the pick underneath was never
overwritten, only out-ranked.

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
      fg: "foreground",
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

### One control, two destinations: `persistWhen`

A setting with both halves — a session pick and a durable default — used to
cost two controls: `{{ menu "applyTheme" "▸" "▾" }}` for this session, and
`📌{{ menu "applyThemeForever" "▸" "▾" }}` for everyone's default. Two controls for one
setting is one too many to read and two declarations to keep in agreement.

A **dual** action collapses them. It names both destination keys, one shared
value source, and a `persistWhen` key whose boolean value decides where the
click lands:

```json5 check:pass
{
  variables: {
    persistDefault: { kind: "state", key: "persistDefault", default: "false" },
  },
  actions: {
    persistToggle: { set: "persistDefault", cycle: ["false", "true"] },
    applyTheme: {
      set: "theme",
      persist: "palette",
      persistWhen: "persistDefault",
      from: "themes",
    },
  },
  segments: {
    themeControl: {
      template: '{{ action "persistToggle" "☐ persist?" "☑ persist?" }} 🎨 {{ .theme.effective }} {{ menu "applyTheme" "▸" "▾" }}',
      fg: "foreground",
    },
  },
  root: { v: ["themeControl"] },
}
```

Read the picker's own click to see what changed: with `persistDefault` unset or
`"false"` it is a `set-state` write to the session key `theme`; with `"true"` it
is a `set-config` write to the `globals` field `palette`. Same segment, same
template, same options — the destination is a value the click carries, not a
second control.

A durable click carries one more thing: the session key to RELEASE, as a
trailing segment on the write itself, which the daemon drops only once its own
write succeeded. It has to. A session pick outranks a durable default
(that is the precedence chain above), so committing a value while the session
still holds its own pick would set a default the committing session could never
see — the bar would not move, and the control would keep writing the same value
forever. "Make this the default" means "and stop overriding it here", so the
commit drops the session override and the durable value shows through. It rides
the write rather than sitting beside it as its own effect, because a click runs
every effect it carries — a pair would let a rejected write still wipe your
pick. Nothing to declare: the pairing is what a dual action realizes.

The two keys differ here because the session key and the globals field have
always had different names (`theme` vs `palette`). Where they agree — `look`,
`style`, `preset`, `autoWrap`, `padding` — write the same name twice; a dual
always spells both, so no reader has to remember which settings are the
exception.

The gate does not widen. A dual derives exactly the two validators its two
halves would have derived separately: an allow-list over the same domain on the
session key, and one on the globals field. A dual is, precisely, the pair of
ordinary actions it replaces.

Three sources have no dual form. `int` is a page cursor with no meaning as a
durable default, and `removeSegment` / `insertSegment` / `insertSegmentFrom` are
structural edits that are durable by nature — none of them has a second
destination to choose between:

```json5 check:fail
{
  variables: {
    persistDefault: { kind: "state", key: "persistDefault", default: "false" },
  },
  actions: {
    page: {
      set: "themePage",
      persist: "padding",
      persistWhen: "persistDefault",
      int: true,
    },
  },
  segments: { d: { template: "d", fg: "foreground" } },
  root: { v: ["d"] },
}
```

```error
a dual action declares exactly one value source
```

All three keys travel together. Naming one destination and not the other is a
load error rather than a quietly single-destination action:

```json5 check:fail
{
  variables: {
    persistDefault: { kind: "state", key: "persistDefault", default: "false" },
  },
  actions: {
    applyTheme: {
      set: "theme",
      persistWhen: "persistDefault",
      from: "themes",
    },
  },
  segments: { d: { template: "d", fg: "foreground" } },
  root: { v: ["d"] },
}
```

```error
a dual-destination action declares set, persist, persistWhen together
```

The selector is an ordinary `set` key, so it is yours to shape: name it what
you like, give it whatever glyphs read best, and put it anywhere the controls it
governs are visible. Two rules earn their keep. Keep it **session-scoped and
off by default**, so you arrive able to experiment and committing to a durable
default is a deliberate act — and a checkbox armed in one session can never
write a default from another. And never place it above a control it cannot
affect: a checkbox that silently does nothing for half the rows beneath it is a
lie the panel tells.

### The display globals: charset, colorCompatibility, autoWrap, padding

`charset` and `colorCompatibility` have no SessionState half. That is a
decision, not a gap: they describe the **terminal** — whether its font carries
the powerline glyphs, and how many colours it can render — rather than a taste,
and neither varies session-to-session on one machine. A per-session override for
them would be a knob whose only honest setting is the one already in the config.
So `persist` is their ONLY seam, and `charsets`/`colorCompatibilities` are
registered domains exactly like `themes`/`styles`, sourced from the same enums
the loader validates `globals.charset`/`globals.colorCompatibility` against (no
second list to drift out of sync).

`updateNotice` is config-only in the same way, for a different reason. It is
the boolean (default `true`) behind the `⬆ Newer source: … [rebuild]
[dismiss] [disable]` row the daemon shows above the bar when the bundle
rendering it was built from source other than the `src/` beside it — an
identity check, so a checkout to an older commit trips it too — or, for a
published install, when the registry's latest release is newer than the
installed one. Its `[disable]` affordance IS
`{ persist: "updateNotice", to: "false" }` — the config file, durably. The
per-session spelling is not a `set:` on this key but the row's own
`[dismiss]`, which writes the session key `update.dismissed` with the
identity of the newer thing, so a dismissal lapses by itself the next time
something newer appears. There is no `updateNotices` domain and no
`.effective` projection to label a control with: the row itself is the
only display the field has.

`autoWrap` and `padding` DO have a session half, because how much bar fits on
your screen right now is a taste that legitimately differs between a wide
terminal and a split pane. Both spellings are available for them: `persist:`
writes the durable default every session sees, `set:` writes only the clicking
session's. `autoWrap` is boolean, so it takes a two-member `cycle`; `padding` is
a bounded range, so it takes a stepper pair — neither needs a registered domain.

They resolve like every other pickable global: **the session's own pick, over
the persisted default, over the config file's value, over the built-in floor.**
A session value outside the field's domain — a stale entry from when the range
or vocabulary was wider — is treated as no session value at all and falls
through to the default, rather than throwing or rendering something the label
disagrees with.

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
      template: '{{ .charset.effective }} {{ menu "applyCharset" "▸" "▾" }}',
      fg: "foreground",
    },
    colorControl: {
      template: '{{ .colorCompatibility.effective }} {{ menu "applyColorCompat" "▸" "▾" }}',
      fg: "foreground",
    },
    wrapToggle: {
      template: '{{ action "toggleWrap" "wrap: on" "wrap: off" }}',
      fg: "foreground",
    },
    paddingControl: {
      template: '{{ action "paddingDown" "◀" }} padding {{ .padding.effective }} {{ action "paddingUp" "▶" }}',
      fg: "foreground",
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
on the very next render, live, with no daemon restart: `persist` edits the
config file, and the daemon reloads it through the same watcher a hand edit
trips.

For `autoWrap` and `padding` you can offer the session-scoped version of the
same control by swapping `persist:` for `set:`. Nothing else changes — same
domains, same bounds, same `.effective` label — and the two can coexist, one
control for "just this terminal" beside one for "everywhere":

```json5 check:pass
{
  actions: {
    // This session only.
    wrapHere: { set: "autoWrap", cycle: ["true", "false"] },
    padHereDown: { set: "padding", min: 0, max: 16, by: -1 },
    padHereUp: { set: "padding", min: 0, max: 16, by: 1 },
    // Every session, durably.
    wrapEverywhere: { persist: "autoWrap", cycle: ["true", "false"] },
  },
  variables: {
    // The `set: "padding"` stepper seeds an unset key from THIS declaration's
    // integer default, so the first ◀/▶ click steps from 1 rather than from 0.
    sessionPadding: { kind: "state", key: "padding", default: "1" },
  },
  segments: {
    layoutControls: {
      template: '{{ action "padHereDown" "◀" }} padding {{ .padding.effective }} {{ action "padHereUp" "▶" }}  {{ action "wrapHere" "wrap: on" "wrap: off" }}  {{ action "wrapEverywhere" "pin wrap: on" "pin wrap: off" }}',
      fg: "foreground",
    },
  },
  root: { v: [{ h: ["directory", "layoutControls"] }] },
}
```

Both halves are wired into the template above, which is the point: `wrap: …`
changes only this terminal, `pin wrap: …` changes the default every session
gets. An action nobody renders is a declaration with no affordance — the loader
accepts it, and the bar shows nothing.

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
      template: '▦ {{ .activePreset }} {{ menu "applyPreset" "▸" "▾" }}',
      fg: "foreground",
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
theme: `persist: "preset"` writes `globals.preset` into your config file;
`reset: "preset"` deletes it again. Nothing about `preset` makes this a
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
      template: '📌 {{ menu "pinPreset" "▸" "▾" }} {{ action "unpinPreset" "↺" }}',
      fg: "foreground",
    },
  },
  presets: {
    compact: { globals: { padding: 0 } },
  },
  root: { v: ["pinControl"] },
}
```

The pin lands in the config file the session rendered, and `presets` is a
per-config domain — the second one, after `looks` — so the name a pin writes
is one that file's merged `presets` block already declares: the same domain
the `{{ menu }}` picked it from. From then on it is an ordinary
`globals.preset` line in your file. Delete or rename that preset by hand
later and the load-time typo check catches the line exactly as it would one
you typed yourself (`globals.preset "compact" does not match any declared
preset`), because the file does not remember which of you wrote it.

### Editing a preset's layout: `removeSegment` / `insertSegment`

A preset's `root` is data you write once. `removeSegment` and `insertSegment`
are the click-driven seam for changing it: `persist` a *structural* edit
against `presets.<name>.root` — the config-file path of the preset's own
`root` — instead of naming a value source. Both are fully literal — the
segment name(s), and for `insertSegment` an `anchor` and a `relation` of
`"before"` or `"after"` — so each declared action is exactly one legal
request, gated the same one-value way a literal `persist … to` already is.

```json5 check:pass
{
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    dropModel: { persist: "presets.compact.root", removeSegment: "model" },
    addGitPr: { persist: "presets.compact.root", insertSegment: "gitPr", anchor: "directory", relation: "after" },
  },
  segments: {
    editControl: {
      template: '{{ action "dropModel" "-model" }} {{ action "addGitPr" "+gitPr" }}',
      fg: "foreground",
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
tree under it. Each click rewrites the authored tree in your config file:
one segment reference is spliced into or out of the `root` the file declares,
in the same `{ h: [...] }` / bare-name grammar you write, with the comments
around it intact. Two clicks land in order because the second edits the tree
the first left behind. `reset: "presets.compact.root"` deletes the preset's
`root` from the file; a preset with no root of its own stages your config's
top-level `root`, so that is what `compact` renders after the reset. For a
preset that never declared a root, the key addresses that top-level `root`
itself: the reset deletes it, and a click edits the one row of it holding
the clicked segment. A `set` twin doesn't
exist either: a structural edit is always a durable write, the same way
`persist`'s other arms already are. For stepping ONE click back instead of
deleting the whole tree, see `undo`/`redo` below — the same history steps a
layout edit back exactly as it steps any other durable write.

The target need not be a preset you wrote. `presets.<name>.root` works
against the bundled `compact` and `verbose` too, with one thing to expect:
`presets` merge by name wholesale, so the first click on a preset your file
does not declare copies the whole bundled declaration — its `globals` and its
`root` — into your file, then applies the edit. A file declaring only
`presets.compact.root` would otherwise erase the bundled `compact`'s
`padding: 0`. A preset staging your config's own root is narrower: the first
click materializes only `root.rows.<row>` — the one bundled row holding the
clicked segment, in the grammar you write — and edits that row.

A click whose target or anchor the tree no longer holds — the bar rendered
before a later edit removed that segment — is a loud click error (`… holds
no segment "model" — the bar you clicked is stale; it reloads on the next
render`), never a silent drop. The file and the history are untouched, and
the next render rebuilds the chrome against the current tree.

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
    addAfterGit: { persist: "presets.compact.root", insertSegmentFrom: ["gitPr", "model"], anchor: "git", relation: "after" },
  },
  segments: {
    editControl: {
      template: '{{ menu "addAfterGit" "+" "✕" }}',
      fg: "foreground",
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

### Undoing/redoing any durable write: `undo` / `redo`

`reset` deletes ONE named path outright — the coarse "forget this setting"
case. `undo`/`redo` are its fine-grained siblings: they step the history of
every durable write ever made to your config file — a theme pin, a
padding nudge, a segment-palette pin, a `removeSegment`/`insertSegment`
structural edit, an edit-mode `+`/`-`, a `reset` — back and forth, one entry
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
      fg: "foreground",
    },
  },
  root: "bar",
}
```

Each history entry is a whole-file snapshot of one config file before and
after one edit, kept in `$XDG_STATE_HOME/cc-candybar/config-edit-history.json`,
fifty entries deep — the oldest fall off, so a long-running daemon's history
cannot grow without limit. `undo` writes the entry's `before` text back over
the file. A first-ever write's `before` is the absent file, so undoing it
removes the file rather than leaving an empty one the loader rejects.

`undo` restores that snapshot only while the file still reads exactly as the
entry's `after`. If you hand-edited the file since — or another daemon did —
the click refuses, loudly, with `undo: <file> has changed since that edit —
refusing to overwrite it`, and the entry stays where it is: overwriting would
destroy work the history never saw. `redo` makes the mirror check against the
entry's `before`. Your hand edit always stands; the way past the refusal is
to edit the file again yourself.

The history is **one stack per config file, not per session** — a durable
write lands in the file your session's config search resolves to, and `undo`/`redo`
step that file's stack. A daemon serving several projects keeps a stack for
each file, so an undo from one project can never revert a write made to
another's. Two sessions rendering the same file share its stack and can see
each other's undos; that is the deliberate consequence of one shared bar
default, not a bug.

Clicking `undo` with nothing to undo — or `redo` with nothing to redo — is a
loud, transient message in the bar (`undo: history is empty, nothing to undo`
/ `redo: nothing to redo`, on the same `click.error` channel any failed click
surfaces through), never a silent no-op. A fresh durable write after an
`undo` abandons whatever was undone (the classic redo-stack branch: `redo`
truncates rather than staying reachable past a new edit).

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
    directory: { template: '~/project', fg: 'foreground' },
    git: { template: '⎇ main', fg: 'foreground' },
    editControl: { template: '{{ action "edit.toggle" "✎" }}', fg: 'foreground' },
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
  Every affordance is gated on edit mode being open — the same disclosure
  predicate a group body or a `{{ menu }}` gates on, over the `edit.mode`
  key — so each is invisible until the toggle opens, and present in the
  compiled tree either way.

**This is demand-driven, not automatic — but the demand is usually already
there.** A config that never references `edit.toggle` gets none of this — no
toggle, no chrome, and critically no new `session.id` requirement, so a fully
static bar is untouched by the feature's mere existence. Reference it once,
anywhere, and the whole mechanism switches on for every row in every preset.

In practice you almost never make that reference yourself: the global settings
menu (below) puts an `✎ edit` entry in every bar it can, and that entry *is* a
reference to `edit.toggle`. So expect edit mode to be live in any config you
write. The gate still does its job at the one edge that matters — the menu is
not synthesized for a config declaring no `session.id`, which is exactly the
static, non-interactive bar the gate exists to leave alone.

**It's a splice, not a render branch.** Edit mode is not a special render
mode — `-`/`+` are ordinary `SegmentDecl`s with ordinary `removeSegment`/
`insertSegmentFrom` actions, spliced into the same container and segment
nodes every root lowers to — inside disclosure bodies too, so the cells of an
open group keep their `+`/`-`. Toggling `edit.mode` changes which `when`
predicates pass; it never changes what code runs. Padding, charset, and
strip style apply to chrome exactly as they apply to any segment you'd write
by hand.

### Edit mode's own look: `editGlobals`

Powerline joiners exist to make adjacent segments read as one continuous
strip — the opposite of what you want while deciding where one segment ends
and the next begins. So edit mode stages its own display globals: a top-level
`editGlobals` block, applied while the mode is on and only then.

The bundled default stages plain joiners with a visible separator:

```json5 check:pass
{
  editGlobals: { style: 'plain', default_separator: ' | ' },
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  segments: {
    directory: { template: '~/project', fg: 'foreground' },
    editControl: { template: '{{ action "edit.toggle" "✎" }}', fg: 'foreground' },
  },
  root: { h: ['directory', 'editControl'] },
}
```

It is an ordinary `globals` fragment, so any display field is fair game —
`padding`, `palette`, `look`, `autoWrap` — and it merges field by field with
the bundled one, so retuning the separator keeps `style: 'plain'`:

```json5 check:pass
{ editGlobals: { default_separator: ' :: ' } }
```

Two things it is not. It is **not** a preset: it carries no `root`, because
the layout half of edit mode is the `+`/`-` splice above. And it may not
select one — `editGlobals: { preset: 'compact' }` is a load error, for the
same reason a preset's own globals may not name a preset: which preset is
active keeps exactly one authority.

Leaving edit mode needs no undo. The fragment is applied at resolution time
while the mode is on; it is never written to session state or the config
file, so whatever governed before governs again the moment you toggle off.

**Clicks land in the SAME `presets.<name>.root` tree** `removeSegment`/
`insertSegmentFrom` already write to — the preset's `root` in your config
file — so `undo`/`redo` (above) cover an edit-mode click for free, and a
structural edit made through edit mode survives a daemon restart exactly like
a hand-authored one, because as far as the file can tell it is one.

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

Edit mode's `+`/`-` clicks rewrite `presets.<name>.root` in your config
file, and a bundled preset's first click copies its whole declaration in
there first (see "Editing a preset's layout" above). So a preset you never
wrote can come to have a `root` in your file, and the bar should be able to
say so.

`.preset.customized` is that signal — a boolean input var, true exactly when
your config FILE authors a root at the ACTIVE preset's root path
(`.preset.effective`): `presets.<name>.root` for a preset that declares one,
your config's top-level `root` for a preset that stages it. Hand-written or
click-written makes no difference, by design — the file does not record
which, so the signal cannot either. It reads the file, not a diff: a `root`
you typed yourself counts exactly as much as one a click left behind.
Reference it in a `when` and pair it with `reset` over the SAME
`presets.<name>.root` key `removeSegment`/`insertSegmentFrom` already write
to — the reset deletes that root from the file, so the bundled declaration
(or, for a preset staging the config root, the bundled two-row default)
shows through on the next reload, with no new gate to register (the key is
already writable the moment any structural-edit action targets it).

```json5 check:pass
{
  // `.preset.customized` reads whether the FILE authors the ACTIVE preset's
  // root (`.preset.effective`) — pin "compact" as the default so it's the
  // one `dropModel`/`resetCompactLayout` (and this example's own
  // narrative) are actually about, exactly like `persist: "preset"` above
  // pins one for real. `compact` declares its own root here, so the key
  // addresses `presets.compact.root` — a preset with no root of its own
  // would send both the clicks and the reset to this config's `root`.
  globals: { preset: "compact" },
  variables: { 'session.id': { kind: 'input', path: 'session_id', default: '' } },
  actions: {
    dropModel: { persist: "presets.compact.root", removeSegment: "model" },
    resetCompactLayout: { reset: "presets.compact.root" },
  },
  segments: {
    directory: { template: '~/project', fg: 'foreground' },
    model: { template: 'opus', fg: 'foreground' },
    layoutStatus: {
      template: '{{ action "resetCompactLayout" "↺ layout customized" }}',
      when: '{{ .preset.customized }}',
      fg: "foreground",
    },
  },
  presets: {
    compact: { root: { h: ["directory", "model"] }, globals: { padding: 0 } },
  },
  root: { v: ["directory", "model", "layoutStatus"] },
}
```

In this example the banner is on from the first render — the file authors
`presets.compact.root` — and `resetCompactLayout` deletes that root, leaving
`compact` to stage the config's own `root`. Because that top-level `root` is
authored too, the signal stays true, and a second reset would delete it.
That is the honest reading of "the file authors a root": a config that
writes its own `root` is customized relative to the bundled default, whether
a click or a keyboard did it.

**Edit mode synthesizes this for you too.** Referencing `edit.toggle`
(above) doesn't just splice `-`/`+` per gap — it also prepends this exact
banner above every preset's chrome-spliced root, targeting that preset's own
`presets.<name>.root` key. The synthesized banner is edit chrome like `-`/`+`,
so it is gated on edit mode being open AND `.preset.customized` — a config
that authors its own `root` is "customized" from its first render, and a
permanent one-click deletion of that root outside edit mode is not a status
row. Author the banner yourself when you want it visible regardless of edit
mode, or in a config that edits `presets.<name>.root` WITHOUT wiring edit
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
    sidebar: { template: "sidebar", fg: "foreground" },
    sidebarPaletteControl: {
      template: '🎨 {{ menu "applySidebarPalette" "▸" "▾" }} {{ action "resetSidebarPalette" "↺" }}',
      fg: "foreground",
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

"A segment your config declares" includes the bundled ones — `directory`,
`git`, `model`, and the rest merge into every config by name — so
`segments.model.palette` is a legal target in a file that never mentions
`model`. What that first write does to the file is worth knowing before you
see the diff: `segments` merge by name wholesale, so a file declaring only
`segments: { model: { palette: "nord" } }` would replace the whole bundled
`model` segment with one that has no template. The write therefore copies
the entire bundled `model` declaration into your file first, then sets its
`palette`. A segment your file already declares gets only the one `palette`
line inserted or replaced. Per-field merge is a follow-up ticket; until then
expect the first pin on a bundled segment to add a full declaration you can
trim by hand, and `reset` to remove only the `palette` line from it.

Like `charset` and `colorCompatibility` above, a segment's `palette:` has no
SessionState half — `persist` is its only seam, so there is no session
`set` twin to pair it with. (`autoWrap` and `padding` are the two display
globals that *do* have one.)

### The global settings menu: `settings.menu`

One disclosure is present in **every** bar, whatever the config says: the
global settings menu, rendered as `☰ ▸`.

Opening it shows the always-available functionality:

```
☰ ▾
  ☐ persist?  (?)   ▦ default ▸ ↺   ⚙ config ▾   🧰 tools ▸   ✎ edit
     🎨 tokyo-night ▸ ↺   ◐ none ▸ ↺   ✦ powerline ▸ ↺   wrap: on ↺   ◀ padding 1 ▶ ↺
```

- **`persist?`** chooses where every setting in the menu is written: unchecked
  (the state you arrive in) the click changes this session only; checked, it
  writes the durable default every session opens with. It is the `persistWhen`
  selector from the section above, and it is session-scoped — arming it here
  cannot write a default from another session.
- **The preset switcher** and **`✎ edit`** are one click from the toggle,
  because switching arrangement and entering edit mode are what you most often
  open this menu to do.
- **`⚙ config`** opens the display settings: theme, look, style, wrap and
  padding, each ONE control that follows the checkbox, each with a `↺` that
  forgets its durable default. `charset` and `colorCompatibility` are
  deliberately absent — they describe your terminal rather than a taste that
  varies session to session, so they have no session half to choose between and
  stay config-file settings.
- **`🧰 tools`** opens the `🩺 doctor`: click it and one row per check drops
  under it, `✓ tmux truecolor` or `✗ tmux truecolor — <reason> [fix]`. A check
  probes your setup for a fault outside cc-candybar that makes the bar look
  broken; `[fix]` repairs it in place (the first check writes
  `CLAUDE_CODE_TMUX_TRUECOLOR=1` into the `env` of `~/.claude/settings.json`,
  which takes effect for Claude Code sessions started afterwards, and the row
  says so). The checks reason over the facts the statusline client reported on
  the session's last render — not the daemon's own environment — and
  `cc-candybar doctor` runs the same checks from a shell, with the exit code as
  the verdict.

Every picker in the menu shares one accordion key, so opening the look picker
closes the theme picker: the panel is narrow, and two open drop-downs would
overflow it.

You do not declare it and you cannot delete it. What you *can* do is choose
where it goes, by placing the reserved segment name `settings.menu` in your
layout — the anchor. Place it and the menu renders there; leave it out and the
menu is appended to the bar's first row. Nothing else differs between the two:
the same toggle, the same body, the same clicks.

```json5 check:pass
{
  root: { v: [
    { h: ["directory", "gitaculous"] },
    { h: ["settings.menu", "model", "context"] },
  ] },
}
```

The anchor may appear **at most once** per layout. It names one disclosure
backed by one state key, and one key holds one open state, so a second
placement would be two toggles fighting over it:

```json5 check:fail
{
  root: { v: [
    { h: ["directory", "settings.menu"] },
    { h: ["model", "settings.menu"] },
  ] },
}
```

```error
it may appear at most once per layout
```

A `when` on one of your rows never reaches the menu. If the row the default
placement would land in is gated, the menu takes its own ungated row instead —
otherwise an ordinary conditional row (a git row you only want inside a repo)
would take the undeletable door down with it whenever the condition is false.
Two gates *are* honored, because both are things you said on purpose: a `when`
on the `root` itself (there is no bar at all under that condition, so there is
nothing to put a menu on), and a gate on a row where you placed the anchor
yourself.

**The one config that gets no menu** is one that declares no `session.id`
variable. Every click composes a URL whose first segment is the session id read
from the store, so a config without it describes a static, non-interactive bar
and there is no menu to put on one. Any config merged over the bundled default
— which is every config the daemon loads — inherits `session.id`, so this
excludes hand-built static configs and nothing else. Placing the `settings.menu`
anchor in such a config is a load error naming the missing variable, not a
silently absent menu.

Everything the menu synthesizes lives under the reserved `settings.` namespace
— a variable, action, or segment of your own under that prefix is a load error,
the same contract `groups.` / `menus.` / `edit.` carry (see "Squatting a
reserved namespace" below). Edit mode also treats those names as structural: no
`-` affordance is offered beside the menu, so the way back into edit mode cannot
be edited away.

### The bundled settings drawer

The bundled default (`DEFAULT_DSL_CONFIG`) ships one more group beside the
global menu: a `kind: "group"` named `settings`, sitting on the identity row
next to the quick-action tray, collapsed by default (`⚙ terminal ▸`, visually
silent until clicked). It holds the three controls the settings menu does not:
`charsetControl` and `colorCompatControl` (terminal capability facts, with no
session half to offer a choice over) and `directoryPaletteControl` (the
`segments.directory.palette` demo from the section above — a per-segment pin,
not a whole-bar default). The group's own synthesized toggle lives under the
reserved name `groups.settings` — see the `kind: "group"` section below for
what a group name reserves.

Everything with BOTH halves — theme, look, style, preset, wrap, padding — lives
in the global settings menu instead, as one dual control each. That is the
difference between the two surfaces: the menu is where a setting you can try
per-session lives, and it cannot be deleted; the drawer is ordinary authored
layout holding the durable-only knobs, and a row you author by name replaces
it like any other segment.

Removing the drawer is replacing the `identity` row by name; the global
settings menu above is present either way:

```json5 check:pass
{
  root: { rows: { identity: { h: ["directory", "gitaculous", "toolbar"] } } },
}
```

The three constituent segments (`charsetControl` / `colorCompatControl` /
`directoryPaletteControl`) and their backing actions (`applyCharsetForever` +
`resetCharset`, `applyColorCompatForever` + `resetColorCompat`,
`applyDirectoryPaletteForever` + `resetDirectoryPalette`) stay declared in the
merged config either way — merge-by-name lets you keep the drawer but swap one
control's behavior (e.g. override `actions.applyCharsetForever` to bind a
different domain) without touching `root` at all.

## `{{ menu "applyAction" "▸" "▾" }}` — the picker disclosure

The apply-action name is the menu's **entire declaration**. The loader
synthesizes everything else under the reserved `menus.*` namespace: the
open/closed state, the page cursor (state var + int action), and the click
gates. The trigger's *text* is the one thing it does not synthesize — you bind
that, below. The body is a paged picker over the apply
action's option domain, dropped onto the line below the enclosing row while
open.

```json5 check:pass
{
  actions: {
    applyTheme: { set: "theme", from: "themes" },
  },
  segments: {
    themeControl: {
      template: '🎨 {{ .theme.effective }} {{ menu "applyTheme" "▸" "▾" }}',
      fg: "foreground",
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
- **The trigger text is yours, all of it.** A menu emits nothing you did not
  write: bind one display per state (`"▸" "▾"` — a disclosure is a two-state
  cycle, so this is the same binding a cycle `{{ action }}` takes) or one static
  display used in both (`"+"`). The text *around* the call is yours too, dynamic
  values welcome (`{{ .theme.effective }}` above). Bind no display and it is a
  load error, never a glyph you never chose. (Contrast: a group's `label` is a
  static string, and its ▸/▾ is spliced into the toggle the loader synthesizes —
  see groups below.)
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
| `distribution` | string | `"van-der-corput"` | how the dropped band places its options' tints — one of the five names in the `distribution` section below. The same field a `{ h }`/`{ v }` row carries; a menu is a placer too |

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
      template: '🎨 {{ .theme.effective }} {{ menu "applyTheme" "▸" "▾" (dict "key" "pickers") }}',
      fg: "foreground",
    },
    styleControl: {
      template: '✦ style {{ menu "applyStyle" "▸" "▾" (dict "key" "pickers" "closeOnPick" true) }}',
      fg: "foreground",
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
      template: '◐ {{ .look.effective }} {{ menu "applyLook" "▸" "▾" }}',
      fg: "foreground",
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

`{ kind: "group", name, label, children, open?, direction?, key?, bg?, fg?, when?, distribution? }`

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
- `distribution` — how the body container places its children's tints; it is
  the body's field, not the toggle's (the same field a `{ h }`/`{ v }` row
  carries — see `distribution` below).

The accordion drawer:

```json5 check:pass
{
  segments: {
    sessionDetails: { template: '🪪 {{ trunc 8 .session.id }}', fg: "foreground" },
    links: { template: '{{ link "https://github.com/promptctl/cc-candybar" "↗ repo" }}', fg: "foreground" },
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

## `distribution` — how a placer spreads its cells' tints

A segment with no `bg:` wears a tint selected from the theme's vocabulary by
its position among its siblings (the convention stated above every example).
`distribution` is the one field that says *how* a placer spreads those
positions across the vocabulary. There are two kinds of placer and one field:

- a **container** — `{ h: [...], distribution: "…" }`, `{ v: [...] }`,
  `{ kind: "container", … }`, or a `{ kind: "group", … }`, where it places the
  group's **body** (the container its children sit in). The top-level `root`
  is one: as a whole tree, `root: { v: [...], distribution: "…" }` places its
  rows; as a `{ rows: { … }, distribution: "…" }` fragment it carries the
  field per field like `when` — absent, the base root's placement stays;
  alone over `rows: {}`, it re-places the rows a preset inherits;
- a **`{{ menu }}`** — `(dict "distribution" "…")` in its options dict, placing
  the options of the band it drops.

Omit it and the placer uses `van-der-corput`. It is per instance: a row with
`monotonic` recolours only its own cells; every other row and every menu keeps
its own placement.

| name | reads the sibling count? | what you get |
|---|---|---|
| `van-der-corput` (default) | no | bit-reversal sequence 0, ½, ¼, ¾, ⅛, … — neighbours land far apart |
| `golden-angle` | no | index × φ mod 1 — the same isolation, a different spread |
| `uniform` | no | every child at ½ — one tint for the whole row |
| `monotonic` | yes | an evenly spaced ramp in declaration order |
| `ends-interleaved` | yes | evenly spaced, alternating from both ends inward |

Isolation is a property of the distribution you chose, not of the system.
A count-free distribution gives it for free: declaring another child or
deleting one recolours nobody. `monotonic` and `ends-interleaved` read the
count, so declaring one more child re-spaces its siblings — you spend that
isolation to buy an ordered ramp. That is a fair trade wherever the set is
closed, and a menu's option domain is exactly that: the count *is* the set,
nothing is ever added behind its back. A `when`-hidden child still counts under
every distribution (every child is walked), so a predicate flipping re-spaces
nothing.

The field on both placers — a row keeping isolation under a different spread,
a menu ramping its closed domain:

```json5 check:pass
{
  actions: {
    applyTheme: { set: "theme", from: "themes" },
  },
  segments: {
    themeControl: {
      template: '🎨 {{ .theme.effective }} {{ menu "applyTheme" "▸" "▾" (dict "distribution" "monotonic") }}',
      fg: "foreground",
    },
  },
  root: { v: [
    { h: ["directory", "model"] },
    { h: ["context", "cacheTimer", "block", "weekly"], distribution: "golden-angle" },
    "themeControl",
  ] },
}
```

An unknown name is a load error listing the five (see "An unknown distribution
name" below).

## `(?)` — instructions where they are needed

The bar ships two `(?)` affordances, and neither needs anything in your config:

- **In edit mode**, trailing the bar's last row — what `+`, `-` and the
  `↺ … customized` banner do when clicked. Where that row is itself gated by
  another disclosure it takes a line of its own instead, so the `(?)` can
  never end up hidden behind something you have to open first.
- **In the config menu**, beside `persist?` — where the next click lands.

Both are ordinary disclosures. `(?)` closed, `✕` open, one session-scoped state
key each, and a body that is a row of plain text cells. There is no help widget
and no tooltip type: a `(?)` differs from the group above only in the text its
trigger binds and in what its body contains.

The sentences themselves live in `src/help-text.ts`, the same corpus `--help`
prints, so the bar and the CLI cannot drift into two wordings of one fact.

To write your own, use a group whose label is the glyph and whose body is a
segment of text — nothing here is privileged. Note what the sugar gives you:
a group appends the disclosure glyph to its label in both states, so `label:
"(?)"` renders `(?) ▸` closed and `(?) ▾` open. The `(?)`/`✕` swap the two
bundled ones use binds two unrelated strings per state, which is raw-grammar
territory — a `state` variable, a `cycle` action and your own
`{{ action "…" "(?)" "✕" }}`, exactly as the group section above directs for
any custom trigger. A group's body also defaults to `direction: "vertical"`,
so more than one help line stacks; say `direction: "horizontal"` to get the
row of text cells the bundled ones render.

```json5 check:pass
{
  segments: {
    deploy: { template: '🚀 staging', fg: "foreground" },
    deployHelp: { template: 'green = deployed, amber = building', fg: "foreground" },
  },
  root: { v: [
    { h: ["directory", "deploy", { kind: "group", name: "deployHelp", label: "(?)", children: ["deployHelp"] }] },
  ] },
}
```

Keep help short. A body cell is a cell like any other, so a long sentence
wraps and costs extra rows at narrow widths. One complete thought per cell,
each leading with the glyph it explains, is what the bundled help does. Place
the group wherever it reads best, usually right after the segment it explains:
a cell's colour is fixed by its own position in its row, so adding a `(?)`
recolours nothing outside the row it joins.

## Mistakes and the errors they produce

Each entry: the wrong config, then the exact text `cc-candybar check` prints.
These are asserted against the real loader by CI — trust them over any other
spelling you have seen.

### A `{{ menu }}` with no trigger text

A menu's trigger is authored, exactly like a cycle action's display: the
renderer appends no ▸/▾ of its own. `{{ menu "applyTheme" }}` — correct in
older releases, and the spelling old training data reaches for — names no
trigger at all, so it is a load error rather than a glyph you never wrote.
(The far older positional tail, `{{ menu "applyTheme" "themePage" false true }}`,
fails here too: three displays where a two-state disclosure takes one or two.)

```json5 check:fail
{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: '🎨 {{ menu "applyTheme" }}' } },
  root: { v: ["trigger"] },
}
```

```error
has a {{ menu }} whose trigger needs a display (the clickable text) — a menu binds its trigger text the way a cycle action binds a display — write {{ menu "applyTheme" "▸" "▾" }} (one per state) or {{ menu "insertHere" "+" }} (one static display for both), with the rare knobs in ONE trailing dict: {{ menu "applyTheme" "▸" "▾" (dict "closeOnPick" true "paged" false "key" "pickers") }} (defaults: closeOnPick false, paged true, no key). The renderer no longer appends ▸/▾ of its own (candybar-settings-ui-aok.4), and the older positional tail ("pageAction" closeOnPick paged "key") was removed — the page cursor is synthesized from the menu's identity.
```

### A mistyped or unknown menu option

Option names are case-sensitive; the error restates the full legal vocabulary
with defaults:

```json5 check:fail
{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: '{{ menu "applyTheme" "▸" "▾" (dict "closeonpick" true) }}' } },
  root: { v: ["trigger"] },
}
```

```error
unknown {{ menu }} option "closeonpick" — the options dict takes "closeOnPick" (bool, default false), "paged" (bool, default true), "key" (string, accordion grouping), "distribution" (one of "van-der-corput", "golden-angle", "ends-interleaved", "monotonic", "uniform"; default "van-der-corput")
```

### An unknown distribution name

The field validates against the five names; the error lists them in the order
it always lists them. A `{{ menu }}`'s `(dict "distribution" "spiral")` fails
with the same list, prefixed `{{ menu }} option "distribution"`:

```json5 check:fail
{
  root: { v: [
    { h: ["directory", "model"], distribution: "spiral" },
  ] },
}
```

```error
root.v[0].distribution must be one of: van-der-corput, golden-angle, ends-interleaved, monotonic, uniform; got "spiral"
```

### Commas inside `(dict …)`

Go template arguments are space-separated. A JSON-style comma is a template
parse error:

```json5 check:fail
{
  actions: { applyStyle: { set: "style", from: "styles" } },
  segments: { trigger: { template: '{{ menu "applyStyle" "▸" "▾" (dict "key" "pickers", "closeOnPick" true) }}' } },
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
  segments: { trigger: { template: '{{ menu "applyTheme" "▸" "▾" (dict "key" .group) }}' } },
  root: { v: ["trigger"] },
}
```

```error
whose options (dict …) is not fully literal — every option value must be a literal so the menu can be gated at load (a dynamic entry like (dict "key" .x) cannot)
```

### A dynamic LAST argument, where the options dict would also fit

Trigger displays may be dynamic — identity does not depend on them. But the
options dict is the *last* argument, so a non-literal in that slot is a shape
the renderer would classify by whatever it evaluates to, and it could land on a
different reading than the loader's. Where both readings are legal the call is
rejected rather than resolved by a guess:

```json5 check:fail
{
  variables: { glyph: { kind: "literal", value: "▾" } },
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: '{{ menu "applyTheme" "▸" .glyph }}' } },
  root: { v: ["trigger"] },
}
```

```error
whose last argument is neither a literal nor a literal (dict …)
```

Spell the options out to disambiguate — an empty `(dict)` is enough, and both
displays may then be dynamic:

```json5 check:pass
{
  variables: { open: { kind: "literal", value: "▾" }, shut: { kind: "literal", value: "▸" } },
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: '{{ menu "applyTheme" .shut .open (dict) }}' } },
  root: { v: ["trigger"] },
}
```

### A `{{ menu }}` outside a segment template

A menu derives its identity from the segment it sits in, so it is valid only
in `template` — not `bg`/`fg`/`when`, and not in a shared helper:

```json5 check:fail
{
  actions: { applyTheme: { set: "theme", from: "themes" } },
  segments: { trigger: { template: "🎨", when: '{{ menu "applyTheme" "▸" "▾" }}' } },
  root: { v: ["trigger"] },
}
```

```error
uses {{ menu }} in its "when" — a menu is only valid in a segment's "template" (its placement is published only there; "when" needs a predicate). Move the {{ menu }} into the template.
```

```json5 check:fail
{
  helpers: { themeMenu: '{{ menu "applyTheme" "▸" "▾" }}' },
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
  segments: { trigger: { template: '🎨 {{ menu "applyTheme" "▸" "▾" }}' } },
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

### An `editGlobals` fragment selecting a preset

Which preset is active has exactly one authority. A globals fragment naming
one — a preset's own `globals`, or edit mode's `editGlobals` — would be a
second:

```json5 check:fail
{
  editGlobals: { preset: "compact" },
}
```

```error
the editGlobals fragment cannot select a preset
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
  actions: { dropGhost: { persist: "presets.compact.root", removeSegment: "ghost" } },
  segments: { sidebar: { template: "sidebar" } },
  presets: { compact: { root: "sidebar" } },
}
```

```error
removeSegment "ghost" is not a declared segment
```

### A value source other than `removeSegment`/`insertSegment`/`insertSegmentFrom` over a preset-root target

`presets.<name>.root` addresses a tree, not a scalar — `to`/`from`/`cycle`/
a bounded stepper have no meaning as a tree op:

```json5 check:fail
{
  actions: { bumpLayout: { persist: "presets.compact.root", min: 0, max: 1, by: 1 } },
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
   bar itself), and you verified it by clicking it and reading the diff:
   `git diff` (or a before/after copy) of the config file the session
   rendered shows exactly one value changed and nothing else touched, and
   the next render reflects it. `check` validates your config structurally
   (parse, merge, validate, render) but never simulates clicks, so it
   cannot catch a `persist` action that targets a valid but unintended
   Globals field (a typo'd field name IS caught at load time — this is
   about a real field, just the wrong one). Watch out for the session-pick
   trap specifically: if you're ALSO testing the matching `set` action in
   the same session, that session's own pick will keep winning over the
   file's default (by design — see "persist / reset" above), which can look
   like the persist write silently failed when the diff says it didn't.
