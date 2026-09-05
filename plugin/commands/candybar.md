---
name: candybar
description: CC Candybar statusline setup wizard
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Glob
---

# CC Candybar Setup Wizard

You are running an interactive setup wizard to configure the cc-candybar statusline for Claude Code. Follow the steps in order, using AskUserQuestion at each decision point.

## Operating rules

- One question per step. Wait for the user's answer before moving on. Do not skip or combine steps.
- Track the user's choices as four variables: `charset`, `theme`, `style`, `preset`. Every later command and the final config are built from exactly those four.
- Do NOT use the Agent tool or Explore subagents. Everything you need is in this document.
- Do NOT read source code from the cc-candybar package. Run only the subcommands this document names (`install`, `check`) and the plugin's preview script against it.
- IMPORTANT: After running any Bash or Read tool, repeat the key output as text in your response. Some users have a collapsed UI mode where tool outputs need a click to expand. Relay versions, option names, file paths, and command results in your text so the user sees them without expanding.
- Two things this wizard never does, however natural they feel in the moment: it never edits `~/.claude/settings.json` by hand (Step 9's installer writes that entry), and it never carries its own list of theme names (Step 3's preview output is the list).

## Step 1: Check Node.js

The runtime needs Node.js **20.19 or later within the 20.x line, or 22.12 or later**. Run:

```bash
node --version 2>/dev/null || echo "not_installed"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===20&&b>=19)||(a>=22&&(a>22||b>=12))?0:1)' 2>/dev/null && echo "version_ok" || echo "version_too_old_or_missing"
```

Tell the user the detected version in your text.

### If the second line printed `version_too_old_or_missing`

Display:

````markdown
CC Candybar requires **Node.js 20.19+ (20.x line) or 22.12+**.

Install it from https://nodejs.org or via your package manager:

```bash
# macOS
brew install node

# Ubuntu/Debian (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```
````

Then ask:

- **Question**: "Install Node.js or check again?"
- **Header**: "Node.js"
- **Options**:
  - "I installed it, check again" -> Re-run Step 1 from the top
  - "Exit wizard" -> Tell them to install a supported Node.js and rerun `/candybar`, then stop

### If it printed `version_ok`

Continue to Step 2.

## Step 2: Nerd Font Detection

> [!IMPORTANT]
> You cannot display nerd font glyphs in your text output.
> You MUST run the cat command below and let the terminal render it.
> After running it, tell the user to expand the bash output if they cannot see the glyphs.

```bash
cat ${CLAUDE_PLUGIN_ROOT}/templates/nerd-fonts-sample.txt
```

Tell the user: "Check the bash output above. The powerline line should show arrow-shaped joiners between the words and the capsule line should show half-circle caps around them. You may need to click/expand the bash output to see them."

Then ask:

- **Question**: "Do the powerline arrows and capsule half-circles render as shapes?"
- **Header**: "Nerd Font"
- **Options**:
  - "Yes, I see arrows and half-circles" -> Set `charset=unicode`
  - "No, I see boxes, blanks, or question marks" -> Set `charset=ascii`

## Step 3: Theme

> [!IMPORTANT]
> You cannot render ANSI escape codes in your text output.
> You MUST run the preview command below and let the terminal display the result.
> Do NOT describe what the themes look like. Let the user see them.
> After running, tell the user to expand the bash output if they cannot see the previews.

```bash
${CLAUDE_PLUGIN_ROOT}/bin/preview.sh --compare-themes --charset=${charset}
```

The output is one block per theme: a label line of the theme's name followed by a colon, then that theme's rendered bar. That label list is the theme list; there is no other. List the labeled names in your text (names only, in the order printed) and tell the user the previews are in the bash output above.

Then ask:

- **Question**: "Which theme? Pick one or type any name from the preview."
- **Header**: "Theme"
- **Options**: the first four labeled names from the preview output, each -> Set `theme=<that name>`

If the user types a name in the free text field, accept it only if the preview labeled it; otherwise show the labeled names again and re-ask. Set `theme`.

## Step 4: Style

> [!IMPORTANT]
> You cannot render ANSI escape codes or nerd font glyphs in your text output.
> You MUST run the preview command below and let the terminal display the result.
> Do NOT describe what the styles look like. Let the user see them.
> After running, tell the user to expand the bash output if they cannot see the previews.

```bash
${CLAUDE_PLUGIN_ROOT}/bin/preview.sh --compare-styles --theme=${theme} --charset=${charset}
```

Tell the user: "The three style previews are in the bash output above, each under its name. Expand it if needed."

Then ask:

- **Question**: "Which style?"
- **Header**: "Style"
- **Options**:
  - "powerline" -> Set `style=powerline`
  - "capsule" -> Set `style=capsule`
  - "plain" -> Set `style=plain`

## Step 5: Preset

The preset is the bar's arrangement: which segments, on how many rows.

> [!IMPORTANT]
> You cannot render ANSI escape codes or nerd font glyphs in your text output.
> You MUST run the preview command below and let the terminal display the result.
> Do NOT describe what the presets look like. Let the user see them.
> After running, tell the user to expand the bash output if they cannot see the previews.

```bash
${CLAUDE_PLUGIN_ROOT}/bin/preview.sh --compare-presets --theme=${theme} --style=${style} --charset=${charset}
```

Tell the user the previews are in the bash output above, then display:

````markdown
**Presets:**

1. **default** -- Two rows: an identity row (directory, git, toolbar) over a status row (model, context window, cache timer, 5-hour block usage, weekly usage). Good default.
2. **compact** -- One row (directory, git, context window) with no cell padding. For narrow terminals and split panes.
3. **verbose** -- The default's two rows plus pull-request, burn-rate, token-speed and token-sparkline segments. Maximum information.
````

Then ask:

- **Question**: "Which preset?"
- **Header**: "Preset"
- **Options**:
  - "default" -> Set `preset=default`
  - "compact" -> Set `preset=compact`
  - "verbose" -> Set `preset=verbose`

## Step 6: Existing config

The config file is `~/.config/cc-candybar/config.json5`. A `config.json` beside it at the same location is a collision the bar warns about, so check for both:

```bash
test -f ~/.config/cc-candybar/config.json5 && echo "json5_exists" || echo "json5_not_found"
test -f ~/.config/cc-candybar/config.json && echo "json_exists" || echo "json_not_found"
```

If neither exists, continue to Step 7. If either exists, name the file(s) found and ask:

- **Question**: "Found an existing cc-candybar config. What should I do?"
- **Header**: "Existing Config"
- **Options**:
  - "Replace it" -> If `config.json` exists, run `mv ~/.config/cc-candybar/config.json ~/.config/cc-candybar/config.json.bak.${stamp}` so it cannot shadow the new file. Continue to Step 7 (which overwrites `config.json5`).
  - "Back it up first" -> Run `cp ~/.config/cc-candybar/config.json5 ~/.config/cc-candybar/config.json5.bak.${stamp}` if `config.json5` exists. Then proceed exactly as "Replace it".
  - "Keep it and exit" -> Tell the user nothing was changed and stop.

Every backup name carries `${stamp}`, so a later wizard run never overwrites an earlier backup. Compute it as the first line of the same Bash call as the `cp`/`mv` (shell variables do not survive between calls), and name the backup path(s) in your text afterwards:

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
```

## Step 7: Write the config

1. Read the template with the Read tool:

   ```text
   ${CLAUDE_PLUGIN_ROOT}/templates/config.json
   ```

2. Replace the four placeholders in the template content:

   | Placeholder | Replace with |
   |-------------|--------------|
   | `replace:THEME` | `theme` (the name chosen in Step 3) |
   | `replace:STYLE` | `style` (`powerline`, `capsule`, or `plain`) |
   | `replace:CHARSET` | `charset` (`unicode` or `ascii`) |
   | `replace:PRESET` | `preset` (`default`, `compact`, or `verbose`) |

3. Write the result to `~/.config/cc-candybar/config.json5` with the Write tool (create the directory if needed). Do NOT read or merge with any existing config; the file is replaced whole.

## Step 8: Verify

Check that the written config loads:

```bash
npx -y @promptctl/cc-candybar@latest check ~/.config/cc-candybar/config.json5
```

Exit 0 and a `✓` line mean the config loads. A `✗` block names the problem: show it to the user verbatim and stop. Do not continue to the installer, the preview or the success message, and do not claim the setup worked.

## Step 9: Install the runtime

```bash
npx -y @promptctl/cc-candybar@latest install
```

This stages the runtime and writes the `statusLine` entry into `~/.claude/settings.json` itself. Relay the command's output in your text. If it exits non-zero, show the error and stop; do not open settings.json to finish the job by hand.

Exit 0 has two outcomes, told apart by the output:

- A line beginning `Updated ` followed by the settings path: settings.json was written. Continue to Step 10.
- `Skipping settings.json update: existing statusLine.command appears customized.` followed by a `Current:` line: the installer found a statusLine command it did not write and left it alone. Relay the `Current:` command in your text, then ask:
  - **Question**: "Your settings.json already has a statusLine command. Replace it with cc-candybar?"
  - **Header**: "statusLine"
  - **Options**:
    - "Replace it with cc-candybar" -> Run `npx -y @promptctl/cc-candybar@latest install --force`, relay its output, and continue to Step 10.
    - "Keep my existing statusLine" -> Continue to Step 10; the success message says the bar is not wired up.

## Step 10: Preview

> [!IMPORTANT]
> You cannot render ANSI escape codes or nerd font glyphs in your text output.
> You MUST run the preview command below and let the terminal display the result.
> After running, tell the user to expand the bash output if they cannot see the preview.

```bash
${CLAUDE_PLUGIN_ROOT}/bin/preview.sh --theme=${theme} --style=${style} --charset=${charset} --preset=${preset}
```

Tell the user: "Your statusline is in the bash output above. Expand it if needed."

## Step 11: Success message

Display the message below. The `~/.claude/settings.json` line under **Files written** belongs there only if Step 9 printed `Updated `. If the user kept their existing statusLine, drop that line and make item 1 of **What now**: "Your existing statusLine was left in place, so the bar will not appear until `statusLine.command` in `~/.claude/settings.json` points at cc-candybar. Rerun `/candybar` and choose Replace to have the installer do it."

````markdown
Setup complete.

**Files written:**
- `~/.config/cc-candybar/config.json5` (your candybar config)
- `~/.claude/settings.json` (`statusLine` entry, written by the installer)

**What now:**
1. Restart Claude Code if the statusline does not appear.
2. The bar has its own settings menu: click `☰ ▸` on the bar to switch theme, look, style, wrap, padding and preset live. Tick `persist?` there to make a choice the durable default.
3. Hand edits to `~/.config/cc-candybar/config.json5` hot-reload; no restart needed.
4. Run `/candybar` any time to rerun this wizard.

Documentation: https://github.com/promptctl/cc-candybar
````
