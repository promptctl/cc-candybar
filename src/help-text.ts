import { DISCLOSURE_GLYPH_CLOSED } from "./config/disclosure";

// [LAW:effects-at-boundaries] Pure data, no I/O — index.ts owns the console.log
// effect. Kept as its own module so the text is importable (and testable) without
// pulling in index.ts's top-level `main()` call.
// [LAW:one-source-of-truth] The disclosure glyph comes from config/disclosure.ts
// (the same constant the theme/look picker itself renders with), so this text
// can't drift from what a user actually sees on the bar.
export const HELP_TEXT = `
cc-candybar - Beautiful powerline statusline for Claude Code

Usage: cc-candybar [options]

Standalone Commands:
  -h, --help               Show this help

Debugging:
  CC_CANDYBAR_DEBUG=1      Enable debug logging for troubleshooting

Configuration:
  Layout and segment options are defined in .cc-candybar.json5 (place in your
  project dir, cwd, or ~/.config/cc-candybar/config.json5). Use CC_CANDYBAR_CONFIG
  to point at a specific file. See the default config for all available options:
    node dist/index.mjs debug --project-dir . --cwd .

  The bundled default bar ships a settings drawer — no config needed. Click
  ⚙ settings ${DISCLOSURE_GLYPH_CLOSED} on the bar to reveal a clickable theme/look picker and
  other display options.

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
