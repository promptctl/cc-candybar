You are turning deep-read notes on Claude Code statusline projects into one table row per project, so the rows can be counted.

<why>
The user designs the colour system of cc-candybar, a Claude Code statusline. He is deciding how neighbouring segments are told apart (lightness steps vs. alternating shades), whether particular segments wear an accent colour, and what colour open menus wear. He has said "people are going to want consistent colors for specific segments". So the column that matters most is how a segment gets its colour, and it has to be countable across ~1,900 projects.
</why>

<input>
Read each of these files completely: {{FILES}}
Each `## <name>` section is one project. Its ten numbered points follow the same order in every file: 1 segment colour, 2 themes, 3 colour spec and depth, 4 fill, 5 separators, 6 telling neighbours apart, 7 light/dark and contrast, 8 glyphs, 9 other, 10 customisation.
Work only from these files. Do not fetch anything from the web and never use any firecrawl tool. If a point in a section is thin, say so in the row; do not research it.
</input>

<output>
Write {{OUTFILE}} with the Write tool: tab-separated, no header line, one line per `## ` section, in file order. A tab or newline inside a field breaks the table, so never put one there. Keep every free-text field under 200 characters.

Columns, in this order:
1. `source`: the deep file's name, e.g. `batch-07.md`.
2. `name`: the `## ` heading text, exactly.
3. `url`: the project URL from the section's first line.
4. `kind`: one of `statusline`, `not-statusline`, `fork-diff` (a section that reports only differences from a parent), `copy` (marked as a copy of another project), `unreachable`.
5. `seg`: how a segment gets its colour, as one or more of these codes joined with `+`, most important first: `fixed` (each segment type has its own colour), `state` (colour by value or threshold: context %, cost, git dirty), `position` (by place on the bar: alternating, cycling, gradient along the bar), `role` (segments map to theme roles like primary/accent and a theme supplies the colours), `user` (every segment's colour is set by the user's config with no meaningful default), `single` (one colour for everything), `none` (no colour). Example: `fixed+state`. Write `-` for not-statusline or unreachable.
6. `seg_detail`: the mapping in short, with its file anchor. Example: `colors.ts:12 model=cyan git=green; context <50 green <80 yellow else red`.
7. `themes`: `none`, or a count and the format: `N:segmap` (each theme is a per-segment colour map), `N:roles` (semantic palette roles), `N:palette` (a named colour list that segments index into), plus `+custom` when users can define their own. Example: `12:roles+custom`. Add up to three theme names after a space.
8. `depth`: colour spec and handling, as codes joined with `+`: `16`, `256`, `hex`; `detect` (it detects colour depth), `downsample` (it converts to a lower depth); `nocolor` (it honours NO_COLOR). Example: `hex+256+detect+nocolor`.
9. `fill`: `bg` (background-filled cells), `fg` (text on the terminal's own background), `both` (both modes, or both in one bar), `-`.
10. `sep`: `powerline`, `caps` (rounded or other end caps), `text` (plain-text separators like `|`), `none`, joined with `+`, then a few words on how a separator's colours are chosen.
11. `neighbours`: how adjacent segments are told apart, as codes joined with `+`: `hue` (different hues), `lightness` (lightness steps), `alternate` (alternating two shades), `separator` (separators only), `none`. Then a few words.
12. `lightdark`: `none`, or what it does: `detect` (detects terminal background), `light-themes` (ships light themes), `contrast` (picks readable text per background), joined with `+`, then a few words with the anchor.
13. `notable`: anything a colour-system designer would want to look at, with its anchor: gradients, per-model colours, an accent keystone, a colour editor, a reason given in the code for a colour choice. `-` if nothing.
</output>

Bad row (do NOT produce this):
`batch-07.md	foo	https://github.com/a/foo	statusline	colorful	nice colours per segment	yes	truecolor	yes	arrows	different colours	no	themes`
`colorful` and `yes` are not codes, so the row cannot be counted; nothing is anchored.

Good row:
`batch-07.md	foo	https://github.com/a/foo	statusline	fixed+state	colors.ts:12 model=cyan git=green; context <50 green <80 yellow else red	3:segmap+custom dark light nord	hex+256+detect	bg	powerline arrow fg = left cell bg (render.ts:88)	hue+separator distinct bg per segment	light-themes ships light theme only	model colour varies by family opus=purple (models.ts:5)`

<done>
You are done when, for each input file, the number of lines in your output whose first column is that file equals that file's count of lines starting with `## `. Count them yourself before finishing (`grep -c '^## ' <file>` and `cut -f1 <outfile> | sort | uniq -c`). Reply with only the output path and the row count per input file.
</done>
