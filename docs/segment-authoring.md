<!--
  Segment authoring reference — written for an AGENT config author.

  Snippet contract (enforced by test/doc-snippets.test.ts):
    ```json5 check:pass   — a COMPLETE config file; must exit 0 under `cc-candybar check`.
    ```json5 check:fail   — a COMPLETE config file; must exit 1, and the next
    ```error              — block must quote a substring of check's actual stderr.
    ```sh stub:<name>     — an executable named <name>, written verbatim onto PATH
                            before any snippet runs; a `shell` snippet may run it.
    ```json5 file:<path>  — a file written verbatim at <path>, relative to every
    ```json file:<path>     config snippet, before any snippet runs.
    ```render             — the bar the check:pass config ABOVE it renders, as
                            `cc-candybar check --render` prints it minus the
                            colour escapes; asserted byte for byte.
  Every ```json5 block in this file MUST carry one of the two annotations.
  Do not edit a snippet or a quoted error without running the test — the quoted
  strings are asserted against the real loader, not transcribed.
-->

# Segment authoring: a script, a source, a segment, a ramp

You are adding a segment whose data comes from **your own program** — a
budget tracker, a queue depth, a deploy status — to a bar you read as text
rather than look at. The whole job is four declarations: a script that prints
one JSON document, a `shell` variable that runs it and parses that document,
a segment template that reads the document's fields by dotted path, and a
`ramp` in the segment's `bg:` that turns one of those numbers into a theme
colour. The script never chooses a colour and the template never branches on
thresholds: the colour decision lives in the theme system, so it follows a
theme click and a style pick exactly as the built-in segments do.

Your eyes are `cc-candybar check` — its exit code and stderr for whether the
config is sound, and `--render` for what it puts on screen:

```
edit config  →  cc-candybar check --render <path>  →  read exit code + stderr + bar  →  repeat
```

| exit | meaning |
|------|---------|
| 0 | config loads and renders — warnings (advisory only) on stderr |
| 1 | config is invalid, or a segment's template throws at evaluation (the daemon would render a `⚠` cell) — stderr names the path and the fix |
| 2 | usage error / the named file could not be read |

`check` runs the daemon's exact pipeline (parse → merge on the bundled
default → validate → register → render against a representative payload). It
**runs your `shell` and `file` sources** and waits for their first runs, and
then, before each preset's pass, for the re-reads that preset's payload starts
(a `key` over `.preset.effective`), all under one 5 s budget; a source still
running at the deadline is reported as a warning naming the source, and the pass draws the variable as pending (its loading cell),
never as its `default`: a default stands in for a failure, not a wait. A user config merges onto the
bundled default by name, so declare only what differs: the variables and
segments below, plus the row that places the segment. A row you name under
`root.rows` replaces the bundled row of that name wholesale — the bundled
`status` row is `model · context · cacheTimer · block · weekly` — so list
every built-in you want kept beside yours; the short rows in the snippets
below drop the last three on purpose.

## The decision rule

- The value is **already in Claude Code's hook payload** (model, context,
  cost, rate limits, git) → an `input` variable, or more likely a built-in
  segment that already shows it. Nothing in this doc applies.
- The value comes from **a program you run** → `kind: "shell"`. From **a file
  another program keeps current** → `kind: "file"`. The two differ only in
  how the text arrives; everything after that is identical.
- The program prints **one value** → no `parse:` (the text, trimmed). **One
  value inside a line** you must slice out → `parse: { regex }`. **More than
  one field** → `parse: { json: true }`, and every field is a dotted read.
  One document, one run; never one variable per field.
- A **colour from a number** → `ramp` in the segment's `bg:` or `fg:`. Not in
  the script, not as an `if ge … else if ge …` cascade in the template.

A statusline cell has no tooltip. Anything you want on hover goes in the
template text or does not exist.

## Step 1 — the script

Any program that prints one JSON object to stdout and exits 0. Numbers are
numbers (`35`, not `"35"` — a quoted number is a string to the template, and
`ramp` refuses strings). The one here is the doc's own stand-in, shaped like a
budget tracker's output; your real script is any program printing the same
shape, invoked by the same name:

```sh stub:budget-status
#!/bin/sh
printf '%s\n' '{"period": "September", "spent": 42.5, "limit": 120, "spentPct": 35, "timePct": 20}'
```

The command runs under `/bin/sh -c` in the directory Claude Code started the
statusline in — the directory the bar's git facts are read in — so a command that
asks about "this repo" answers for the session's repo. It runs with the daemon's environment, so the script
is either on the daemon's `PATH` or spelled as an absolute path. A command the
shell cannot find fails its run with `exited with code 127`, and
what that failure renders as depends on the `default` you declare (Step 2).

## Step 2 — the source: one `shell` variable, one document

```json5 check:pass
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
  },
  segments: {
    budget: { template: "{{ .budget.period }} · {{ .budget.spentPct }}% spent" },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

That config is complete, so `check` can already show you it. `--render` prints
the bar beneath the verdict — the same render the exit code was reached on,
with the colours it will really have (stripped here, since a document cannot
hold escape bytes). Nothing is installed and the running daemon is not
touched; the payload is `check`'s own fixture, which is why the numbers below
are the same on every machine:

```render
 🍫   polled  ⇄ tester@tester-box  ~/c/c/src  ~/c/c/src ⎇ main +2/-1 SU? ▸ 
 ✱ Opus 4.8 󰶼  ◔ 48,487 (24%)  September · 35% spent 
```

The bundled `identity` row is above and this config's `status` row below it,
with the budget segment last; the `` between cells and the `` that opens each row are the powerline joiner,
and `check` renders the settings door (`🍫`) into the first row exactly as the
daemon does — so what you read there is the whole bar, chrome included.

The complete shape of a `shell` variable:

| field | value |
|---|---|
| `kind` | `"shell"` |
| `command` | the command line, run by `/bin/sh -c` |
| `parse` | absent or `{ text: true }` → the trimmed text, line breaks folded to spaces; `{ regex: "…" }` → capture group 1 of the text; `{ json: true }` → the text parsed once as a document. Exactly one key. |
| `cache` | **required** — exactly one of `{ ttl: "60s" }` (re-run on a timer; units `ms`/`s`/`m`/`h`; a shell `ttl` below 500 ms is silently raised to 500 ms), `{ watch_file: "/abs/path" }` (re-run when that file changes, or a symlink on the way to it is re-pointed; a watch the OS refuses, or a link chain that loops, is reported like a key that throws, below, and while the OS delivers no file events at all the bar's `⚠` counts the same warning), `{ depends_on: ["otherVar"] }` (run once the declared variables have values, and again when one changes), `{ key: "{{ .otherVar }}" }` (run once the key template has a value, and again when it changes; a key over a document still waiting for its first scan waits with it; while the key throws, the variable keeps its last value — its `default` if it never ran — the bar's `⚠` indicator counts a warning that it `cannot refresh`, and `cc-candybar check` fails on it), `{ never: true }` (run once) |
| `default` | what the variable reads until the first run completes and whenever a run fails. Under `text`/`regex` it is a string; under `json` it is a JSON value — normally the document shape, every field your templates read, with placeholder values — and it stands in only when there was nothing to read (the command failed, the file is missing): text that was read and is not JSON is the `⚠`, default or not |

A source that reads no session's value runs once for its directory, shared by
every session rendering there. One whose `key` or `depends_on` reads a
session's value — an `input` such as `session.id`, a `state` or a `template`
variable — runs once per session, on that session's values: another
session rendering from the same directory never re-runs it. A `key` or
`depends_on` that reads the clock — a `time` variable, a template calling
`now`, or a variable reading either — is refused at load: to re-run on time,
use `ttl` (see "A cache key that reads the clock" under Mistakes).

A source runs only when its cache policy says so. Drawing the bar never runs
one: while the bar moves it is redrawn up to 30 times a second between
statusline requests, and each of those frames reads the value the source last
stored, so a `ttl: "5s"` shell runs once every five seconds however often the
bar is drawn. `cc-candybar daemon-stats` lists every source's runs by what
asked for each (its first run, its period, a change, a request), its
failures, and how long its last run took.

A `file` variable is the same declaration with `path` (absolute — `~` and
relative paths are refused at load, like a relative `watch_file`; write the
full path) in place of `command`, plus an
optional `readMode: "whole" | "first-line"` selecting how much of the file
the parser sees. A file that does not exist yet reads as its `default`:

```json5 check:pass
{
  variables: {
    budget: {
      kind: "file",
      path: "/var/tmp/budget/status.json",
      parse: { json: true },
      cache: { watch_file: "/var/tmp/budget/status.json" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
  },
  segments: {
    budget: { template: "{{ .budget.period }} · {{ .budget.spentPct }}% spent" },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

The `default` is not optional in practice. A `json` source with no `default`
draws `…` in every segment reading it until its first run lands — not answered
yet, which is no fault — and one whose run fails or prints nothing — the script
is missing, exits non-zero — has no document to read, and every segment
reading it renders a `⚠` cell that `check` fails on.
Output that is not JSON is that `⚠` even with a `default`: a broken writer
is not an empty one. A `text`/`regex` source with no `default`
reads as the empty string instead, silently. Give every source a `default`,
and give a document default **every field a template reads**: a field that
exists in the script's output but not in the default is a `⚠` from daemon
start until the first run lands.

## Step 3 — shaped variables: what a dotted path reaches

A `json` source publishes a **document**, and the variable owns its whole
dotted subtree: `.budget.spentPct` is a field read on the document `budget`,
never a variable named `budget.spentPct`. Two rules follow.

Every field is a read, not a variable — you declare no `budget.spent` and no
`budget.limit`. The loader knows which variables are documents, so a
dotted path on a variable that is *not* one (`.budget.spentPct` when
`budget` is a literal, or undeclared) is a load error naming the path.

A knob that belongs with the document lives **outside** its namespace. The
threshold below is `budgetWarnAt`, not `budget.warnAt`: with `budget` a
document, `.budget.warnAt` is a field read, and a variable spelled
`budget.warnAt` is refused at load: no variable is declared under another
(Mistakes, below).

```json5 check:pass
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    budgetWarnAt: { kind: "literal", value: 80 },
  },
  segments: {
    budget: {
      template: "{{ .budget.spentPct }}% spent{{ if ge .budget.spentPct .budgetWarnAt }} ⚠{{ end }}",
    },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

A `literal` is `{ kind: "literal", value: <string | number | boolean> }`.
The threshold is a number because it is compared with a number; `value: "80"`
would be a string, and a string in a numeric slot is a render error.

The `text` and `regex` arms publish a **string**, whatever the text looked
like. To do arithmetic or comparison on it, cast at the point of use with
`float64` (or `int`); the regex's group 1 is the value, so the pattern must
have a capture group:

```json5 check:pass
{
  variables: {
    budgetPct: {
      kind: "shell",
      command: "budget-status",
      parse: { regex: "spentPct[^0-9]*([0-9.]+)" },
      cache: { ttl: "60s" },
      default: "0",
    },
    budgetWarnAt: { kind: "literal", value: 80 },
  },
  segments: {
    budget: {
      template: "{{ .budgetPct }}% spent{{ if ge (float64 .budgetPct) .budgetWarnAt }} ⚠{{ end }}",
    },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

Prefer the document whenever the script has a second field to print: a regex
per field is a spawn per field, and the casts follow you into every template.

A value computed from others is a `template` variable, and it is text unless
it says otherwise. Give it `type: "number"` (or `"boolean"`) and it is read
as one, the way an `input` is, so one name serves every template that compares
or ramps it; a template that renders no number is a failed read (a ⚠ naming
the variable), never a zero:

```json5 check:pass
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    budgetAhead: {
      kind: "template",
      type: "number",
      template: "{{ subf .budget.spentPct .budget.timePct }}",
    },
  },
  segments: {
    budget: {
      template: "{{ .budget.spentPct }}% spent{{ if gt .budgetAhead 10 }} ⚠{{ end }}",
    },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

## Step 4 — the template

The template is Go template text over the document's fields. Format numbers
with `printf`, compare fields with `gt`/`ge`/`lt`, and gate the whole segment
with `when` on a fact the document carries — here the segment hides while the
script has reported no limit, which is exactly the `default` before the first
run:

```json5 check:pass
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
  },
  segments: {
    budget: {
      description: "Spend against this period's budget, flagged when it outpaces the clock.",
      template: '{{ .budget.period }} ${{ printf "%.2f" .budget.spent }}/{{ .budget.limit }} · {{ .budget.spentPct }}% spent · {{ .budget.timePct }}% elapsed{{ if gt .budget.spentPct .budget.timePct }} ⚑{{ end }}',
      when: "{{ gt .budget.limit 0 }}",
    },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

A segment's `width:` is `"auto"` by default — as wide as its content. Give it a
positive integer for a fixed column count, or `"fill"` to take whatever is left of
the row after the other cells have taken their natural widths (two fills in one row
split it). A fill never widens a row past the width it was given: when the row is
already full it takes nothing and the bar wraps exactly as before.

A spacer that pushes the rest of a row to the right is one segment. Its template
must render **something** — a single space is enough — because a segment whose
template renders nothing contributes no cell at all, and a cell is what carries the
claim on the leftover:

```json5 check:pass
{
  segments: {
    spacer: { template: " ", width: "fill" },
    tail: { template: "{{ .model.display_name }}" },
  },
  root: { rows: { status: { h: ["model", "spacer", "tail"] } } },
}
```

`description:` is for whoever picks this segment up next — you in another
session, or anyone running `cc-candybar segments`, which prints it beside the
template. Nothing renders it, it is optional, and it rides the declaration
rather than living in a list somewhere else, so it moves with the segment. Every
bundled segment carries one, which is what makes that command a catalogue of
what the standard library shows; the published JSON schema carries the field
too, so an editor pointed at `$schema` completes it. One consequence is worth
knowing rather than discovering: a declaration under a **bundled** name is a
per-field delta, so overriding a bundled segment's `template` inherits that
segment's description — which then describes something that is no longer there.
If your version means something different, say so there too.

`group:` files the segment in the library edit mode's `✚` opens: one of
`location`, `git`, `model-context`, `cost-limits`, `activity` or
`session-tools`, naming what the segment is about. A segment that declares none
is listed under `other`, so a new segment of yours appears in the library with
no further wiring: its `description:` is the line shown beside its name, and its
`group:` the page it stands on. Every bundled segment declares one, and the
loader refuses any other value, naming the six.

`missingData:` decides whether the doctor (`🧰 tools › 🩺 doctor`, or
`cc-candybar doctor`) fails when this segment reads data that cc-candybar
cannot get from outside itself: a pull request when `gh` is not installed or
not logged in, or the rate-limit windows Claude Code sends only to Claude.ai
subscription sessions. It is `"fail"` unless you set `"ignore"`. A segment
that reads none of that data is never judged. The bundled bar places `block`
and `weekly` for everyone and hides each one when its data is absent. If your
account has no rate limits, set
`segments: { block: { missingData: "ignore" }, weekly: { missingData: "ignore" } }`
and the doctor stops counting them.

A segment with no `bg:` wears a tint the theme derives from its position in
the row. Authoring a `bg:` is a statement of meaning — this cell is hot — and
the next step is how to state it from a number.

## Step 5 — colour: a `ramp` over one field

```
{{ ramp <value> <easing> <position> <colour> [<position> <colour> …] }}
```

`ramp` maps a **number** onto a colour through ordered stops and returns a
`#RRGGBB` string, so it goes straight into `bg:` or `fg:`. Each stop is a
position followed by a colour; a colour is a palette name (`panel`,
`warning`, `error`, `success`, `foreground`, `button-color-foreground`, …)
or a hex literal, resolved against the palette the segment is rendering with,
so the colour follows a theme click and a style pick. The easing is one of two
words: `"step"` holds each stop's colour until the next position — a
`≥ threshold → next colour` cascade written as data — and `"linear"` blends
between neighbouring stops in OKLCH. Positions are required, must ascend, and
the value clamps at both ends; a value exactly on a stop is that stop's colour.

The same ramp draws a **gauge**: one value against a fixed maximum, as a row of
cells, where each cell's colour is this ramp asked at that cell's own position
rather than at the value. `{{ gauge <value> <max> <width> <filled> <empty> }}`
alone is monochrome and takes the segment's `fg:`; add an easing and
`"<position>:<colour>"` stops and the cells are painted individually, so a
half-full gauge reads two-toned the way a threshold cascade does:

```json5 check:pass
{
  segments: {
    ctx: {
      template: '◔ {{ gauge .context.contextLeft 100 10 "▰" "▱" "step" "0:error" "40:warning" "70:success" }}',
    },
  },
  root: { rows: { status: { h: ["model", "ctx"] } } },
}
```

A gauge is not a sparkline: the sparkline normalises every sample against its own
window, so it shows SHAPE over time and cannot say "73 % of the maximum". Both
exist and they stay separate.

When the answer to a threshold is a **word** rather than a colour, `cascade` is the
same decision with a text result — the stops ascend and the last one at or below the
value wins, exactly as in `ramp`:

```json5 check:pass
{
  segments: {
    ctx: {
      template: '◔ {{ .context.contextLeft }}% {{ cascade .context.contextLeft "0:COMPACT!" "25:tight" "60:roomy" }}',
      bg: '{{ ramp .context.contextLeft "step" 0 "error" 25 "warning" 60 (tint) }}',
    },
  },
  root: { rows: { status: { h: ["model", "ctx"] } } },
}
```

The calm stop `(tint)` is the decoration the segment would wear with no `bg:`
at all (more on it below). Write the two with the same stop positions and the
word and the colour change together. A descending pair is a loud error in both, because a silently sorted
cascade is a different cascade than the one you wrote.

Every position anyone might tune is a **declared variable** riding in the
position slot; the only literal positions are the fixed ends of the value's
domain (`0`, and `100` for a percentage). The knob is then one number to
edit, and `check` refuses a descending pair loudly instead of sorting the
stops into a ramp you did not write. The calm stop is `(tint)`: the
decoration the segment would wear with no `bg:` at all. A calm cell states
nothing, so it wears what every cell that states nothing wears. A fixed role
such as `panel` there paints two calm neighbours as one slab. The
one-threshold form — calm until the knob, the warning colour from there:

```json5 check:pass
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    budgetWarnAt: { kind: "literal", value: 80 },
  },
  segments: {
    budget: {
      template: "{{ .budget.period }} ${{ .budget.spent }}/{{ .budget.limit }} · {{ .budget.spentPct }}% spent · {{ .budget.timePct }}% elapsed",
      bg: '{{ ramp .budget.spentPct "step" 0 (tint) .budgetWarnAt "warning" }}',
    },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

The complete budget bar, placed in the full bundled status row — the pattern
the bundled `block` and `weekly` segments use: two knobs, a `bg:` cascade
calm → `warning` → `error`, and the `when` gate from Step 4. Leave `fg:` off.
Text nobody authored is chosen for whatever background the cascade lands on,
and held to 4.5:1 against it. A hand-picked text colour per stop is a guess that
some theme breaks (the bundled segments' own guess measured 1.55:1 on
rose-pine's `warning`):

```json5 check:pass
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    budgetHeatAt: { kind: "literal", value: 50 },
    budgetWarnAt: { kind: "literal", value: 80 },
  },
  segments: {
    budget: {
      template: '{{ .budget.period }} ${{ printf "%.2f" .budget.spent }}/{{ .budget.limit }} · {{ .budget.spentPct }}% spent · {{ .budget.timePct }}% elapsed{{ if gt .budget.spentPct .budget.timePct }} ⚑{{ end }}',
      bg: '{{ ramp .budget.spentPct "step" 0 (tint) .budgetHeatAt "warning" .budgetWarnAt "error" }}',
      when: "{{ gt .budget.limit 0 }}",
    },
  },
  root: { rows: { status: { h: ["model", "context", "cacheTimer", "block", "weekly", "budget"] } } },
}
```

A gradient is the same call with `"linear"`: green at 0, the warning colour
at the knob, red at 100, and every value in between a perceptual blend of its
neighbours:

```json5 check:pass
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    budgetWarnAt: { kind: "literal", value: 80 },
  },
  segments: {
    budget: {
      template: "{{ .budget.spentPct }}% spent",
      bg: '{{ ramp .budget.spentPct "linear" 0 "success" .budgetWarnAt "warning" 100 "error" }}',
    },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

`ramp` reads the palette of the segment being rendered, so it is only
available inside a segment's `template`, `bg:` and `fg:`. In a variable
declaration or a layout `when` there is no segment, and the call fails
(Mistakes, below).

## Reshaping a bundled segment: git

The bundled git segment is built from the same parts a config can declare,
so changing what it shows is an override of one part, never a copy of the
whole template. `gitaculous` has two forms, each a named helper:
`gitCollapsed`, the summary every session starts in, and `gitExpanded`, every
fact. The `▸` at its right edge expands it and the `◂` collapses it again —
a `cycle` action (`gitDetail`) over a per-session `state` variable
(`git.detail`), so each Claude session keeps its own choice. Both forms
compose these named `helpers`, each called as `{{ template "<name>" . }}`:

| helper | renders |
|--------|---------|
| `gitBranch` | `⎇ main` — present whenever git names a branch |
| `gitPath` | `~/c/cc-candybar/src (⊫ my-worktree)` — the main checkout, the subdirectory, and the linked worktree's name; click copies the full path |
| `gitRepo` | ` cc-candybar` — replaces `gitPath` when the variable `git.location` is `"repo"` |
| `gitOperation` | ` [rebase]` |
| `gitSha` | ` abc1234` |
| `gitFlags` | ` SU?!1` — staged, unstaged, untracked, conflicts |
| `gitAheadBehind` | ` +2/-1` |
| `gitUpstream` | ` [origin/main +2/-1]` — includes `gitAheadBehind` |
| `gitStash` | ` (1 stashed)` |
| `gitAge` | ` ◷ 13m` — time since the last commit |

The worktree mark is the literal variable `glyph.worktree`. Outside a repo the
segment shows the plain path and a two-click `init` that runs `git init` in the
session's directory. While git is loading it shows the path alone.

Every piece except `gitBranch` and `gitPath` renders with its own leading space, or renders
nothing when its fact is absent, so pieces drop and reorder without leaving a
doubled space. Each fact's colour is a variable holding a palette name —
`git.color.branch`, `.staged`, `.unstaged`, `.untracked`, `.conflicts`,
`.ahead`, `.behind`, `.stash` — painted through the `gitPaint` helper, which
keeps it readable on the cell's background. Everything unpainted wears the
segment's quiet `fg:`.

The snippets below replace the whole `root` with the one segment so the
rendered bar is short; drop the `root` line to keep the bundled rows.

Choose what the summary shows — override the form, listing the pieces you
want in your order:

```json5 check:pass
{
  helpers: {
    gitCollapsed: '{{ template "gitBranch" . }}{{ template "gitFlags" . }}{{ template "gitStash" . }}',
  },
  root: { h: ["gitaculous"] },
}
```

```render
 🍫   polled  ⎇ main SU? (1 stashed) ▸ 
```

Start every session expanded — redeclare the state variable with the other
default. The arrow still collapses it for the session that clicks:

```json5 check:pass
{
  variables: {
    "git.detail": { kind: "state", key: "git-detail", default: "expanded" },
  },
  root: { h: ["gitaculous"] },
}
```

```render
 🍫   polled  (git) ~/c/c/src [rebase] abc1234 SU? ⎇ main [origin/main +2/-1] (1 stashed) ◷ 13m ◂ 
```

Hide one fact — override its piece with an empty body. A piece is shared, so
the fact leaves both forms:

```json5 check:pass
{
  helpers: { gitFlags: "" },
  root: { h: ["gitaculous"] },
}
```

```render
 🍫   polled  ~/c/c/src ⎇ main +2/-1 ▸ 
```

Hide a fact from one copy only — each optional piece also reads a setting of
the placement it renders in (`aheadBehind`, `flags`, `operation`, `repo` (shown when `git.location` is `"repo"`),
`sha`, `stash`, `upstream`, `age`; every one defaults to `true`; `upstream`
off takes its bracket and the ahead/behind inside it), so two copies of the
segment can show different facts in either form, and configure mode changes
them from the bar. A segment of your own that calls one of these pieces
declares the same setting (the loader names your segment and the setting when
it does not):

```json5 check:pass
{
  root: { h: ["gitaculous", { seg: "gitaculous", id: "gitLean", settings: { flags: false, aheadBehind: false } }] },
}
```

```render
 🍫   polled  ~/c/c/src ⎇ main +2/-1 SU? ▸  ~/c/c/src ⎇ main ▸ 
```

Recolour one fact — override its colour variable (any palette name or hex),
or re-spell it by overriding its piece:

```json5 check:pass
{
  variables: { "git.color.behind": { kind: "literal", value: "error" } },
  helpers: { gitBranch: 'on {{ template "gitPaint" (dict "color" .git.color.branch "text" .git.branch) }}' },
  root: { h: ["gitaculous"] },
}
```

```render
 🍫   polled  ~/c/c/src on main +2/-1 SU? ▸ 
```

## One segment, many placements: settings

A segment's declaration is its **definition**; each place `root` names it is
a **placement** — an instance of that definition. When the same segment should
show differently in two places, declare what may vary as `settings`, and let
each placement set its own values. A template reads its placement's values
as `.settings.<name>`:

- `settings` on the segment maps a name (an identifier) to
  `{ label, domain, default }`. A domain is `"bool"`, a list of words, or
  `{ min, max, step?, atLeast? }` (whole numbers; `step`, 1 when absent, is
  how far one click of its stepper moves it); the default must be in it.
- A placement is `{ seg: "<segment>", id: "<id>", settings: { … } }`. It sets
  only what differs; every other setting reads its default. A bare
  `"modelTag"` is the placement `{ seg: "modelTag", id: "modelTag" }` with every
  default.
- Every placement in a layout has its own `id` — a bare one takes its
  segment's name, so a second placement of one segment names an id of its
  own. The id is the placement's identity: its menus' open state and edit
  mode's `✖` address it.

```json5 check:pass
{
  segments: {
    modelTag: {
      description: "The model's name, spelled the way each placement asks.",
      template: '{{ if .settings.icon }}◆ {{ end }}{{ if eq .settings.length "short" }}{{ trunc .settings.chars .model.display_name }}{{ else }}{{ .model.display_name }}{{ end }}',
      settings: {
        icon: { label: "Icon", domain: "bool", default: false },
        length: { label: "Length", domain: ["full", "short"], default: "full" },
        chars: { label: "Characters", domain: { min: 1, max: 12 }, default: 4 },
      },
    },
  },
  root: { h: ["modelTag", { seg: "modelTag", id: "shortTag", settings: { length: "short", icon: true } }] },
}
```

```render
 🍫   polled  Opus 4.8  ◆ Opus 
```

The segment's `when`, `bg:` and `fg:` read the same `.settings` as its
template. No variable may be named `settings` or `settings.<x>` — inside a
segment that name is the placement's.

Every placement also has two settings its segment never declares. `theme` is
the palette that placement renders in. It is `"bar"` (the bar's own theme,
style included) or an installed theme name, which pins that placement to that
theme whatever the bar's theme and style are. A segment's `palette:` is the
default for every placement of it; a placement's own `theme` overrides it for
that placement alone, `"bar"` included. `effect` is the looping effect that
placement's cell wears: `"bar"` (the default: whatever `globals.effect` puts on
the bar), `"none"`, or a catalogue loop (`shimmer`, `pulse`, `sparkle`,
`wheel`). An effect of its own replaces the bar's on that placement's cell and
the seams beside it, with its own clock starting when it comes into force;
every other cell of the row moves as the bar's effect moves it. A template
reads either as `.settings.theme` / `.settings.effect` like any other setting.

```json5 check:pass
{
  segments: {
    modelTag: { template: "{{ .model.display_name }}", palette: "nord" },
  },
  root: { h: [
    "modelTag",
    { seg: "modelTag", id: "barTag", settings: { theme: "bar", effect: "pulse" } },
  ] },
}
```

A setting is also changeable from the bar. In edit mode every placement
carries a `🔧` after its name (every placement has `theme` and `effect`); clicking it
configures that one placement: the `+`/`-` chrome goes away and one control
per setting hangs below the cell, one row each (a toggle for `"bool"`, a `◀ label ▶` control over a list for a word
list, a `◀ ▶` stepper for `{ min, max }`, and for `theme` the theme picker,
whose every option is drawn in the palette it would put on the placement),
bounded by the declaration. A change shows at once and is unsaved until `💾 save`, which
writes it into that placement in the config file — a bare `"modelTag"`
becomes `{ seg: "modelTag", settings: { … } }`. One placement is configured at
a time.

Thresholds a `ramp` reads are settings too, and a ramp's stops must ascend.
Say so in the declaration: `atLeast` names another range setting this one may
never fall below. A placement whose values break it fails to load, and a
stepper click that would break it is refused in the bar with both names, so
the ramp never sees a descending pair. The bundled `block`, `weekly`,
`burnrate`, `session` and `today` segments declare their thresholds and
budgets this way — `{ seg: "block", settings: { warnAt: 60, errorAt: 90 } }`
retunes one copy.

```json5 check:pass
{
  segments: {
    spend: {
      template: "{{ .session.cost }}",
      bg: '{{ ramp .session.cost "step" 0 (tint) .settings.warnAt "warning" .settings.errorAt "error" }}',
      settings: {
        warnAt: { label: "warning at $", domain: { min: 0, max: 100, step: 5 }, default: 10 },
        errorAt: { label: "error at $", domain: { min: 0, max: 100, step: 5, atLeast: "warnAt" }, default: 20 },
      },
    },
  },
  root: { h: ["spend", { seg: "spend", id: "tightSpend", settings: { warnAt: 5, errorAt: 5 } }] },
}
```

## A segment another program ships: plugins

When the program whose data you show is someone else's — a deploy tool, a
ticket tracker — the segment can ship WITH that program as a **plugin**: two
files the program owns, and one line in your config. The program's developer
writes a DEFINITION once:

```json5 file:deploy/plugin.json5
{
  data: "./state.json",
  segments: {
    status: {
      description: "The current deploy: its environment and state",
      when: '{{ hasKey .self.data "env" }}',
      template: '⇪ {{ .self.data.env }} {{ template "self.state" .self.data }}',
    },
  },
  helpers: {
    state: '{{ if eq .state "live" }}✓ live{{ else }}… {{ .state }}{{ end }}',
  },
}
```

and the running program rewrites the DATA file — plain JSON — whenever its
state changes:

```json file:deploy/state.json
{ "env": "staging", "state": "rolling" }
```

Your config lists the definition (relative to the config file; `~` works) and
places its segment like any other:

```json5 check:pass
{
  plugins: ["./deploy/plugin.json5"],
  root: { rows: { status: { h: ["model", "context", "plugins.deploy.status"] } } },
}
```

What the definition can say, and what follows from it:

- **The folder is the name.** A definition is `<name>/plugin.json5`, and
  `<name>` — one lowercase identifier — is the plugin's name; the file does
  not repeat it.
- **Every name is the plugin's, under `plugins.`.** A segment, helper or
  action declared as `status` is `plugins.deploy.status` everywhere outside
  the definition — in `root`, in edit mode's add-segment library (where the
  plugin's segments appear with their `description`), and in your templates.
  A plugin replaces, whole, any plugin of its name beneath it (a listed one
  replaces an installed one); listing one name twice is refused. A
  repository's own plugins sit under `repo.` instead (see below), so they
  never replace yours.
- **The definition calls itself `self`.** Inside it, `.self.data`,
  `{{ template "self.state" }}`, `{{ action "self.go" "…" }}` and
  `do: ["self.go", …]` name the plugin's own data, helpers and actions, and
  the loader binds `self` to the namespace the plugin loads under. So one
  definition loads alike installed (`plugins.deploy`) and shipped in a
  repository (`repo.deploy`), and `cc-candybar plugin install` changes
  nothing about it. A definition that spells its own name under the scope
  it did not load in (`.plugins.deploy.data` in a repository's `deploy`) is
  dropped, naming the `self` spelling to write instead.
- **The data is `.self.data`** — `.plugins.<plugin>.data` from your own
  file. `data` is optional; a
  definition without it has no data variable. It is a `file` source with
  `parse: { json: true }`, watched: a rewrite redraws the bar, nothing is
  re-read per render. A data file that does not exist yet reads as no fields,
  so gate the segment with `when: '{{ hasKey .self.data "<field>" }}'`;
  blank data reads the same way, and data that is not JSON is a `⚠` on every
  segment reading it. The app may create the file late and rewrite it any
  way it likes: a read caught mid-rewrite keeps the last document showing.
  `data: { checkout: ".lit/statusline.json" }` reads it relative to the
  root of the git checkout the session works in instead — each worktree its
  own, a session in no checkout reading from its working directory — so one
  installed definition shows each checkout's own data. The plugin lit
  installs reads lit's state this way.
- **`data`, `sources`, `variables`, `segments`, `helpers` and `actions`,
  each optional.** A definition never edits `root` — placing a segment is your
  choice. Its `variables` are a config's `variables:`, every kind, checked the
  same way, and named under the plugin: `greeting` is read as
  `.self.greeting`. A segment's `vars` may be of any kind too; a
  `state` one reads what the session's own clicks wrote, so a segment can
  open a detail row of its own (`{ kind: "state", key, default }` beside a
  `{ set: key, cycle: [...] }` action, read as `.self.<segment>.<var>`).
  A `state` variable's `key` and an action's `set` are written
  bare and meet under the plugin's namespace — a plugin's session keys are
  namespaced as its names are, so none can clash with the bar's or your file's.
  No variable or source may be named `data`, the data file's name.
  The plugin name is one lowercase identifier.
- **Merge order is bundled < installed plugins < listed plugins < your
  file**, so your file can
  retune a plugin's segment by its full name, one field at a time
  (`segments: { "plugins.deploy.status": { bg: "error" } }`).

A plugin with no data file derives what it shows from variables of its own:

```json5 file:hello/plugin.json5
{
  variables: {
    model: { kind: "input", path: "model.display_name" },
    greeting: { kind: "template", template: "hello, {{ .self.model }}" },
  },
  segments: {
    greeting: { template: "{{ .self.greeting }}" },
  },
}
```

```json5 check:pass
{
  plugins: ["./hello/plugin.json5"],
  root: { rows: { status: { h: ["model", "plugins.hello.greeting"] } } },
}
```

### A value per session: `sources` and managed storage

When what the program knows differs per Claude Code session — the ticket a
session works on, a limit set for one session — the plugin declares a
**source**, and cc-candybar gives each session a file of its own in the
plugin's folder:

```
<plugin folder>/session/<session id>.json
```

```json5 file:focus/plugin.json5
{
  sources: {
    status: { scope: "session", refresh: { watch: true }, read: { file: { json: true } } },
  },
  segments: {
    ticket: {
      description: "The ticket this session works on",
      when: '{{ hasKey .self "status" }}',
      template: '◎ {{ .self.status.ticket }}',
    },
  },
}
```

```json5 check:pass
{
  plugins: ["./focus/plugin.json5"],
  root: { rows: { status: { h: ["model", "context", "plugins.focus.ticket"] } } },
}
```

- **The source is the session's document.** The plugin's templates read it
  as `.self.<source>` (`.plugins.<plugin>.<source>` from your own file), its
  fields by dotted path. The one source
  built is the one above — `scope: "session"`, `refresh: { watch: true }`,
  `read: { file: { json: true } }`, with no path — and anything else drops
  the plugin with an error naming the field and what is built. Its name is
  one identifier, and no variable of the plugin may share it.
- **The program writes the whole file, then renames it into place.** Write
  the document to a temporary file in the same `session` folder and rename
  it over `<session id>.json`, every time what it knows changes. The rename
  is atomic, so the bar never reads half a document; a file written in
  place can be read half-written, which is not JSON and draws `⚠`. The
  session id is the `session_id` Claude Code hands the program's hooks, and
  `{{ .session.id }}` in an action. cc-candybar creates the folder when it
  loads the plugin, re-reads a session's file when it changes, and only
  while a session's bar reads the source.
- **Old files are removed.** A `*.json` file in the folder that nobody has
  written for 30 days belongs to a session that is gone, and is deleted —
  unless a session's bar holds it now.
- **Until the program writes, there is nothing to read.** No file, or a
  blank one, reads as absent: `hasKey .self "<source>"` is
  false, so a segment gated on it hides. That gate is the only safe read
  before the first write. An unguarded read is the missing-field error —
  the segment draws `⚠` and `check` fails — and a file that is not JSON
  draws `⚠` with the reason and the path.
- **`check` reads every source as absent.** It runs no plugin program and has
  no session, so it draws what a session draws before the first write: the
  gated segment above is hidden under `check`, and the unguarded read below
  fails it.
- **One file, one source.** A plugin's session file is one document, so a
  plugin declares one source for it and reads its fields. Two sources
  reading the same file drop the plugin, naming both.

```json5 file:bare/plugin.json5
{
  sources: {
    status: { scope: "session", refresh: { watch: true }, read: { file: { json: true } } },
  },
  segments: {
    ticket: { template: '◎ {{ .self.status.ticket }}' },
  },
}
```

```json5 check:fail
{
  plugins: ["./bare/plugin.json5"],
  root: { rows: { status: { h: ["model", "plugins.bare.ticket"] } } },
}
```

```error
segment "plugins.bare.ticket": field "plugins.bare.status.ticket" not found on receiver
```

```json5 file:twice/plugin.json5
{
  sources: {
    ticket: { scope: "session", refresh: { watch: true }, read: { file: { json: true } } },
    title: { scope: "session", refresh: { watch: true }, read: { file: { json: true } } },
  },
  segments: { ticket: { template: '◎ {{ .self.ticket.id }}' } },
}
```

```json5 check:fail
{
  plugins: ["./twice/plugin.json5"],
  root: { rows: { status: { h: ["model", "plugins.twice.ticket"] } } },
}
```

```error
sources .plugins.twice.ticket and .plugins.twice.title read the same file
```

A program the bar runs from a click — to move a value, then show it — is a
`run` action ([interaction-authoring.md](interaction-authoring.md)): its
`refreshes` names the source the program rewrites, so the segment reads as
loading until the program exits, and then shows what it wrote.

A definition that does not load — a missing file, a syntax error, a field it
may not declare, a template that does not parse or names something nothing
declares — drops **that plugin only**: the rest of your config renders, a
template reading its data, a source or a variable, calling its helper or
binding its action shows `⚠` naming the drop — a segment of it you placed or
retuned stands in as that cell — a `run` of yours that refreshes one of its
sources still runs, with nothing of it to refresh, the bar's diagnostics
indicator offers a message naming the definition and the reason, and `check`
fails. An INSTALLED plugin
that does not load is your config's problem only where it reaches it (a
placement, a retune, a helper call, an action binding or a `refreshes`): one
nothing reaches is neither among the bar's messages nor in `check`. A
listed definition is a folder's `plugin.json5`, the folder naming the plugin.
A definition is watched like your config file, so fixing or installing it
reloads the bar:

```json file:broken/plugin.json5
{ "data": "./state.json", "segments": {}, "root": {} }
```

```json5 check:fail
{
  plugins: ["./broken/plugin.json5"],
}
```

```error
was not loaded: a plugin definition may not declare "root"
```

### Installing a plugin instead of listing it

An app ships its plugin in its own repository, at
`.cc-candybar/plugins/<name>/plugin.json5`, and a user installs it with

```sh
cc-candybar plugin install promptctl/links-issue-tracker   # a GitHub slug
cc-candybar plugin install ~/code/links-issue-tracker      # a local path
cc-candybar plugin install https://example.com/app.git     # any git URL
```

which copies each folder's `plugin.json5` into a folder of that name in the
user's plugin root, and refuses the whole install, with the loader's
reason, if any definition would not load. Re-running it updates them,
replacing only each `plugin.json5`, so a data file the app keeps beside it
stays. A plugin installs with no config edit
because it sits in a plugin root:

- `$XDG_DATA_HOME/cc-candybar/plugins/<name>/` (default
  `~/.local/share/cc-candybar/plugins/`) — the user's;
- `<dir>/cc-candybar/plugins/<name>/` for each `$XDG_DATA_DIRS` entry — a
  package manager's. Unset, that is `/usr/local/share` and `/usr/share`, and
  on macOS Homebrew's `share/` before them (`$HOMEBREW_PREFIX/share`, else
  `/opt/homebrew/share`);
- `<repo>/.cc-candybar/plugins/<name>/` — a repository's own, there only in
  sessions working in that repo, once the user has approved the repository
  in the bar (as its `.cc-candybar.json5` is). Its plugins load under
  `repo.`, not `plugins.`: a repo's `lit` folder's `ticket` is placed as
  `repo.lit.ticket`, beside an installed `lit` whose names stay
  `plugins.lit.*`. Both load side by side, and a name missing from one is
  never looked up in the other. A plugin a repository's `.cc-candybar.json5`
  lists is a `repo.` plugin too. The definition itself is the same file an
  install would copy: it names itself `self`, never `repo.lit`.

A plugin is a folder: a file sitting directly in a root is a drop naming
where to move it, and a dot-entry (`.git`, `.DS_Store`) is ignored. A
`data: { checkout }` path stays inside the checkout — an absolute path, `~`
or a `..` that leaves it is refused. The user's root replaces a package
manager's plugin of the same name; a repository's plugins replace nothing,
since they live under `repo.`. An installed plugin's segments are in the
add-segment library; it draws something only once a segment of it is
placed. The roots are watched, so installing or removing a folder reloads
the bar.

A placement of a plugin that is not present in the session draws nothing
and is no error: no `⚠`, and `check` passes. So your own config can place
`repo.lit.ticket` for every repository that ships `lit`, and in any other
directory the cell is simply not there; the same goes for a `plugins.` cell
whose plugin is not installed. A placement under a plugin that IS present
but declares no such segment is an error: the message names the plugin file
that won and every segment and setting it declares, and clicking it in the
bar copies a prompt for Claude that names your config file and asks it to
fix the placement.

```json5 check:pass
{
  segments: { mine: { template: "mine" } },
  root: { h: ["mine", "repo.lit.ticket", "plugins.notinstalled.status"] },
}
```

### Adding your segment to the user's bar from a repo

A repository's `.cc-candybar.json5` merges over the user's config, so it
could restate a row, but that replaces the user's row. To add a cell to
whatever the user already has, list it under `insert`, beside a placement
id the user's bar holds (a bare placement's id is its segment's name):

```json5 check:pass
{
  segments: { lit: { template: "lit" } },
  root: { rows: { status: { h: ["model", "context"] } } },
  insert: [{ seg: "lit", after: "model" }],
}
```

A segment of the repository's own plugin is inserted by its `repo.` name —
`insert: [{ seg: "repo.lit.ticket", after: "plugins.lit.phase" }]` — so it
draws beside the user's placements of an installed plugin of the same name
rather than replacing them.

Here the file stands alone, so the row it inserts into is its own. In a
repository, leave `root` out and the cell lands in the user's row. Each
cell takes exactly one of `before` or `after`, and an optional `id`. The
anchor must be a placement: the bar's own chrome, such as the settings
door, is refused. Every
arrangement places the cell in its own tree, presets included, and one
whose tree lacks the anchor doesn't draw it. When that tree is a root or a
preset some config file writes, the bar warns once per cell, naming your
file, the cell, the anchor and every tree that lacks it. A root or preset only
cc-candybar ships has no such placement to sit beside, so it simply draws
without the cell. A cell a tree already places is not drawn twice: a cell
without an `id` is already placed by any placement of its segment, whatever
its id and however deep; a cell with an `id` only by a placement with that
id. A cell whose id the tree holds under another segment, or that would
clash with the bar once placed, is not drawn, and the bar warns naming your
file and the entry. The cell shows only where its anchor does: a `when` that
hides the anchor hides the cell too. Like the rest of the file, `insert` takes effect only once the
user has approved the repository. In edit mode the cell shows which file
placed it, and offers no remove or move: it is an `insert` entry, and edit
mode's clicks don't rewrite those, even in the user's own file. To change
one, edit the `insert` list by hand. The cell stays beside its anchor, and if the user removes their
own copy of it, yours comes back.

## Mistakes and the errors they produce

Each entry: the wrong config, then the text `cc-candybar check` prints. The
first seven are load errors — the config never renders. The rest are render
errors: the config loads, a template throws, and `check` exits 1 naming the
segment the daemon would draw as `⚠`.

### The retired top-level `regex:`

The regex is the parse step's arm now. The error spells the replacement:

```json5 check:fail
{
  variables: {
    budgetPct: {
      kind: "shell",
      command: "budget-status",
      regex: "spentPct[^0-9]*([0-9.]+)",
      cache: { ttl: "60s" },
      default: "0",
    },
  },
  segments: { budget: { template: "{{ .budgetPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
variables.budgetPct.regex was retired; the regex is the parse step's regex arm now: parse: { regex: "spentPct[^0-9]*([0-9.]+)" }
```

### A `readMode` on a `shell` source

`readMode` picks whole-file vs first-line, and only a `file` source reads a
file. On a `shell` source the loader names the stray field rather than
dropping it:

```json5 check:fail
{
  variables: {
    budgetPct: {
      kind: "shell",
      command: "budget-status",
      readMode: "first-line",
      parse: { regex: "spentPct[^0-9]*([0-9.]+)" },
      cache: { ttl: "60s" },
      default: "0",
    },
  },
  segments: { budget: { template: "{{ .budgetPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
Unknown shell variable key "readMode". Expected one of: kind, command, parse, cache, default
```

### A `shell` or `file` source with no `cache:`

There is no default policy. The error lists the five:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
  },
  segments: { budget: { template: "{{ .budget.spentPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
shell variables must declare a cache policy (one of: ttl, watch_file, depends_on, key, never)
```

### A cache key that reads the clock

A key over a `time` variable looks like "re-run once an hour", but the clock
is read when a frame is drawn, not stored, so no change of it can re-run the
source. The same refusal covers a `depends_on` naming a `time` variable and a
key calling `now`. Re-run on a period instead: `cache: { ttl: "1h" }`.

```json5 check:fail
{
  variables: {
    hour: { kind: "time", layout: "15" },
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { key: "{{ .hour }}" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
  },
  segments: { budget: { template: "{{ .budget.spentPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
cache.key reads "hour", which is a time variable: it reads the instant a frame is drawn at
```

### A `parse.regex` with no capture group

Group 1 is the value; a pattern without one could only ever fail to match:

```json5 check:fail
{
  variables: {
    budgetPct: {
      kind: "shell",
      command: "budget-status",
      parse: { regex: "spentPct[^0-9]*[0-9.]+" },
      cache: { ttl: "60s" },
      default: "0",
    },
  },
  segments: { budget: { template: "{{ .budgetPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
parse.regex must contain a capture group — its group 1 is the value; got "spentPct[^0-9]*[0-9.]+"
```

### Two parse arms in one `parse:`

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true, regex: "(.*)" },
      cache: { ttl: "60s" },
      default: { spentPct: 0 },
    },
  },
  segments: { budget: { template: "{{ .budget.spentPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
parse must declare exactly one of: text, regex, json (found: json, regex)
```

### A document `default` on a text source

A `default` lives in its parse arm's output domain. Without `parse: { json:
true }` the source is text, and text's default is a string — the usual cause is
the `parse:` line missing, not the default being wrong:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
  },
  segments: { budget: { template: "{{ .budget }}" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
variables.budget.default must be a string, got object
```

### A dotted read on a variable that is not a document

`.budget.spentPct` resolves only when `budget` is a `json`-parsed source. On
a literal, a text source, or nothing at all, the loader rejects the path —
the same text either way:

```json5 check:fail
{
  variables: { budget: { kind: "literal", value: 35 } },
  segments: { budget: { template: "{{ .budget.spentPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
Template references unknown variable ".budget.spentPct"
```

### A `~` in a file path

Paths are absolute and `~` is not expanded. The loader refuses the path
rather than read a file nobody meant — a relative path would name one
directory for the daemon and another for the session's shell commands:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "file",
      path: "~/.cache/budget/status.json",
      parse: { json: true },
      cache: { watch_file: "~/.cache/budget/status.json" },
    },
  },
  segments: { budget: { template: "{{ .budget.spentPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
variables.budget.path must be an absolute path (`~` and relative paths are not expanded), got "~/.cache/budget/status.json"
```

### A `json` source whose script prints something that is not JSON

The stand-in for a script that has broken:

```sh stub:budget-broken
#!/bin/sh
echo 'budget: unavailable'
```

Every segment reading the document renders `⚠` naming the variable, then the
reason: `JSON parse failed: Unexpected token 'b', "budget: unavailable` for
this script (each followed by ` in output of "<command>" in <cwd>`),
`shell "budget-broken" exited with code 127 in <cwd>` for one the shell
cannot find, `file unreadable: <path>` for a `file` source. A `default`
renders in place of the last two — there was nothing to read — but never in
place of the first: a script that printed something that is not JSON is
broken, and the bar says so whatever its `default` is:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-broken",
      parse: { json: true },
      cache: { ttl: "60s" },
    },
  },
  segments: { budget: { template: "{{ .budget.spentPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
segment "budget": variable "budget": JSON parse failed
```

### A `default` missing a field the template reads

Whenever the default is what reads — before the first run, after a failed
one — a template reaching a field the default lacks throws. Here the command
does not exist, so the default renders under `check`; with a working
script this passes `check` and fails at daemon start instead. A typo in a
field name (`.budget.spentPercent`) prints the same text:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-missing",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { spentPct: 0 },
    },
  },
  segments: { budget: { template: "{{ .budget.period }} · {{ .budget.spentPct }}% spent" } },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
segment "budget": field "budget.period" not found on receiver
```

### A knob declared inside the document's namespace

With `budget` a document, `.budget.warnAt` would name two things: the variable
`budget.warnAt` and the document's own `warnAt` field. No variable may be
declared under another, so the loader refuses the config and names both. Move
the knob out of the namespace (`budgetWarnAt`):

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    "budget.warnAt": { kind: "literal", value: 80 },
  },
  segments: {
    budget: {
      template: "{{ .budget.spentPct }}% spent",
      bg: '{{ ramp .budget.spentPct "step" 0 (tint) .budget.warnAt "error" }}',
    },
  },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
variable "budget.warnAt" is declared under the variable "budget"
```

### A threshold declared as a string

`ramp` takes numbers in its value and position slots. The error counts
arguments from 1 — `arg 5` is the second stop's position, the knob:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    budgetWarnAt: { kind: "literal", value: "80" },
  },
  segments: {
    budget: {
      template: "{{ .budget.spentPct }}% spent",
      bg: '{{ ramp .budget.spentPct "step" 0 (tint) .budgetWarnAt "error" }}',
    },
  },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
function "ramp" arg 5: expected float
```

A regex-sourced value in the value slot fails the same way at `arg 1`; cast
it with `float64` (Step 3).

### A `ramp` with descending positions

The ramp refuses to sort. A literal sitting between two knobs is how this
happens to a config that once passed — lowering the knob below the literal
makes a descending pair the user cannot repair from the knob:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    budgetWarnAt: { kind: "literal", value: 40 },
  },
  segments: {
    budget: {
      template: "{{ .budget.spentPct }}% spent",
      bg: '{{ ramp .budget.spentPct "step" 0 (tint) 50 "warning" .budgetWarnAt "error" }}',
    },
  },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
ColorRamp stops must be in ascending position order; stop 2 at 40 follows stop 1 at 50
```

### A stop with a position and no colour

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    budgetWarnAt: { kind: "literal", value: 80 },
  },
  segments: {
    budget: {
      template: "{{ .budget.spentPct }}% spent",
      bg: '{{ ramp .budget.spentPct "step" 0 (tint) .budgetWarnAt }}',
    },
  },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
ramp's last stop (position 80) has no color — stops are <position> <color> pairs
```

An easing other than `"linear"`/`"step"` fails the same way, naming both; a
misspelled palette name fails with `color reference "eror" did not resolve`.

### A `ramp` outside a segment

In a variable template there is no segment to take a palette from, and `ramp`
is registered per-segment against the palette of the one currently rendering —
so the function is not there to call. The variable reads as that failure: the
segment renders a ⚠ error cell and `check` exits 1, naming the variable rather
than the `bg:` that never received a colour. A `default` on the variable is how
you say such a failure is tolerable; without one it is loud. Put the `ramp` in
the segment's `bg:` and read the document field there:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
    budgetColor: {
      kind: "template",
      template: '{{ ramp .budget.spentPct "step" 0 "panel" 80 "error" }}',
    },
  },
  segments: {
    budget: { template: "{{ .budget.spentPct }}% spent", bg: "{{ .budgetColor }}" },
  },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
segment "budget": variable "budgetColor": function "ramp" is not registered (did you mean: wrap, frame?)
```

In a layout node's `when` the call itself is refused, naming the reason:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-status",
      parse: { json: true },
      cache: { ttl: "60s" },
      default: { period: "?", spent: 0, limit: 0, spentPct: 0, timePct: 0 },
    },
  },
  segments: { budget: { template: "{{ .budget.spentPct }}% spent" } },
  root: { rows: { status: { h: [
    "model",
    { seg: "budget", when: '{{ ne (ramp .budget.spentPct "step" 0 "panel") "" }}' },
  ] } } },
}
```

```error
{{ color }} / {{ ramp }} / {{ gauge }} is only available inside a segment's templates — there is no active segment here.
```

### A second placement without an id of its own

```json5 check:fail
{
  segments: { modelTag: { template: "{{ .model.display_name }}" } },
  root: { h: ["modelTag", "modelTag"] },
}
```

```error
root has 2 placements with the id "modelTag"
```

### A placement setting a value outside its domain

```json5 check:fail
{
  segments: {
    modelTag: {
      template: "{{ .model.display_name }}",
      settings: { length: { label: "Length", domain: ["full", "short"], default: "full" } },
    },
  },
  root: { h: [{ seg: "modelTag", settings: { length: "tiny" } }] },
}
```

```error
placement "modelTag" of segment "modelTag" sets "length" to "tiny", but it must be one of "full", "short"
```

### A template reading a setting its segment does not declare

```json5 check:fail
{
  segments: { modelTag: { template: '{{ if .settings.icon }}◆ {{ end }}{{ .model.display_name }}' } },
  root: { h: ["modelTag"] },
}
```

```error
Template reads ".settings.icon", but segment "modelTag" has no setting "icon" (it has: theme, effect)
```

### A segment declaring `theme`

```json5 check:fail
{
  segments: {
    modelTag: {
      template: "{{ .model.display_name }}",
      settings: { theme: { label: "Theme", domain: ["nord", "dracula"], default: "nord" } },
    },
  },
  root: { h: ["modelTag"] },
}
```

```error
setting "theme" is one every placement already has
```

## Before you report done

1. `cc-candybar check <path>` exits 0, and stderr shows no warning you have
   not read — a `source still running after 5000 ms` warning means the bar
   rendered your `default`, or `…` where you declared none, not your data.
2. You ran the real script by hand: one JSON object on stdout, exit 0,
   numbers unquoted, and the daemon can find it by the `command` you wrote.
3. The `default` carries every field any template reads, with placeholder
   values, and you decided what the segment shows while the default is what
   reads — hidden behind a `when` (Step 4), or visible with placeholders.
4. The document's namespace holds only the document: no `budget.*` variable
   beside a `budget` source.
5. Every `ramp` position after `0` that someone might tune is a declared
   numeric variable, and the declared values ascend.
6. The script prints no colour and the template contains no threshold
   cascade; the colour is one `ramp` in `bg:` over one field the script
   printed, and there is no `fg:` — the text is chosen on whatever the ramp
   resolves to.
