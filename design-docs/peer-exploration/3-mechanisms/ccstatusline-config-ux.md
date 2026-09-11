# ccstatusline's TUI configurator

## The mechanism

ccstatusline ships one executable that is both the renderer and the configurator, and `main()`
picks which by asking whether stdin is a terminal. Piped JSON means Claude Code called it: parse
the hook payload, render, exit. A TTY means a human ran `ccstatusline` by hand: drop the pending
update message and call `runTUI()`. There is no second binary, no daemon, and no config-server
protocol — the configurator is the same process image with a different entry point.

The TUI is Ink (React rendered to a terminal) over a Zod-validated `Settings` object. Its editing
model is a single in-memory document with a committed baseline beside it. `App` holds
`settings`, `originalSettings` (a structural clone taken at load), and `hasChanges`, which is
recomputed on every state change as `JSON.stringify(settings) !== JSON.stringify(originalSettings)`.
Every editor screen mutates `settings` through `setSettings`; nothing reaches disk until the user
presses ctrl+s or picks "Save & Exit". So every keystroke in the whole tool is speculative by
construction, and "discard" is free — it is just exiting without calling `saveSettings`.

That is what makes the preview honest. `StatusLinePreview` is mounted in `App`'s tree *above* the
screen switch, so it is on screen in every editor, not on a dedicated preview page. It renders the
current in-memory `settings.lines` through `preRenderAllWidgets` and `renderStatusLineWithInfo` —
the same pre-render pass the real path runs, and a three-line wrapper over the same
`renderStatusLine` — with one field of the `RenderContext` flipped: `isPreview: true`. Each widget
carries its own preview arm keyed off that flag and returns a plausible fixture instead of reading
live data, so `ContextLength` answers with a hard-coded 18,600 tokens and no transcript in sight.
The preview is therefore the production renderer over fake inputs, not a mock of the renderer; a
powerline separator that would render wrong in the bar renders wrong in the preview. The preview
also reports back whether any line was truncated at the current terminal width, which the main menu
turns into a warning naming the setting to go fix ("see Terminal Options → Terminal Width").

Discovery is not a document — it is the `Widget` interface. Every widget implements
`getDisplayName()`, `getDescription()`, `getCategory()`, plus capability predicates
(`supportsRawValue`, `supportsColors`, `supportsNumberFormat`, `getHideableStates`). `WIDGET_MANIFEST`
maps each type string to a constructor; `widgetRegistry` instantiates one of each at module load;
`getWidgetCatalog` folds the registry into `{ type, displayName, description, category, searchText }`
rows. The items editor consumes that catalog as a two-level picker — pick a category, or type to
fuzzy-search across all of them — and shows the selected entry's `description` under the list. So
"what can I put on my status line, and what does each one do" is answered by the same objects that
render, and adding a widget adds a catalog row with no edit to the TUI.

The per-widget *editing* surface is declared the same way. `getCustomKeybinds()` returns
`{ key, label, action }` records; the items editor concatenates their labels into the footer line
under the widget list, so the help text for a widget is generated from the widget. When a key is
pressed, `handleNormalInputMode` looks the key up in that list and routes it three ways: a
shared action the editor owns (the number-format cycle, the hide-state checklist), the widget's
own `handleEditorAction(action, item)` returning a mutated item with no screen change, or — when
that returns null, or when the widget declares no handler — the widget's `renderEditor(props)`,
a full React element the editor mounts in place. A widget can therefore ship its own editor screen
(max-width entry, symbol override, timezone picker) without the editor knowing what it is.

Committing is a whole-file rewrite. `saveSettings` stamps `version: CURRENT_VERSION` onto the
in-memory object, serializes it with `JSON.stringify(settings, null, 2)` into a uniquely-named temp
file in the target's directory, and `rename`s it over the target, so a render firing mid-save sees
the complete old file or the complete new one. The config is plain JSON at
`~/.config/ccstatusline/settings.json` and is machine-owned; there are no comments to lose, and
key order and formatting are the serializer's business, not the user's.

The load path is deliberately asymmetric to that. `loadSettings` writes defaults only when the file
is *missing*; a file that fails `JSON.parse` or fails the schema is left untouched on disk, the
reason is recorded in a module-scoped `lastLoadError`, and in-memory defaults are returned. A
migrated config is persisted only after the migrated result validates. The TUI reads
`getConfigLoadError()` in the load callback, shows it as a red banner, and gates ctrl+s behind a
confirm dialog whose message says the file is preserved and that saving will replace it — so the
one path that can destroy a broken-but-recoverable config is an explicit yes.

Two smaller pieces round out the UX. The main menu is data: `buildMainMenuItems` returns entries
carrying `label`, `description`, optional `sublabel` and `disabled`, and the list widget renders the
selected entry's description below it — so the top-level menu explains itself the same way the
widget catalog does. And import gets its own preview: `ImportPreviewDialog` holds a `previewMode`
that follows the highlighted list row, recomputes `applyImport(current, imported, mode)` as the
highlight moves, and shows a per-key `current → imported` diff, so "replace" versus "merge" is a
decision the user makes while looking at its result.

Because the renderer re-reads `settings.json` on every tick (`renderMultipleLines` opens with
`await loadSettings()`), a save takes effect on the next repaint with no reload signal, no watcher,
and no process to restart.

## Evidence

| Fact | Path | Lines | Excerpt |
|---|---|---|---|
| Renderer and configurator are one executable, chosen by whether stdin is a TTY | `src/ccstatusline.ts` | 321-322 | `// Check if we're in a piped/non-TTY environment first` / `    if (!process.stdin.isTTY) {` |
| The TTY branch runs the TUI | `src/ccstatusline.ts` | 345-354 | `        // Interactive mode - run TUI` … `        runTUI();` |
| The render path re-reads the config file every tick | `src/ccstatusline.ts` | 92-93 | `async function renderMultipleLines(data: StatusJSON) {` / `    const settings = await loadSettings();` |
| Whole config held in memory with a committed baseline beside it | `src/tui/App.tsx` | 466-468 | `    const [settings, setSettings] = useState<Settings \| null>(null);` / `    const [originalSettings, setOriginalSettings] = useState<Settings \| null>(null);` / `    const [hasChanges, setHasChanges] = useState(false);` |
| Dirtiness is a structural diff against that baseline | `src/tui/App.tsx` | 544-545 | `        if (originalSettings) {` / `            const hasAnyChanges = JSON.stringify(settings) !== JSON.stringify(originalSettings);` |
| ctrl+s is the only unprompted commit, and it re-baselines | `src/tui/App.tsx` | 565, 579-580 | `        if (key.ctrl && input === 's' && settings && screen !== 'confirm') {` … `                        await saveSettings(settings);` / `                        setOriginalSettings(cloneSettings(settings));` |
| The preview is mounted above the screen switch, so every editor screen has it | `src/tui/App.tsx` | 1150-1158 | `            <StatusLinePreview` / `                lines={settings.lines}` … `            <Box marginTop={1}>` / `                {screen === 'main' && (` |
| The preview calls the production renderer with one context field flipped | `src/tui/components/StatusLinePreview.tsx` | 48, 57 | `        isPreview: true,` … `    return renderStatusLineWithInfo(widgets, settings, context, preRenderedWidgets, preCalculatedMaxWidths);` |
| Each widget carries its own preview arm returning a fixture | `src/widgets/ContextLength.ts` | 23-25 | `        if (context.isPreview) {` / `            const value = formatTokens(18600, format);` / ``            return item.rawValue ? value : `Ctx: ${value}`; `` |
| The widget interface is the discovery surface | `src/types/Widget.ts` | 47-52 | `export interface Widget {` / `    getDefaultColor(): string;` / `    getDescription(): string;` / `    getDisplayName(): string;` / `    getCategory(): string;` / `    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay;` |
| …and the per-widget editing surface | `src/types/Widget.ts` | 54-56 | `    getCustomKeybinds?(item?: WidgetItem): CustomKeybind[];` / `    getHideableStates?(): HideableState[];` / `    renderEditor?(props: WidgetEditorProps): React.ReactElement \| null;` |
| The registry is built from a type→constructor manifest | `src/utils/widgets.ts` | 20-22 | `const widgetRegistry = new Map<WidgetItemType, Widget>(` / `    WIDGET_MANIFEST.map((entry): [WidgetItemType, Widget] => [entry.type, entry.create()])` / `);` |
| The searchable catalog is derived from the registry, not authored | `src/utils/widgets.ts` | 96-99 | `        const widget = getWidget(type);` / `        const displayName = widget?.getDisplayName() ?? type;` / ``        const description = widget?.getDescription() ?? `Unknown widget: ${type}`; `` / `        const category = widget?.getCategory() ?? 'Other';` |
| The editor's footer help is generated from the widget's own keybinds | `src/tui/components/ItemsEditor.tsx` | 333, 457 | `    const customKeybindsText = customKeybinds.map(kb => kb.label).join(', ');` … `                    <Text dimColor>{customKeybindsText \|\| ' '}</Text>` |
| A keybind routes to the widget's mutator, else to the widget's own editor screen | `src/tui/components/items-editor/input-handlers.ts` | 506-516 | `                } else if (widgetImpl.handleEditorAction) {` / `                    const updatedWidget = widgetImpl.handleEditorAction(matchedKeybind.action, currentWidget);` … `                } else if (widgetImpl.renderEditor) {` / `                    setCustomEditorWidget({ widget: currentWidget, impl: widgetImpl, action: matchedKeybind.action });` |
| The commit is a whole-object serialization, temp file + rename | `src/utils/config.ts` | 127-128 | `        await writeFile(tempPath, JSON.stringify(settings, null, 2), 'utf-8');` / `        await rename(tempPath, writeTarget.targetPath);` |
| A config that fails to load is never overwritten; the reason is recorded | `src/utils/config.ts` | 158-160 | ` * Recovery contract: if the file cannot be read or fails validation, loadSettings` / ` * NEVER overwrites it — it returns built-in defaults in memory, records the reason` / ` * (see getConfigLoadError), and leaves the file untouched for the user to fix. The` |
| Saving over a preserved broken file needs an explicit yes | `src/tui/App.tsx` | 454-455 | `    return {` / ``        message: `${configLoadError} and is preserved on disk. Saving replaces it with the current configuration. Continue?`, `` |
| The top-level menu is data carrying its own explanations | `src/tui/components/MainMenu.tsx` | 88-93 | `        {` / `            label: '📝 Edit Lines',` / `            value: 'lines',` / `            description:` / `                'Configure any number of status lines with various widgets like model info, git status, and token usage'` / `        },` |
| Import is previewed as a diff, recomputed as the mode highlight moves | `src/tui/components/ImportPreviewDialog.tsx` | 141-142 | `    const [previewMode, setPreviewMode] = useState<Exclude<ImportMode, 'cancel'>>('replace');` / `    const previewSettings = getImportPreviewSettings(currentSettings, validation, previewMode);` |
| Licence text | `LICENSE` | 1 | `MIT License` |

## What cc-candybar does today

**The in-bar menu is the configurator, and it is better than a TUI for what it covers.**
`synthesizeSettingsMenu` (`src/config/settings-menu.ts`) splices one disclosure into every preset
root at the `SETTINGS_ANCHOR` (`settings-menu.ts:95`), and the anchored-root stamp
(`AnchoredRoot`, `settings-menu.ts:385`) makes its presence a theorem rather than a hope — an
author writing their own `root` cannot delete it. Its controls are records, not hand-written
segments: `PRIMARY_CONTROLS` (preset) and `CONFIG_CONTROLS` (theme, look, style) at lines 260-296,
`WRAP` and `PADDING` at 315-324, folded into segments and dual actions by the loop at line 753.
Each control labels itself from its `.effective` variable — the value the daemon actually rendered
with — so the glyph and the click agree. The picker under each is `src/render/picker.ts`'s
width-fit grid (`paginate`, line 73), a pure render helper that owns no state and declares no gate.

That gives cc-candybar something ccstatusline's TUI structurally cannot: for those six settings,
the preview *is* the artefact. A click writes SessionState, the next render shows it, and the
`persist?` checkbox decides whether it also lands in the file. There is no modal edit session to
enter and no commit step to explain — "try it, then tick persist?" is a strictly shorter loop than
"open the tool, edit, watch a preview pane, ctrl+s".

**The durable write is surgical where ccstatusline's is total.** A persist/reset/undo click goes
through `src/daemon/config-file-store.ts` — `writeValue` (line 452) replaces exactly one value span
via `setValue` over the JSON5 span editor, `deleteValue` (474) prunes a path so the name tracks the
bundled default again, `applyLayoutOp` (490) edits one authored row. Comments, key order, quoting
and trailing commas survive, because only one span changes per edit. Undo/redo steps whole-file
`Snapshot`s (line 533). ccstatusline's `JSON.stringify(settings, null, 2)` could not do this, and
does not have to — its config file is machine-owned.

**Loud failure is already the norm, and already three-state.** `resolveDslConfig`
(`src/config/loader/discovery.ts:175`) folds the candidate list into a `ConfigResolution` whose
four arms (141-153) keep `default`, `missing` and `unreadable` distinct, and
`configResolutionNotice` (230) is the one spelling of all three. `durableConfigPath` (207) is a
projection of the same resolution, so the file a click writes is the file the next reload reads.
This is the same "never overwrite a file you could not read" instinct as `loadSettings`, resolved
at the type level instead of in a module-scoped error string.

**Non-visual discovery exists and is machine-facing.** `cc-candybar schema` prints the JSON Schema
an editor can point `$schema` at, emitted by `emitConfigSchema`
(`src/config/loader/emit-schema.ts:45`) from the *same* field tables the runtime validator reads —
`SEGMENT_FIELDS` (`src/config/loader/segments.ts:154`) is one table feeding both. `cc-candybar check`
(`src/check.ts`) runs the production pipeline against a config with a deliberately rich fake payload
and returns a text verdict plus an exit code. `cc-candybar segments` / `vars` / `config` introspect
the running daemon. `just demo` renders any config through `registerDslConfig` + `renderDsl` with no
Claude Code attached (`src/demo/dsl.ts:6-8`).

**The three real gaps.** First, the menu covers six settings; the segment set, the row layout,
per-segment colours and every template are file-only. Second, there is no catalog: `SegmentDecl`
(`src/config/dsl-types.ts:683-700`) has no `description`, `label` or `category`, and neither does
`SegmentSnapshot` (`src/daemon/debug-types.ts:70-83`), so nothing in the program can answer "what
segments exist and what does each show" — only `docs/segment-authoring.md` can, in prose, out of
band. Third, and most cheaply fixed: `check` already computes the rendered bar and throws it away.
`CheckOutcome`'s clean arm carries `rendered: string` (`src/check.ts:161`), produced by the
`renderDsl` call at line 377, and `checkPlan` (480-509) emits only `✓ <where>: config OK`. There is
no way to *see* what a config looks like without installing it.

## The change

**Do not lift the TUI.** Three reasons, in the order that decides it.

The write model is the blocker. What makes ccstatusline's TUI cheap is holding the whole config in
memory, diffing it against a clone, and serializing the winner over the file. cc-candybar
deliberately does not have that model: `config-file-store.ts` exists so a hand-authored JSON5 file
keeps its comments through a settings click. A TUI holding a `DslConfig` and writing it back would
flatten every comment and every JSON5 affordance the user chose the format for. Writing through the
span editor instead means the TUI cannot hold a document and diff it — it has to emit per-key edits,
at which point it is the in-bar menu with a different input device.

The configurable surface is a template language, not a widget list. ccstatusline's catalog works
because a widget is an opaque unit with a fixed set of togglable facets, so a picker can enumerate
the whole space. cc-candybar's is `{{ ramp .context.contextLeft "step" 0 "error" 41 "warning" }}`.
No picker offers that. The part a TUI *could* enumerate — theme, look, style, wrap, padding,
preset — is exactly `PICKER_CONTROLS` + `WRAP`/`PADDING`, which the bar already offers live.

And it would be a second interaction surface over one setting space. The in-bar menu's wire gates
are *derived*: `deriveActionValidators` (`src/daemon/verbs/state-validators.ts:245`) folds the
action table into the writable `(key, spec)` set, so a rendered click and the gate that admits it
share one source. A TUI writing SessionState and the
config file directly derives nothing, and the two surfaces could disagree about what is writable —
`[LAW:single-enforcer]` exception with no reason behind it. It would also need to resolve the config
the way the daemon does; the daemon is detached and reads no env of its own for
`CC_CANDYBAR_CONFIG` (it arrives as a client hint), so a third process would either re-implement
`resolveDslConfig`'s precedence or round-trip through the socket for it.

What *is* worth lifting is the two ideas underneath the TUI, neither of which needs Ink.

**Change 1 — `cc-candybar check --render` prints the bar it already rendered.**
`src/check.ts`: `runCheck` (line 516) currently treats any second argv entry as a usage error, so it
grows a real flag parse; `checkPlan` (480) gains the flag as an input and, on the `clean` arm,
appends `o.rendered` to stdout beneath the verdict line. `CHECK_WIDTH` (line 49) stays 200 for the
verdict — the comment above it forbids making the verdict terminal-dependent, and that reasoning
holds — so the render flag threads `process.stdout.columns` as a separate width used only for the
printed preview, and the fatal/unreadable arms are untouched. `src/help-text.ts` (the `check` entry
at 84-88) documents the flag.

This *replaces* the case for building a preview pane. An author — which in this repo means an LLM
editing a JSON5 file — edits, runs one command, and sees the actual bar with the actual colours,
without installing anything or touching the live daemon. It is the preview-before-commit half of
ccstatusline's TUI, delivered to the reader this config API is actually written for. Note honestly
what it is not: `rendered` is `renderDsl` output, so the preview shows the bar's rows, not the
diagnostic strip; warnings keep going to stderr as they do today.

**Change 2 — segments declare what they are, and the existing surfaces read it.**
Add `describe?: string` (and, if the inventory warrants grouping, `category?: string`) to
`SegmentDecl` in `src/config/dsl-types.ts`, and one row per field to `SEGMENT_FIELDS` in
`src/config/loader/segments.ts`. Because that table is the single source for both the validator and
the JSON Schema, `emitConfigSchema` picks it up with no edit — an editor's autocomplete gets the
description for free, and `SEGMENT_DELTA_SCHEMA` makes it overridable per name like every other
field. Populate it for every segment in `src/config/default-dsl-config.ts`. Then carry it through
the surface that already enumerates segments: `SegmentSnapshot` in `src/daemon/debug-types.ts` gains
the field, `introspectSegments` in `src/daemon/debug.ts` (line 176) copies it, and
`cc-candybar segments` prints it — which, because the bundled default is merged into every config,
makes that command the catalog `getWidgetCatalog` is for ccstatusline.

This *replaces* `docs/segment-authoring.md` as the sole inventory of what the bundled segments show.
The doc keeps its job (how to author one); it stops being the only place the answer lives, and the
answer stops being able to drift from the declaration silently.

## Cost and risk

Change 1 is roughly twenty lines plus a test over `checkPlan`. Its one real risk is the stdout
contract: `check`'s stdout is documented as a parseable verdict, and a script grepping it would see
a bar full of SGR and OSC-8 escapes appear. That is why it is a flag and not the default. The second
trap is width — printing at `CHECK_WIDTH` would show a 200-column bar in an 80-column terminal and
teach the author a wrong lesson about wrapping, so the flag must thread a real width while leaving
the verdict's fixed width alone. Getting that backwards (one width for both) would make the verdict
depend on the terminal, which is the exact thing the comment at `check.ts:45-48` was written to
prevent.

Change 2 is cheap in mechanism and expensive in prose: `SegmentDecl` is a widely-referenced type,
but the field is optional and the loader's field table absorbs it in one row, so the code cost is
small and the bulk of the work is writing twenty-three accurate one-line descriptions. Two wrinkles
worth stating up front. A description stored in a config file is documentation that can rot, and nothing
can test that it is *true* — only that it exists; a bundled-segment authorship test can enforce
presence, and should. And because a file's declaration under a bundled name is a per-field delta, a
user who overrides a bundled segment's `template` inherits the bundled `describe`, which may now
describe something else. That is a wart, not a bug — it is the same inheritance every other field
has — but it should be written down rather than discovered.

What both changes make harder later: every new bundled segment owes a description, and `check`
acquires a second output mode that future changes to its stdout have to respect. Both are small
taxes on things that should be paid anyway.

What is avoided by not lifting the TUI is the larger number: ccstatusline's `src/tui` is 7,799
lines excluding tests, across 21 component files, on a React + Ink runtime with a patched
`ink@6.2.0` in `patchedDependencies` — and, in cc-candybar's shape, a third process that would need
its own copy of the config precedence chain.

## Licence verdict

The checkout's `LICENSE` is the MIT licence verbatim: line 1 is `MIT License`, line 3 is
`Copyright (c) 2025 Matthew Breedlove (https://github.com/sirmalloc)`, and the body is the standard
permission/warranty text. The file carries **no literal `SPDX-License-Identifier` string** — a
`grep -rn SPDX` over the whole checkout (excluding `.git` and `bun.lock`) returns nothing — so the
SPDX identifier **MIT** is read from the licence text itself, corroborated by `"license": "MIT"` in
`package.json` and by `NOTICE` ("This project is licensed under the MIT License."). MIT is on the
maintainer's accept list, so code may be copied as well as ideas, provided the copyright notice and
permission text travel with it. In practice nothing here needs copying: both proposed changes are
the *idea* (a capability-declaring registry row; a preview rendered by the production renderer) and
the ccstatusline code that implements them is React components against a dependency this proposal
declines to add.
