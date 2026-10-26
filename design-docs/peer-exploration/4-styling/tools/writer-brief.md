You are writing the summary of a survey of how Claude Code statuslines do their colour and styling. Before writing anything, invoke the Skill tool with `laws:prose` and follow it: the reader is a person.

<requirement>
The user's words, which started the survey: "I want a comprehensive list of all other claude status lines along with how they do styling. No minimum number of stars or anything like that. Thorough is more important than fast."

Why he wants it: he designs the colour system of cc-candybar, a Claude Code statusline. He is deciding three things right now: how neighbouring segments are told apart (lightness steps between neighbours vs. alternating shades), whether particular segments wear an accent colour ("keystones"), and what colour an open menu wears. He has just said "people are going to want consistent colors for specific segments". So the question the survey answers first, for each project, is how a segment gets its colour: fixed per segment, by position, by state, or by theme role.
</requirement>

<deliverable>
Write `/Users/bmf/code/cc-candybar/.claude/worktrees/jiggly-leaping-sunbeam/design-docs/peer-exploration/4-styling/README.md`. It is the entry point to the survey directory and the only file most readers will open. In this order:
1. What was surveyed and how, in a short paragraph: 9,558 projects found (the three `discovery-*.md` files), a script read each one's statusline files and sorted them into tiers (`all-projects.md`), and agents read the code of every system-tier project (1,703: themes, palette files or colour config), the 77 hardcoded-tier projects with 20 or more stars, and a seeded random 100 of the 4,394 hardcoded-tier projects (the long tail). Firecrawl was used for exactly 20 searches, for discovery only.
2. How a segment gets its colour: the taxonomy, with counts and percentages per tier, and one or two exemplars per method.
3. Telling neighbours apart, fill, and separators: counts, and exemplars of each method that is not "different hue plus a separator".
4. Themes, colour depth, light/dark adaptation: counts, and exemplars.
5. What bears on his three decisions and on consistent per-segment colour: what the field does, with the projects that do something he could take or should avoid, each with its anchor. State evidence and what it shows; the decisions are his.
6. A short index of the files in the directory and what each holds, including `rows.tsv` (one row per deep-read project: stars first, then the columns named in `tools/map-brief.md`), `tally.txt` (the counts, from `tools/tally.py`) and `tools/` (the pipeline and the briefs every agent followed).
</deliverable>

<inputs>
All under `/Users/bmf/code/cc-candybar/.claude/worktrees/jiggly-leaping-sunbeam/design-docs/peer-exploration/4-styling` and `/tmp/ccsl/focus`.
- `/tmp/ccsl/focus/tally.txt`: every count and percentage you may use. Each statement of "N projects" or "N%" in the README is copied from it. Never estimate, round up, or compute a count of your own from a focus file, because the focus files are subsets and a count from them is wrong for the tier.
- `/tmp/ccsl/focus/focus-*.tsv`: subsets for finding exemplars, sorted by stars (first column). `role` (segments mapped to theme roles), `position` (colour by place on the bar), `neighbours` (lightness steps or alternating shades), `bgfill` (background-filled cells), `lightdark` (any light/dark handling), `top` (statuslines with 200+ stars). Their columns are named in `/Users/bmf/code/cc-candybar/.claude/worktrees/jiggly-leaping-sunbeam/design-docs/peer-exploration/4-styling/tools/map-brief.md`.
- `/tmp/ccsl/focus/rows.tsv`: every row, if you need one the focus files lack. It is 760 KB; grep it, do not read it whole.
- `/Users/bmf/code/cc-candybar/.claude/worktrees/jiggly-leaping-sunbeam/design-docs/peer-exploration/4-styling/deep/<source>.md`: the full section for each row (the `source` column names the file; the section heading is the `name` column). The TSV fields are summaries cut to 200 characters. Before you cite a project as an exemplar, read its section and take the anchor (file and line) from there.
- The tiers are told apart by the source file name: `batch-*` is the system tier, `sample-*` the random hardcoded sample, `tophard-*` the popular hardcoded projects. Percentages from the sample stand for the whole hardcoded tier; say so, and say the sample is 100 projects.
Work only from these files. Do not fetch anything from the web, and never use any firecrawl tool.
</inputs>

<findings-already-noticed>
Earlier readers flagged these. Verify each against its deep section before using it, and drop any that the section does not bear out:
- Fixed per-type backgrounds make same-family neighbours merge (tylergraydev/claude-code-tool-manager).
- Semantic role palettes: saarshe/claude-code-statusline (7 roles), callmemorgan/claude-statusline (15 roles, per-segment override).
- Two colourways alternating by position plus one accent (the crates.io claude-code-status-line).
- Fixed alert colours with theme-borrowed background and text, because "red meant the wrong thing" (claude-usage-waybar).
- Light/dark detection is rare; the Chris7Ji gist chains COLORFGBG, then the Ghostty config, then the Claude theme.
</findings-already-noticed>

Bad (do NOT write this):
  "Many statuslines use a variety of colour approaches. Popular options include themes and powerline styles, giving users lots of flexibility."
No count, no project, nothing he can check or act on. Good (counts shown as <n>, take the real ones from tally.txt): "Of <N> system-tier statuslines, <n> (<p>%) colour some segment by state, almost always a context-% threshold. Only <n> (<p>%) colour by position; the clearest is <project> (`render.rs:40`: two background shades alternate, the accent goes to the model segment)."

The temptation, about halfway through, will be to walk through project after project because each one is interesting. The deep files already hold every project; this README is the part nobody else will write — the counts, the few exemplars that matter, and what they show. Keep each exemplar to the sentence it earns.

<done>
You are done when the README has the six parts, every count in it appears in `tally.txt`, every exemplar names its deep file and the code anchor from that section, and every finding from the list above is either used (verified) or left out. Reply with the README's path and, in one line each, any listed finding you dropped and why.
</done>
