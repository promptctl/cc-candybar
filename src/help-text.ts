import { DOOR_GLYPH } from "./config/disclosure";
import { HELP_GLYPH_CLOSED } from "./config/help";
import { ADD_GLYPH, CONFIGURE_GLYPH, REMOVE_GLYPH } from "./config/edit-glyphs";
import { NODE_FLAGS } from "./cli-flags";
import {
  TABS,
  TAB_LABEL,
  settingMenuPath,
  settingsByPlace,
} from "./config/menu-places";
import { LANES, LANE_NAMES, type Lane } from "./config/lanes";
import { SETTINGS } from "./config/setting-projections";

// Where the lanes' switches are, each place once: the 🧪 toggles, and the
// renderer that switches the tmux status line.
const LANE_PLACES = [
  ...new Set(
    Object.values(LANES).map((l) => settingMenuPath(l.switch.setting)),
  ),
].join(" or ");

// The settings list's label column starts two spaces past the longest field.
const FIELD_COLUMN =
  Math.max(...Object.values(SETTINGS).map((s) => s.configKey.length)) + 2;

// [LAW:effects-at-boundaries] Pure data, no I/O — index.ts owns the console.log
// effect. Kept as its own module so the text is importable (and testable) without
// pulling in index.ts's top-level `main()` call.
// [LAW:one-source-of-truth] The door's glyph comes from config/disclosure.ts —
// the same constant the bar's own settings door renders with — so an
// instruction to click it can't drift from what a user actually sees.
// [LAW:one-source-of-truth] THE help corpus, as data. `--help` and the bar's
// own `(?)` disclosures are two RENDERINGS of these arrays, never two copies of
// the sentences: a `(?)` segment's template IS one of these strings, and the
// paragraphs below interpolate the same values. A help sentence typed into a
// segment template — where nothing would ever notice it drifting from the CLI's
// wording — is the defect this shape exists to make unrepresentable.
//
// [LAW:decomposition] One line is one CELL on the bar, so each is a complete
// thought that stands alone and each stays short: `(?)` bodies drop below their
// row, and a body that overflows `term.cols` wraps into more rows than the fact
// it explains is worth. Every line leads with the glyph it explains, so the
// reader matches text to affordance by shape rather than by reading order.
export const EDIT_MODE_HELP = [
  `${ADD_GLYPH} inserts`,
  `${REMOVE_GLYPH} removes`,
  `${CONFIGURE_GLYPH} configures`,
  "↺ resets layout",
] as const;

// What each animation lane is and what turning its toggle on does — the
// `(?)` beside each lane's toggle in the settings menu, and `--help`'s
// "Animation lanes". Each lane draws the bar faster than Claude Code reruns
// its statusline (once a second at best), from frames the daemon pushes.
export const LANE_HELP: Readonly<Record<Lane, readonly string[]>> = {
  band: [
    "animates the bar in the band above the prompt, through a Claude Code mod",
    "on: installs the candybar-band mod from this checkout and types /reload-plugins",
  ],
  statusline: [
    "animates the statusline itself, through the attach launcher shipped with cc-candybar",
    "on: exits this Claude Code and starts it again under that launcher, on this session",
    "or start one yourself: cc-candybar --help prints the line to type",
  ],
  pane: [
    "animates the bar in a tmux pane under this session's",
    "on: opens that pane · off: closes it",
  ],
  tmuxStatus: [
    "draws the bar in the tmux status line, while this session's pane is the one it shows",
    "tmux: the daemon draws it there · claude: puts the status line back as it was",
  ],
};

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
  to point at a specific file. To see the effective merged config:
    cc-candybar config

  Every bar carries a settings menu, whatever your config says — no config
  needed, and writing your own \`root\` cannot delete it. Click
  it on the bar (${DOOR_GLYPH} by default; globals.menuGlyph changes it). Beside
  the settings listed below, its first line holds ◁ back, ✎ arrange (edit mode)
  and 💾 save, which appears while you have unsaved changes and writes them to
  your config file. Under it are its
  tabs, ${TABS.map((t) => t.label).join(", ")};
  ${TAB_LABEL.session} holds quick actions and commands, ${TAB_LABEL.layout} a new preset.
  A change applies to this session at once.
  Where each setting is in the menu: the globals field that sets it in a
  config file, then the control's label.
${settingsByPlace()
  .flatMap(({ path, names }) => [
    `    ${path}`,
    ...names.map(
      (name) =>
        `      ${SETTINGS[name].configKey.padEnd(FIELD_COLUMN)}${SETTINGS[name].label}`,
    ),
  ])
  .join("\n")}
  The 🧰 tools tab holds 🩺 doctor: click it to check your setup, and click a
  failed row's [fix] to repair it (the same checks \`cc-candybar doctor\` runs).

  Anywhere the bar shows ${HELP_GLYPH_CLOSED}, clicking it reveals these same instructions
  in place. In edit mode: ${EDIT_MODE_HELP.join(", ")}.

Animation lanes (each switched in the settings menu's ${LANE_PLACES}):
${LANE_NAMES.map((lane) => `  ${LANES[lane].label}\n${LANE_HELP[lane].map((line) => `    ${line}`).join("\n")}`).join("\n")}

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
  plugin install SOURCE    Install a repository's plugins into
                           $XDG_DATA_HOME/cc-candybar/plugins: SOURCE is a
                           local path, a GitHub slug (owner/repo) or a git URL,
                           and its plugins are the folders under
                           .cc-candybar/plugins/. A definition the bar would
                           drop installs nothing. Re-run to update.
  daemon-stats [--json]    Query the running daemon for runtime stats:
                           uptime, RSS, cache hit rates, watcher count,
                           request totals. Does not spawn a daemon.
  frames --lane LANE [--config PATH]
                           One session's bar as the daemon pushes it — up to
                           30 frames a second while it moves, at once on a
                           click — one JSON message per stdout line. Reads
                           Claude Code's statusline JSON from stdin (one object
                           a line) and sends it as the session's data
                           (--config rides with it). LANE is one of
                           ${LANE_NAMES.join(", ")}:
                           the experimental lane this stream serves,
                           which streams only while its toggle in the settings
                           menu's ${LANE_PLACES} is on.
  bar-pane PANE            Draw the bar of the Claude Code session in tmux
                           pane PANE (e.g. %3) in this pane, as the daemon
                           pushes it, while this pane is shown. The bar is
                           drawn at PANE's width, so split PANE with -v for a
                           pane under it that fits. Experimental:
                           runs while ${LANES.pane.label} is on in the settings
                           menu's ${settingMenuPath(LANES.pane.switch.setting)}.

Config tooling:
  doctor [file]            Check your setup the way the bar's 🩺 doctor does —
                           one line per check. Exit 0 all ok, 1 any failed,
                           2 usage error / unreadable settings. Run it from a
                           Claude Code shell (or inside the same tmux pane) so
                           it sees Claude Code's own environment. [file] is
                           the config to check, when the statusline command
                           names one with --config.
  check [--render] [file]  Validate a config on the full render pipeline (parse
                           → merge → validate → register → render, under
                           every preset) with no daemon. With no path, checks
                           the same file the daemon would load from here. Exit
                           0 clean (warnings on stderr), 1 invalid, 2
                           unreadable. --render also prints the bar a fresh
                           session opens on, so you can read a config without
                           installing it. "lint" is an alias.
  schema                   Print the JSON Schema for the config file shape
                           (.cc-candybar.json5). Point an editor's $schema at it
                           for autocomplete + structural validation.
  vars [--json]            Declared variables: source kind, value, last error.
  segments [--json]        Segment templates and their last rendered output.
  config [--json]          The effective merged config. (All three query the
                           running daemon; none spawn one.)

`;
