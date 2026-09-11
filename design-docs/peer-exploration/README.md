# Peer exploration

A staged survey of projects adjacent to cc-candybar, run to mine them for ideas on
performance, widgets, UX, and unique features.

Staged deliberately: each stage narrows the field and deepens the reading, and each
stage's output is a document in this directory that the next stage consumes.

## Stages

| Stage | Directory | Output |
|-------|-----------|--------|
| 1. Candidates | `1-candidates/` | One file per territory, listing projects with a name, URL, verified stats, a description, and what makes each interesting. |
| 2. Categorized | `2-categorized/` | [`four-axes.md`](2-categorized/four-axes.md) — all 44 judged on primitives, UX, uniqueness, and polished-versus-hacky, plus a licence-risk table. |

Later stages are added here as they are run.

## Scope

Two territories are in scope.

| File | Territory | Projects |
|------|-----------|----------|
| `claude-code-statuslines.md` | cc-candybar's own niche: tools Claude Code invokes via the `statusLine` setting, plus usage trackers with a statusline mode and HUD plugins. | 24 |
| `perf-daemons.md` | The performance substrate: projects whose reason to exist is making a repeated computation cheap enough to run on every prompt or every second. | 20 |

The first territory is the peer set. The second is not a peer set at all and is kept
for a different reason: cc-candybar's open problems are a high git-subprocess rate, an
unexplained gap between JavaScript heap and resident memory, and every cache rebuilding
cold on daemon restart. These are solved problems elsewhere, and that file is where the
solutions are catalogued.

A wider stage-1 sweep also covered shell prompts, multiplexer bars, desktop bars, editor
statuslines, terminal interaction, config languages, and status bars for other AI coding
agents. Those were cut as too far from cc-candybar to be worth the reading time. They
remain in git history at commit `d7fed0a` if a later stage wants them back.

## Verification

Every star count, commit count and last-push date was read from the GitHub API rather
than from a page or from a model's memory. Commit counts come from the `rel="last"` page
number of a one-per-page commits request, which makes the last page number equal the
total.

Every surviving entry was re-queried against the API after the survey and every claimed
figure matched. Anything that could not be verified is marked `unverified` rather than
estimated.

Entries must also earn their category. `abtop` was removed from the Claude Code file
because it is a full-screen session monitor rather than a statusline, however
interesting its session discovery is.
