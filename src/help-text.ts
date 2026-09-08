import { DISCLOSURE_GLYPH_CLOSED } from "./config/disclosure";
import { HELP_GLYPH_CLOSED } from "./config/help";
import { NODE_FLAGS } from "./cli-flags";

// [LAW:one-source-of-truth] THE help corpus: `--help` and the bar's own `(?)`
// disclosures render these same arrays, never a second copy of the sentences.
// [LAW:representation] One line is one CELL on the bar — a complete thought, short.
export const EDIT_MODE_HELP = [
  "+ inserts here",
  "- removes the one left of it",
  "↺ undoes edits",
] as const;

export const PERSIST_HELP = [
  "☐ this session only",
  "☑ default for every session",
] as const;

export const HELP_TEXT = `
cc-candybar - Beautiful powerline statusline for Claude Code

Usage: cc-candybar [options]

Standalone Commands:
  ${NODE_FLAGS.help.join(", ").padEnd(25)}Show this help
  ${NODE_FLAGS.version.join(", ").padEnd(25)}Print the version of this runtime (cc-candybar <version>)

Debugging:
  CC_CANDYBAR_DEBUG=1      Enable debug logging for troubleshooting

Configuration:
  Layout and segment options are defined in .cc-candybar.json5 (place in your
  project dir, cwd, or ~/.config/cc-candybar/config.json5). Use CC_CANDYBAR_CONFIG
  to point at a specific file. See the default config for all available options:
    node dist/index.mjs debug --project-dir . --cwd .

  Every bar carries a settings menu, whatever your config says — no config
  needed, and writing your own \`root\` cannot delete it. Click
  ☰ ${DISCLOSURE_GLYPH_CLOSED} on the bar for preset switching, edit mode, and a config menu
  of clickable theme/look/style/wrap/padding controls. The \`persist?\`
  checkbox there chooses where a change lands: ${PERSIST_HELP.join(", ")}.
  Its 🧰 tools row holds 🩺 doctor: click it to check your setup, and click a
  failed row's [fix] to repair it (the same checks \`cc-candybar doctor\` runs).

  Anywhere the bar shows ${HELP_GLYPH_CLOSED}, clicking it reveals these same instructions
  in place. In edit mode: ${EDIT_MODE_HELP.join(", ")}.

Subcommands:
  install                  One-shot setup: stages the runtime (native render
                           binary + dist bundle) at a stable path, creates the
                           URL handler app + cc-candybar:// scheme (macOS), and
                           writes the staged entry as the statusLine command in
                           ~/.claude/settings.json. Re-run to update.
  install-url-handler      Just stage the runtime and create + register the URL
                           handler app (macOS only).
  url-handle URL           Internal — invoked by the URL handler app on
                           cmd-click. Parses cc-candybar://<verb>/<value> and
                           dispatches (currently: copy to clipboard).
  daemon-stats [--json]    Query the running daemon for runtime stats:
                           uptime, RSS, cache hit rates, watcher count,
                           request totals. Does not spawn a daemon.

Config tooling:
  doctor                   Check your setup the way the bar's 🩺 doctor does —
                           one line per check. Exit 0 all ok, 1 any failed,
                           2 usage error / unreadable settings. Run it from a
                           Claude Code shell (or inside the same tmux pane) so
                           it sees Claude Code's own environment.
  check [config-file]      Validate a config on the full render pipeline (parse
                           → merge → validate → register → render) with no
                           daemon. With no path, checks the same file the daemon
                           would load from here. Exit 0 clean (warnings on
                           stderr), 1 invalid, 2 unreadable. "lint" is an alias.
  schema                   Print the JSON Schema for the config file shape
                           (.cc-candybar.json5). Point an editor's $schema at it
                           for autocomplete + structural validation.
  vars [--json]            Declared variables: source kind, value, last error.
  segments [--json]        Segment templates and their last rendered output.
  config [--json]          The effective merged config. (All three query the
                           running daemon; none spawn one.)

`;
