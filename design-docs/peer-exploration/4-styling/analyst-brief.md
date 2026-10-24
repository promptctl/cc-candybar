You are documenting how a batch of Claude Code statusline projects do their styling, read from their own source code.

<requirement>
The user's words: "I want a comprehensive list of all other claude status lines along with how they do styling. No minimum number of stars or anything like that. Thorough is more important than fast." And: "I do have limited firecrawl credit so use web search or web fetch to get content and use firecrawl specifically for searching."

Why: the user designs the colour system of cc-candybar, a Claude Code statusline. Right now he is deciding how neighbouring segments are told apart (lightness steps vs. alternating shades), whether particular segments wear an accent colour, and what colour open menus wear. He has just noted that "people are going to want consistent colors for specific segments". So the most valuable fact about each project is how a segment gets its colour: fixed per segment, by position, by state, or by theme role.
</requirement>

<batch>
{{BATCH}}
</batch>

<method>
Read each project's actual styling code, not just its README. Each batch entry lists the files a scanning script already read, and counts of the colour signals it found (e.g. `color.bg_truecolor=19` means 19 lines writing truecolor backgrounds). These tell you where to look. They are not your answer.
Fetch file bytes with `curl -sL https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>`, which costs no API quota. Use `gh api repos/<owner>/<repo>/git/trees/HEAD?recursive=1 --jq '.tree[].path'` only when you need a file the list doesn't name. The GitHub API quota is shared with many agents running at once, so keep `gh api` calls to a few per project. For gists, use `gh api gists/<id>`. For other hosts, use WebFetch or curl. Never use any firecrawl tool: credits are limited and searching is done.
The scanner flagged these projects by keywords, so some aren't Claude Code statuslines at all (e.g. a Claude Code mod that colours a diff view, or a pet animation). For those, write the section as one line: `not a Claude statusline: <what it is>`. For an entry marked FORK OF, report only the styling that differs from the parent.
Keep each Bash command simple: one command per call, no `cd`, no long pipelines. The sandbox refuses complex compound commands.
A project you can't reach (deleted repo, 404) still gets its section, saying so.
</method>

<per-project>
For every project in the batch, record what its code does on each point below. Anchor each answer to the file (and line or key) it came from. Write `not present` when the project lacks the feature. Write `unverified (README only)` when you could only find a claim.
1. How a segment gets its colour: fixed per segment (e.g. git is always green); by position (alternating, cycling, gradient along the bar); by state or threshold (context %, cost); a theme role mapped to segments; or one colour for everything / no colour. Give the actual mapping where it's short.
2. Themes: whether themes are bundled (how many, names), the theme format (per-segment colour map, or semantic palette roles like primary/accent), and whether users can define their own.
3. Colour spec and depth: named ANSI 16 / 256 index / truecolor hex; whether it detects or downsamples colour depth; whether it honours NO_COLOR.
4. Fill: background-filled cells, foreground-only text on the terminal's own background, or both.
5. Separators: powerline arrows, rounded or other caps, plain-text separators; how a separator's colours are chosen.
6. Telling neighbours apart: how adjacent segments are made distinct, if at all (different hues, lightness steps, alternating two shades, separators only).
7. Light/dark terminal adaptation and text contrast: anything that picks a readable text colour or adapts to the terminal background.
8. Icons and glyphs: Nerd Font, emoji, ASCII fallback modes.
9. Anything else styling-related that stands out: gradients, rainbow, animation, blinking, per-model colours, colour editor UI, web configurator, screenshots gallery.
10. Customisation surface: config file format, TUI, CLI flags, environment variables.
</per-project>

<output>
Write {{OUTFILE}} with the Write tool: one `## <name>` section per project, in batch order, each starting with its URL and stars or "n/a". Under each, write the ten points as a compact list.

Bad output (do NOT produce this):
  ## foo-statusline
  Uses nice colors and powerline style. Highly customizable with themes.
It names nothing a reader can act on or check. Good output says, for example: "1. fixed per segment: `colors.ts:12` maps model→cyan, git→green, context→threshold (<50% green, <80% yellow, else red) …".
</output>

<done>
You're done when every project in the batch has a section that either answers all ten points (each with a file anchor, `not present`, `unverified (README only)` or `unreachable`), or is a one-line `not a Claude statusline` or fork-differences verdict. Before finishing, re-read your file against that list. Reply with only the file path and the count of sections written.
</done>
