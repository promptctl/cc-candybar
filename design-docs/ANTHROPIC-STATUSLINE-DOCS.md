> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Customize your status line

> Configure a custom status bar to monitor context window usage, costs, and git status in Claude Code

The status line is a customizable bar at the bottom of Claude Code that runs any shell script you configure. It receives JSON session data on stdin and displays whatever your script prints, giving you a persistent, at-a-glance view of context usage, costs, git status, or anything else you want to track.

Status lines are useful when you:

* Want to monitor context window usage as you work
* Need to track session costs
* Work across multiple sessions and need to distinguish them
* Want git branch and status always visible

Here's an example of a [multi-line status line](#display-multiple-lines) that displays git info on the first line and a color-coded context bar on the second.

<Frame>
  <img src="https://mintcdn.com/claude-code/nibzesLaJVh4ydOq/images/statusline-multiline.png?fit=max&auto=format&n=nibzesLaJVh4ydOq&q=85&s=60f11387658acc9ff75158ae85f2ac87" alt="A multi-line status line showing model name, directory, git branch on the first line, and a context usage progress bar with cost and duration on the second line" width="776" height="212" data-path="images/statusline-multiline.png" />
</Frame>

This page walks through [setting up a basic status line](#set-up-a-status-line), explains [how the data flows](#how-status-lines-work) from Claude Code to your script, lists [all the fields you can display](#available-data), and provides [ready-to-use examples](#examples) for common patterns like git status, cost tracking, and progress bars.

## Set up a status line

Use the [`/statusline` command](#use-the-%2Fstatusline-command) to have Claude Code generate a script for you, or [manually create a script](#manually-configure-a-status-line) and add it to your settings.

### Use the /statusline command

The `/statusline` command accepts natural language instructions describing what you want displayed. Claude Code generates a script file in `~/.claude/` and updates your settings automatically:

```text theme={null}
/statusline show model name and context percentage with a progress bar
```

### Manually configure a status line

Add a `statusLine` field to your user settings (`~/.claude/settings.json`, where `~` is your home directory) or [project settings](/en/settings#settings-files). Set `type` to `"command"` and point `command` to a script path or an inline shell command. For a full walkthrough of creating a script, see [Build a status line step by step](#build-a-status-line-step-by-step).

```json theme={null}
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 2
  }
}
```

The `command` field runs in a shell, so you can also use inline commands instead of a script file. This example uses `jq` to parse the JSON input and display the model name and context percentage:

```json theme={null}
{
  "statusLine": {
    "type": "command",
    "command": "jq -r '\"[\\(.model.display_name)] \\(.context_window.used_percentage // 0)% context\"'"
  }
}
```

The optional `padding` field adds extra horizontal spacing (in characters) to the status line content. Defaults to `0`. This padding is in addition to the interface's built-in spacing, so it controls relative indentation rather than absolute distance from the terminal edge.

The optional `refreshInterval` field re-runs your command every N seconds in addition to the [event-driven updates](#how-status-lines-work). The minimum is `1`. Set this when your status line shows time-based data such as a clock, or when background subagents change git state while the main session is idle. Leave it unset to run only on events.

The optional `hideVimModeIndicator` field suppresses the built-in `-- INSERT --` text below the prompt. Set this to `true` when your script renders [`vim.mode`](#available-data) itself, so the mode is not shown twice.

### Disable the status line

Run `/statusline` and ask it to remove or clear your status line (e.g., `/statusline delete`, `/statusline clear`, `/statusline remove it`). You can also manually delete the `statusLine` field from your settings.json.

## Build a status line step by step

This walkthrough shows what's happening under the hood by manually creating a status line that displays the current model, working directory, and context window usage percentage.

<Note>Running [`/statusline`](#use-the-%2Fstatusline-command) with a description of what you want configures all of this for you automatically.</Note>

These examples use Bash scripts, which work on macOS and Linux. On Windows, see [Windows configuration](#windows-configuration) for PowerShell and Git Bash examples.

<Frame>
  <img src="https://mintcdn.com/claude-code/nibzesLaJVh4ydOq/images/statusline-quickstart.png?fit=max&auto=format&n=nibzesLaJVh4ydOq&q=85&s=696445e59ca0059213250651ad23db6b" alt="A status line showing model name, directory, and context percentage" width="726" height="164" data-path="images/statusline-quickstart.png" />
</Frame>

<Steps>
  <Step title="Create a script that reads JSON and prints output">
    Claude Code sends JSON data to your script via stdin. This script uses [`jq`](https://jqlang.github.io/jq/), a command-line JSON parser you may need to install, to extract the model name, directory, and context percentage, then prints a formatted line.

    Save this to `~/.claude/statusline.sh` (where `~` is your home directory, such as `/Users/username` on macOS or `/home/username` on Linux):

    ```bash theme={null}
    #!/bin/bash
    # Read JSON data that Claude Code sends to stdin
    input=$(cat)

    # Extract fields using jq
    MODEL=$(echo "$input" | jq -r '.model.display_name')
    DIR=$(echo "$input" | jq -r '.workspace.current_dir')
    # The "// 0" provides a fallback if the field is null
    PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)

    # Output the status line - ${DIR##*/} extracts just the folder name
    echo "[$MODEL] 📁 ${DIR##*/} | ${PCT}% context"
    ```
  </Step>

  <Step title="Make it executable">
    Mark the script as executable so your shell can run it:

    ```bash theme={null}
    chmod +x ~/.claude/statusline.sh
    ```
  </Step>

  <Step title="Add to settings">
    Tell Claude Code to run your script as the status line. Add this configuration to `~/.claude/settings.json`, which sets `type` to `"command"` (meaning "run this shell command") and points `command` to your script:

    ```json theme={null}
    {
      "statusLine": {
        "type": "command",
        "command": "~/.claude/statusline.sh"
      }
    }
    ```

    Your status line appears at the bottom of the interface. Settings reload automatically, but changes won't appear until your next interaction with Claude Code.
  </Step>
</Steps>

## How status lines work

Claude Code runs your script and pipes [JSON session data](#available-data) to it via stdin. Your script reads the JSON, extracts what it needs, and prints text to stdout. Claude Code displays whatever your script prints.

**When it updates**

Your script runs after each new assistant message, when the permission mode changes, or when vim mode toggles. Updates are debounced at 300ms, meaning rapid changes batch together and your script runs once things settle. If a new update triggers while your script is still running, the in-flight execution is cancelled. If you edit your script, the changes won't appear until your next interaction with Claude Code triggers an update.

These triggers can go quiet when the main session is idle, for example while a coordinator waits on background subagents. To keep time-based or externally-sourced segments current during idle periods, set [`refreshInterval`](#manually-configure-a-status-line) to also re-run the command on a fixed timer.

**What your script can output**

* **Multiple lines**: each `echo` or `print` statement displays as a separate row. See the [multi-line example](#display-multiple-lines).
* **Colors**: use [ANSI escape codes](https://en.wikipedia.org/wiki/ANSI_escape_code#Colors) like `\033[32m` for green (terminal must support them). See the [git status example](#git-status-with-colors).
* **Links**: use [OSC 8 escape sequences](https://en.wikipedia.org/wiki/ANSI_escape_code#OSC) to make text clickable (Cmd+click on macOS, Ctrl+click on Windows/Linux). Requires a terminal that supports hyperlinks like iTerm2, Kitty, or WezTerm. See the [clickable links example](#clickable-links).

<Note>The status line runs locally and does not consume API tokens. It temporarily hides during certain UI interactions, including autocomplete suggestions, the help menu, and permission prompts.</Note>

## Available data

Claude Code sends the following JSON fields to your script via stdin:

| Field                                                                            | Description                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model.id`, `model.display_name`                                                 | Current model identifier and display name                                                                                                                                                                                                  |
| `cwd`, `workspace.current_dir`                                                   | Current working directory. Both fields contain the same value; `workspace.current_dir` is preferred for consistency with `workspace.project_dir`.                                                                                          |
| `workspace.project_dir`                                                          | Directory where Claude Code was launched, which may differ from `cwd` if the working directory changes during a session                                                                                                                    |
| `workspace.added_dirs`                                                           | Additional directories added via `/add-dir` or `--add-dir`. Empty array if none have been added                                                                                                                                            |
| `workspace.git_worktree`                                                         | Git worktree name when the current directory is inside a linked worktree created with `git worktree add`. Absent in the main working tree. Populated for any git worktree, unlike `worktree.*` which applies only to `--worktree` sessions |
| `cost.total_cost_usd`                                                            | Estimated session cost in USD, computed client-side. May differ from your actual bill                                                                                                                                                      |
| `cost.total_duration_ms`                                                         | Total wall-clock time since the session started, in milliseconds                                                                                                                                                                           |
| `cost.total_api_duration_ms`                                                     | Total time spent waiting for API responses in milliseconds                                                                                                                                                                                 |
| `cost.total_lines_added`, `cost.total_lines_removed`                             | Lines of code changed                                                                                                                                                                                                                      |
| `context_window.total_input_tokens`, `context_window.total_output_tokens`        | Cumulative token counts across the session                                                                                                                                                                                                 |
| `context_window.context_window_size`                                             | Maximum context window size in tokens. 200000 by default, or 1000000 for models with extended context.                                                                                                                                     |
| `context_window.used_percentage`                                                 | Pre-calculated percentage of context window used                                                                                                                                                                                           |
| `context_window.remaining_percentage`                                            | Pre-calculated percentage of context window remaining                                                                                                                                                                                      |
| `context_window.current_usage`                                                   | Token counts from the last API call, described in [context window fields](#context-window-fields)                                                                                                                                          |
| `exceeds_200k_tokens`                                                            | Whether the total token count (input, cache, and output tokens combined) from the most recent API response exceeds 200k. This is a fixed threshold regardless of actual context window size.                                               |
| `effort.level`                                                                   | Current reasoning effort (`low`, `medium`, `high`, `xhigh`, or `max`). Reflects the live session value, including mid-session `/effort` changes. Absent when the current model does not support the effort parameter                       |
| `thinking.enabled`                                                               | Whether extended thinking is enabled for the session                                                                                                                                                                                       |
| `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` | Percentage of the 5-hour or 7-day rate limit consumed, from 0 to 100                                                                                                                                                                       |
| `rate_limits.five_hour.resets_at`, `rate_limits.seven_day.resets_at`             | Unix epoch seconds when the 5-hour or 7-day rate limit window resets                                                                                                                                                                       |
| `session_id`                                                                     | Unique session identifier                                                                                                                                                                                                                  |
| `session_name`                                                                   | Custom session name set with the `--name` flag or `/rename`. Absent if no custom name has been set                                                                                                                                         |
| `transcript_path`                                                                | Path to conversation transcript file                                                                                                                                                                                                       |
| `version`                                                                        | Claude Code version                                                                                                                                                                                                                        |
| `output_style.name`                                                              | Name of the current output style                                                                                                                                                                                                           |
| `vim.mode`                                                                       | Current vim mode (`NORMAL`, `INSERT`, `VISUAL`, or `VISUAL LINE`) when [vim mode](/en/interactive-mode#vim-editor-mode) is enabled                                                                                                         |
| `agent.name`                                                                     | Agent name when running with the `--agent` flag or agent settings configured                                                                                                                                                               |
| `worktree.name`                                                                  | Name of the active worktree. Present only during `--worktree` sessions                                                                                                                                                                     |
| `worktree.path`                                                                  | Absolute path to the worktree directory                                                                                                                                                                                                    |
| `worktree.branch`                                                                | Git branch name for the worktree (for example, `"worktree-my-feature"`). Absent for hook-based worktrees                                                                                                                                   |
| `worktree.original_cwd`                                                          | The directory Claude was in before entering the worktree                                                                                                                                                                                   |
| `worktree.original_branch`                                                       | Git branch checked out before entering the worktree. Absent for hook-based worktrees                                                                                                                                                       |

<Accordion title="Full JSON schema">
  Your status line command receives this JSON structure via stdin:

  ```json theme={null}
  {
    "cwd": "/current/working/directory",
    "session_id": "abc123...",
    "session_name": "my-session",
    "transcript_path": "/path/to/transcript.jsonl",
    "model": {
      "id": "claude-opus-4-7",
      "display_name": "Opus"
    },
    "workspace": {
      "current_dir": "/current/working/directory",
      "project_dir": "/original/project/directory",
      "added_dirs": [],
      "git_worktree": "feature-xyz"
    },
    "version": "2.1.90",
    "output_style": {
      "name": "default"
    },
    "cost": {
      "total_cost_usd": 0.01234,
      "total_duration_ms": 45000,
      "total_api_duration_ms": 2300,
      "total_lines_added": 156,
      "total_lines_removed": 23
    },
    "context_window": {
      "total_input_tokens": 15234,
      "total_output_tokens": 4521,
      "context_window_size": 200000,
      "used_percentage": 8,
      "remaining_percentage": 92,
      "current_usage": {
        "input_tokens": 8500,
        "output_tokens": 1200,
        "cache_creation_input_tokens": 5000,
        "cache_read_input_tokens": 2000
      }
    },
    "exceeds_200k_tokens": false,
    "effort": {
      "level": "high"
    },
    "thinking": {
      "enabled": true
    },
    "rate_limits": {
      "five_hour": {
        "used_percentage": 23.5,
        "resets_at": 1738425600
      },
      "seven_day": {
        "used_percentage": 41.2,
        "resets_at": 1738857600
      }
    },
    "vim": {
      "mode": "NORMAL"
    },
    "agent": {
      "name": "security-reviewer"
    },
    "worktree": {
      "name": "my-feature",
      "path": "/path/to/.claude/worktrees/my-feature",
      "branch": "worktree-my-feature",
      "original_cwd": "/path/to/project",
      "original_branch": "main"
    }
  }
  ```

  **Fields that may be absent** (not present in JSON):

  * `session_name`: appears only when a custom name has been set with `--name` or `/rename`
  * `workspace.git_worktree`: appears only when the current directory is inside a linked git worktree
  * `effort`: appears only when the current model supports the reasoning effort parameter
  * `vim`: appears only when vim mode is enabled
  * `agent`: appears only when running with the `--agent` flag or agent settings configured
  * `worktree`: appears only during `--worktree` sessions. When present, `branch` and `original_branch` may also be absent for hook-based worktrees
  * `rate_limits`: appears only for Claude.ai subscribers (Pro/Max) after the first API response in the session. Each window (`five_hour`, `seven_day`) may be independently absent. Use `jq -r '.rate_limits.five_hour.used_percentage // empty'` to handle absence gracefully.

  **Fields that may be `null`**:

  * `context_window.current_usage`: `null` before the first API call in a session
  * `context_window.used_percentage`, `context_window.remaining_percentage`: may be `null` early in the session

  Handle missing fields with conditional access and null values with fallback defaults in your scripts.
</Accordion>

### Context window fields

The `context_window` object provides two ways to track context usage:

* **Cumulative totals** (`total_input_tokens`, `total_output_tokens`): sum of all tokens across the entire session, useful for tracking total consumption
* **Current usage** (`current_usage`): token counts from the most recent API call, use this for accurate context percentage since it reflects the actual context state

The `current_usage` object contains:

* `input_tokens`: input tokens in current context
* `output_tokens`: output tokens generated
* `cache_creation_input_tokens`: tokens written to cache
* `cache_read_input_tokens`: tokens read from cache

The `used_percentage` field is calculated from input tokens only: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. It does not include `output_tokens`.

If you calculate context percentage manually from `current_usage`, use the same input-only formula to match `used_percentage`.

The `current_usage` object is `null` before the first API call in a session.

## Subagent status lines

The `subagentStatusLine` setting renders a custom row body for each [subagent](/en/sub-agents) shown in the agent panel below the prompt. Use it to replace the default `name · description · token count` row with your own formatting.

```json theme={null}
{
  "subagentStatusLine": {
    "type": "command",
    "command": "~/.claude/subagent-statusline.sh"
  }
}
```

The command runs once per refresh tick with all visible subagent rows passed as a single JSON object on stdin. The input includes the [base hook fields](/en/hooks#common-input-fields) plus `columns` (the usable row width) and a `tasks` array, where each task has `id`, `name`, `type`, `status`, `description`, `label`, `startTime`, `tokenCount`, `tokenSamples`, and `cwd`.

Write one JSON line to stdout per row you want to override, in the form `{"id": "<task id>", "content": "<row body>"}`. The `content` string is rendered as-is, including ANSI colors and OSC 8 hyperlinks. Omit a task's `id` to keep the default rendering for that row; emit an empty `content` string to hide it.

The same trust and `disableAllHooks` gates that apply to `statusLine` apply here. Plugins can ship a default `subagentStatusLine` in their [`settings.json`](/en/plugins-reference#standard-plugin-layout).

## Tips

* **Test with mock input**: `echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"/home/user/project"},"context_window":{"used_percentage":25},"session_id":"test-session-abc"}' | ./statusline.sh`
* **Keep output short**: the status bar has limited width, so long output may get truncated or wrap awkwardly
* **Cache slow operations**: your script runs frequently during active sessions, so commands like `git status` can cause lag. See the [caching example](#cache-expensive-operations) for how to handle this.

Community projects like [ccstatusline](https://github.com/sirmalloc/ccstatusline) and [starship-claude](https://github.com/martinemde/starship-claude) provide pre-built configurations with themes and additional features.

## Troubleshooting

**Status line not appearing**

* Verify your script is executable: `chmod +x ~/.claude/statusline.sh`
* Check that your script outputs to stdout, not stderr
* Run your script manually to verify it produces output
* If `disableAllHooks` is set to `true` in your settings, the status line is also disabled. Remove this setting or set it to `false` to re-enable.
* Run `claude --debug` to log the exit code and stderr from the first status line invocation in a session
* Ask Claude to read your settings file and execute the `statusLine` command directly to surface errors

**Context percentage shows unexpected values**

* Use `used_percentage` for accurate context state rather than cumulative totals
* The `total_input_tokens` and `total_output_tokens` are cumulative across the session and may exceed the context window size
* Context percentage may differ from `/context` output due to when each is calculated

**OSC 8 links not clickable**

* Verify your terminal supports OSC 8 hyperlinks (iTerm2, Kitty, WezTerm)

* Terminal.app does not support clickable links

* If link text appears but isn't clickable, Claude Code may not have detected hyperlink support in your terminal. This commonly affects Windows Terminal and other emulators not in the auto-detection list. Set the `FORCE_HYPERLINK` environment variable to override detection before launching Claude Code:

  ```bash theme={null}
  FORCE_HYPERLINK=1 claude
  ```

  In PowerShell, set the variable in the current session first:

  ```powershell theme={null}
  $env:FORCE_HYPERLINK = "1"; claude
  ```

* SSH and tmux sessions may strip OSC sequences depending on configuration

* If escape sequences appear as literal text like `\e]8;;`, use `printf '%b'` instead of `echo -e` for more reliable escape handling

**Script errors or hangs**

* Scripts that exit with non-zero codes or produce no output cause the status line to go blank
* Slow scripts block the status line from updating until they complete. Keep scripts fast to avoid stale output.
* If a new update triggers while a slow script is running, the in-flight script is cancelled
* Test your script independently with mock input before configuring it
