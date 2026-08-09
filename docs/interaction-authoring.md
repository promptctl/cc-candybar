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

An action declares exactly one of `set` / `copy` / `open`; a `set` declares
exactly one value source:

| declaration | click effect |
|---|---|
| `{ set: key, to: "value" }` | write the literal value |
| `{ set: key, from: "themes" \| "styles" \| "looks" \| [...] }` | write the option the template binds (picker/menu domain) — a registered domain name, or an inline array of literal values needing no registration |
| `{ set: key, min: 0, max: 60, by: 2 }` | step the current value by `by`, wrapping in `[min, max]` |
| `{ set: key, int: true }` | write any integer the render binds (a page cursor) |
| `{ set: key, cycle: ["a", "b", "c"] }` | write the **successor** of the current value, wrapping; order members default-state-first |
| `{ copy: "template" }` | copy the evaluated template to the clipboard |
| `{ open: "template" }` | open the evaluated target in the editor |

A `set` action writing SessionState needs a matching `state` **variable** to
read the value back into templates: `{ kind: "state", key: "<same key>",
default: "…" }`. (The one exception: never declare state for a `{{ menu }}` —
its state is synthesized, see below.)

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

## Before you report done

1. `cc-candybar check <path>` exits 0.
2. stderr shows no warnings you have not read and accepted.
3. You declared **no** `menus.*`/`groups.*` names, no page cursors, no
   open-state vars — if a menu needed backing state, you let it synthesize.
4. Anything you could not express with `{{ menu }}`, a group, or a named
   action: read examples/demo-actions.json5 for the raw mechanism before
   inventing a new shape.
