## yasuhisay.info/entry/2025/08/21/211402
URL: https://www.yasuhisay.info/entry/2025/08/21/211402 — stars n/a. A blog post configuring the third-party ccstatusline via `.config/ccstatusline/config.yaml` (as quoted in the article; ccstatusline itself is not examined here).
1. Fixed per segment, set by a `color` field on each custom-command item: Session ID `color: "bg_magenta"`, PR URL `bg_magenta`, "current mood" (read from a file) `bg_black`. Only these three are shown (article config block). No state/threshold colouring; the PR-checks item uses emoji (✅/❌) rather than colour for state.
2. Themes: not present in the article (it is ccstatusline's own concern; article does not discuss).
3. Colour spec: ccstatusline named keys (`bg_magenta`, `bg_black`); the article does not list the available names. Depth detection / NO_COLOR: not present.
4. Fill: background fill implied by the `bg_*` names; otherwise unverified (article gives no rendering detail).
5. Separators: not present in the article.
6. Neighbour distinction: not present (only that different items get different bg names).
7. Light/dark / contrast: not present.
8. Glyphs: emoji ✅/❌ for PR check state; text label via `prefix: "セッション: "`, `"ブランチ: "`, `"Actions Status: "`. A cited tweet shows `PR Status🔵🟣⚫` (unused by the article).
9. Nothing else styling-related.
10. Customisation: ccstatusline YAML config per item (`color`, `prefix`, command); `settings.json` statusLine with `"padding": 0`.

## zenn.dev/kkouhei/articles/claude-code-statusline-tips
URL: https://zenn.dev/kkouhei/articles/claude-code-statusline-tips — stars n/a. Bash tips article with a hand-written script.
1. By threshold, context % only: `pct < 50` green `\033[32m`, `< 80` yellow `\033[33m`, else red `\033[31m` (script in article). All other segments uncoloured; segments identified by emoji (🤖 model, 📂 dir, 💭 context, 💸 cost).
2. Themes: not present.
3. Colour spec: ANSI 16 (`\033[32m/33m/31m`, reset `\033[0m`). Article states the statusline supports 16/256/true colour. No detection or downsampling; NO_COLOR not present.
4. Fill: foreground-only text (colour applied to the bar and percentage via `printf "Context: ${color}%s${reset} %d%%"`).
5. Separators: plain middle dot ` · ` in `printf "🤖 %s · 📂 %s · 💭 %.0f%% · 💸 \$%.3f\n"`. Article mentions ccstatusline offers Powerline arrows and gradients (unverified, README-level claim only).
6. Neighbours: only the `·` separator and emoji prefixes; no colour distinction.
7. Light/dark or contrast: not present.
8. Glyphs: emoji (🤖📂💭💸); progress bar `█` filled / `░` empty, 10 cells, `filled=$((pct/10))`. Sample: `Context: ████░░░░░░ 42%`. No ASCII fallback.
9. Nothing else beyond the threshold-colour bar.
10. Customisation: edit the shell script; `settings.json` `statusLine` with `type: command`, `command`, `padding: 0` (recommended), optional `refreshInterval`.

## zenn.dev/tottoko_hamu/articles/2026-06-28-090000
URL: https://zenn.dev/tottoko_hamu/articles/2026-06-28-090000 — stars n/a. Bash statusline article with extras (GTD counts, music, burn rate).
1. By threshold on the context and rate-limit bars: author's `pct_int <= 59` green `\033[32m`, `<= 79` yellow `\033[33m`, else red `\033[31m`. Official-docs example cited uses 70/90; the prompt template says 60/80. A suggested (unimplemented) idea: show context as a red band only above 80%. Other segments (model, time, git counts) shown uncoloured; identified by labels (`Ctx:`, `5h:`, `7d:`) and emoji.
2. Themes: not present.
3. Colour spec: ANSI 16 only (`\033[32m` etc., reset `\033[0m` named but not shown used). No depth detection; NO_COLOR not present.
4. Fill: foreground-only.
5. Separators: two spaces between segments via `printf "%s  Ctx:%s  5h:%s  7d:%s  %s"`; lines joined with newlines, each optional line only when non-empty. Inner separators `S:0 U:1 A:0`, `+42 -7`, em dash between track and artist.
6. Neighbours: whitespace only; bars distinguished by label text, not colour.
7. Light/dark or contrast: not present.
8. Glyphs: bars `Ctx:[███░░░░░░░] 34%` using `█` and `░` (10 cells; the drawing function is not shown); emoji 📥🎯⏳🌈🔁📁📎 for GTD, 🎯 current task, ♫ now playing, 🔥 burn rate `$0.12/hr`.
9. Nothing else beyond the above.
10. Customisation: edit the shell script; `settings.json` `statusLine` with `type: command`, `command: ~/.claude/statusline.sh`, `padding: 2`.
