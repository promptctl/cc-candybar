<!--
  Segment authoring reference — written for an AGENT config author.

  Snippet contract (enforced by test/doc-snippets.test.ts):
    ```json5 check:pass   — a COMPLETE config file; must exit 0 under `cc-candybar check`.
    ```json5 check:fail   — a COMPLETE config file; must exit 1, and the next
    ```error              — block must quote a substring of check's actual stderr.
    ```sh stub:<name>     — an executable named <name>, written verbatim onto PATH
                            before any snippet runs; a `shell` snippet may run it.
  Every ```json5 block in this file MUST carry one of the two annotations.
  Do not edit a snippet or a quoted error without running the test — the quoted
  strings are asserted against the real loader, not transcribed.
-->

# Segment authoring: a script, a source, a segment, a ramp

You are adding a segment whose data comes from **your own program** — a
budget tracker, a queue depth, a deploy status — to a bar you cannot see
rendered. The whole job is four declarations: a script that prints one JSON
document, a `shell` variable that runs it and parses that document, a segment
template that reads the document's fields by dotted path, and a `ramp` in the
segment's `bg:` that turns one of those numbers into a theme colour. The
script never chooses a colour and the template never branches on thresholds:
the colour decision lives in the theme system, so it follows a theme click
and a look exactly as the built-in segments do.

Your eyes are `cc-candybar check`'s exit code and stderr:

```
edit config  →  cc-candybar check <path>  →  read exit code + stderr  →  repeat
```

| exit | meaning |
|------|---------|
| 0 | config loads and renders — warnings (advisory only) on stderr |
| 1 | config is invalid, or a segment's template throws at evaluation (the daemon would render a `⚠` cell) — stderr names the path and the fix |
| 2 | usage error / the named file could not be read |

`check` runs the daemon's exact pipeline (parse → merge on the bundled
default → validate → register → render against a representative payload). It
**runs your `shell` and `file` sources** and waits up to 5 s for their first
runs; a source still running at the deadline is reported as a warning and the
bar renders with that variable's `default`. A user config merges onto the
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

The command runs under `/bin/sh -c` with the daemon's environment, so the
script is either on the daemon's `PATH` or spelled as an absolute path. A
command the shell cannot find fails its run with `exited with code 127`, and
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

The complete shape of a `shell` variable:

| field | value |
|---|---|
| `kind` | `"shell"` |
| `command` | the command line, run by `/bin/sh -c` |
| `parse` | absent or `{ text: true }` → the trimmed text, line breaks folded to spaces; `{ regex: "…" }` → capture group 1 of the text; `{ json: true }` → the text parsed once as a document. Exactly one key. |
| `cache` | **required** — exactly one of `{ ttl: "60s" }` (re-run on a timer; units `ms`/`s`/`m`/`h`; a shell `ttl` below 500 ms is silently raised to 500 ms), `{ watch_file: "/abs/path" }` (re-run when that file changes), `{ depends_on: ["otherVar"] }` (re-run when a declared variable changes), `{ key: "{{ .otherVar }}" }` (re-run when the key template's value changes), `{ never: true }` (run once) |
| `default` | what the variable reads until the first run completes and whenever a run fails. Under `text`/`regex` it is a string; under `json` it is a JSON value — normally the document shape, every field your templates read, with placeholder values |

A `file` variable is the same declaration with `path` (absolute — `~` is not
expanded; write the full path) in place of `command`, plus an
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
whose run fails — the script is missing, exits non-zero, prints something that
is not JSON — has no document to read, and every segment reading it renders a
`⚠` cell that `check` fails on. A `text`/`regex` source with no `default`
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
document, `.budget.warnAt` is a field read, and a sibling variable spelled
`budget.warnAt` is accepted by the loader and unreachable at render (Mistakes,
below).

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
      template: '{{ .budget.period }} ${{ printf "%.2f" .budget.spent }}/{{ .budget.limit }} · {{ .budget.spentPct }}% spent · {{ .budget.timePct }}% elapsed{{ if gt .budget.spentPct .budget.timePct }} ⚑{{ end }}',
      when: "{{ gt .budget.limit 0 }}",
    },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

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
so the colour follows a theme click and a look. The easing is one of two
words: `"step"` holds each stop's colour until the next position — a
`≥ threshold → next colour` cascade written as data — and `"linear"` blends
between neighbouring stops in OKLCH. Positions are required, must ascend, and
the value clamps at both ends; a value exactly on a stop is that stop's colour.

Every position anyone might tune is a **declared variable** riding in the
position slot; the only literal positions are the fixed ends of the value's
domain (`0`, and `100` for a percentage). The knob is then one number to
edit, and `check` refuses a descending pair loudly instead of sorting the
stops into a ramp you did not write. The one-threshold form — calm until the
knob, the warning colour from there:

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
      bg: '{{ ramp .budget.spentPct "step" 0 "panel" .budgetWarnAt "warning" }}',
    },
  },
  root: { rows: { status: { h: ["model", "context", "budget"] } } },
}
```

The complete budget bar, placed in the full bundled status row — the pattern
the bundled `block` and `weekly` segments use: two knobs, a `bg:` cascade
calm → `warning` → `error`, an `fg:` that flips to the button foreground at
the first knob because the theme's `foreground` is not guaranteed readable on
`warning`/`error`, and the `when` gate from Step 4:

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
      bg: '{{ ramp .budget.spentPct "step" 0 "panel" .budgetHeatAt "warning" .budgetWarnAt "error" }}',
      fg: '{{ ramp .budget.spentPct "step" 0 "foreground" .budgetHeatAt "button-color-foreground" }}',
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

## Mistakes and the errors they produce

Each entry: the wrong config, then the text `cc-candybar check` prints. The
first six are load errors — the config never renders. The rest are render
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

Paths are absolute and `~` is not expanded, so the file is unreadable. This
one is a render error, and only because the source declares no `default` —
with one, the default would read forever and nothing would say why:

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
segment "budget": variable "budget": file unreadable: ~/.cache/budget/status.json
```

### A `json` source whose script prints something that is not JSON, with no `default`

The stand-in for a script that has broken:

```sh stub:budget-broken
#!/bin/sh
echo 'budget: unavailable'
```

Every segment reading the document renders `⚠` naming the variable, then the
reason: `JSON parse failed: Unexpected token 'b', "budget: unavailable` for
this script, `shell "budget-broken" exited with code 127` for one the shell
cannot find, `file unreadable: <path>` for a `file` source. A `default` would
render instead, quietly — which is what you want in the bar, and why the
mistake to avoid is the missing `default`, not the broken script:

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
one — a template reaching a field the default lacks throws. Here the script
is the broken one, so the default renders under `check`; with a working
script this passes `check` and fails at daemon start instead. A typo in a
field name (`.budget.spentPercent`) prints the same text:

```json5 check:fail
{
  variables: {
    budget: {
      kind: "shell",
      command: "budget-broken",
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

`budget.warnAt` is a legal variable name and the loader accepts it, but with
`budget` a document, `.budget.warnAt` is a read of the document's `warnAt`
field, which the script does not print. Move the knob out of the namespace
(`budgetWarnAt`):

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
      bg: '{{ ramp .budget.spentPct "step" 0 "panel" .budget.warnAt "error" }}',
    },
  },
  root: { rows: { status: { h: ["model", "budget"] } } },
}
```

```error
segment "budget": field "budget.warnAt" not found on receiver
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
      bg: '{{ ramp .budget.spentPct "step" 0 "panel" .budgetWarnAt "error" }}',
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
      bg: '{{ ramp .budget.spentPct "step" 0 "panel" 50 "warning" .budgetWarnAt "error" }}',
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
      bg: '{{ ramp .budget.spentPct "step" 0 "panel" .budgetWarnAt }}',
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

In a variable template there is no segment to take a palette from. The
variable does not error: it evaluates to its default (empty), and the failure
surfaces wherever that empty string lands — in a `bg:` as an invalid colour.
Had the variable been read in the template body instead, the segment would
have rendered with a blank where the colour was and `check` would have
passed, so put the `ramp` in the segment's `bg:` and read the document field
there:

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
Invalid bg color "": color reference "" did not resolve
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
{{ color }} / {{ ramp }} is only available inside a segment's templates — there is no active segment here.
```

## Before you report done

1. `cc-candybar check <path>` exits 0, and stderr shows no warning you have
   not read — a `source still running after 5000 ms` warning means the bar
   rendered your `default`, not your data.
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
   cascade; the colour is one `ramp` in `bg:` (and `fg:` if the hot
   background needs it) over one field the script printed.
