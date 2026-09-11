# Candidates: configuration languages and theming / colour

Stage-one survey for cc-candybar. Territory: how a user tells a tool what to look like (config languages, schema/validation UX, format-preserving config editors, live reload, graphical configurators) and how a tool turns that into colour (colour science, palette distribution, downsampling). Every star/commit/push number below came from `gh api` on 2026-09-10; commit counts are the `rel="last"` page number of a one-per-page commit listing.

## Configuration

### Oh My Posh
- **URL:** https://github.com/JanDeDobbeleer/oh-my-posh
- **Stats:** Go · 23,439 stars · 5,480 commits · last push 2026-09-09
- **What it is:** A cross-shell prompt engine configured by a single JSON/YAML/TOML document, where every segment's text is a Go template evaluated against a per-segment data struct.
- **Interesting because:** Each segment carries a `cache: { duration, strategy }` where strategy is `session` | `folder` | `device`, so an expensive segment's refresh policy is authored data rather than engine code; `oh-my-posh debug` prints per-segment milliseconds, and `themes/schema.json` is a hand-maintained JSON Schema that drives editor completion for the whole config surface.

### Starship
- **URL:** https://github.com/starship/starship
- **Stats:** Rust · 59,851 stars · 4,396 commits · last push 2026-09-10
- **What it is:** A cross-shell prompt whose entire layout is a TOML file of per-module `format` strings plus a top-level `format` naming module order.
- **Interesting because:** The format-string grammar has positional `$variables` and `[text]($style)` groups that vanish *with their literal separators* when every variable inside them is empty — conditional layout with no `if` — and `starship timings` / `starship explain` expose per-module duration and per-module "why did this render" as first-class subcommands, alongside a published `.github/config-schema.json` and `starship preset` for shipping named starting points.

### Ghostty
- **URL:** https://github.com/ghostty-org/ghostty
- **Stats:** Zig · 60,932 stars · 17,759 commits · last push 2026-09-10
- **What it is:** A terminal emulator with its own flat `key = value` config format, live reload, and a config surface generated from a Zig struct.
- **Interesting because:** The config struct *is* the schema — `ghostty +show-config --default --docs` prints every option with its doc comment as a generated commented file, and `ghostty +validate-config` runs the same parse a reload does; a bad config on reload surfaces a diagnostics list and keeps the last good values rather than failing to a blank terminal (the same "broken config still renders" contract as cc-candybar's seeded render-cache entry).

### node-jsonc-parser
- **URL:** https://github.com/microsoft/node-jsonc-parser
- **Stats:** TypeScript · 757 stars · 183 commits · last push 2026-09-09
- **What it is:** The scanner/parser/editor VS Code uses for its own `settings.json`: a tolerant JSON-with-comments parser plus an edit API.
- **Interesting because:** `modify(text, path, value, options)` returns a minimal `Edit[]` (offset, length, content) that `applyEdits` splices, so a settings UI writing one key back into a hand-edited file preserves every comment, every trailing comma and the author's key order — the exact mechanism cc-candybar's `json5-edit` span splicer implements, with `getLocation`/`findNodeAtOffset` on top for completion at a cursor.

### toml_edit (toml-rs workspace)
- **URL:** https://github.com/toml-rs/toml
- **Stats:** Rust · 1,071 stars · 3,131 commits · last push 2026-09-10
- **What it is:** The `toml_edit` crate: a TOML document model that keeps whitespace, comments and ordering as part of the AST, plus `toml` built on top of it.
- **Interesting because:** It is the format-preserving editor with the most production mileage of any (it is what `cargo add` / `cargo remove` use to rewrite real `Cargo.toml` files), and its `Document` type distinguishes `Item::Value` / `Table` / `InlineTable` with explicit `decor` (prefix/suffix trivia) on each node — a worked answer to "where do I hang the bytes I must not lose" for a structured config editor.

### Nickel
- **URL:** https://github.com/tweag/nickel
- **Stats:** Rust · 2,993 stars · 5,155 commits · last push 2026-09-10
- **What it is:** A gradually-typed, lazy configuration language from Tweag, designed as "JSON plus functions plus validation", with an LSP and a formatter.
- **Interesting because:** Contracts are runtime-checked types attached with `|` (`port | Number | std.number.PosNat`) and carry *blame* — the error names the contract, the offending value and the call site that supplied it — which is the strongest answer in this territory to "loaders that produce helpful errors"; its recursive merge operator `&` with `optional`/`default`/`force` field metadata is a principled version of cc-candybar's `mergeWithDefault`.

### CUE
- **URL:** https://github.com/cue-lang/cue
- **Stats:** Go · 6,249 stars · 6,390 commits · last push 2026-09-09
- **What it is:** A configuration language where types and values inhabit one lattice, so a schema, a default and a concrete config are all the same kind of thing combined by unification.
- **Interesting because:** Because unification is commutative and associative, "user config on top of bundled default" needs no merge rules at all — and `cue vet`, `cue def` and `cue export` let one file act as validator, documentation source and emitter of JSON/YAML for a tool that never learns CUE exists.

### Pkl
- **URL:** https://github.com/apple/pkl
- **Stats:** Java · 11,515 stars · 895 commits · last push 2026-09-10
- **What it is:** Apple's configuration language: classes, properties, amends-based inheritance, and pluggable renderers that emit JSON, YAML, plist or Java/Kotlin/Swift/Go bindings.
- **Interesting because:** Validation lives on the property as a constraint expression (`hidden port: Int(isBetween(1024, 65535))`) so the error points at the declaration rather than at a line number, and its codegen story means the config schema and the consuming program's types are generated from one source — the same invariant cc-candybar gets by emitting its JSON Schema from the loader.

### Dhall
- **URL:** https://github.com/dhall-lang/dhall-lang
- **Stats:** Dhall · 4,484 stars · 790 commits · last push 2026-09-04 (low-activity standard repo; included for influence, not adoption)
- **What it is:** A total, non-Turing-complete configuration language with a formal standard, whose implementations normalise a config to a canonical form before emitting JSON/YAML.
- **Interesting because:** Imports are addressed by *semantic hash* — `./foo.dhall sha256:…` pins the meaning of an import after normalisation, so a refactor that preserves behaviour keeps the hash — and `dhall lint` / `dhall format` / `dhall freeze` are a worked example of a config language whose tooling can rewrite user files safely because the language has no side effects.

### Oh My Posh Visual Configurator
- **URL:** https://github.com/jamesmontemagno/ohmyposh-configurator
- **Stats:** TypeScript · 132 stars · 163 commits · last push 2026-08-03 (young, single-author; included as the clearest worked example of a browser configurator for a terminal tool)
- **What it is:** A browser app (configurator.ohmyposh.dev) that builds an Oh My Posh prompt by drag-and-drop over the ~100 known segments, with live preview, and exports JSON, YAML or TOML.
- **Interesting because:** It renders the prompt in the browser from the same segment metadata the CLI documents, so "discover what segments exist" becomes a palette you drag from rather than a docs page — and it round-trips: you paste an existing config in, edit visually, export back, which is the web analogue of a settings menu editing a hand-written file.

### Powerlevel10k
- **URL:** https://github.com/romkatv/powerlevel10k
- **Stats:** Shell · 55,081 stars · 4,330 commits · last push 2026-09-06
- **What it is:** A zsh theme whose real product is `p10k configure`: a terminal wizard that asks a dozen rendering questions and writes an exhaustively commented `~/.p10k.zsh`.
- **Interesting because:** The wizard probes the terminal live (it draws candidate glyphs and asks "do these look right?") before committing a charset/style decision, and the file it emits is a teaching document — every option present and commented out — so the generated config doubles as the reference manual; separately, "instant prompt" renders a cached prompt before the shell is initialised, the same warm-start trick as cc-candybar's daemon miss path.

## Theming and colour

### apcach
- **URL:** https://github.com/antiflasher/apcach
- **Stats:** JavaScript · 188 stars · 81 commits · last push 2025-02-04 (small and quiet; included because the mechanism is the one cc-candybar hand-rolls)
- **What it is:** A JS colour library that generates colours *from* a target contrast rather than measuring contrast after the fact, working in OKLCH with APCA as the contrast model.
- **Interesting because:** `apcach(crToBg("#fff", 60), chroma, hue)` declares "the contrast I need against this background" and solves for lightness, and `maxChroma()` finds the most saturated colour still meeting that contrast at a given hue — a direct replacement for cc-candybar's `stateFor` loop that nudges toward `foreground` in twelfths until it clears a floor.

### Catppuccin Whiskers
- **URL:** https://github.com/catppuccin/whiskers
- **Stats:** Rust · 121 stars · 202 commits · last push 2026-09-10
- **What it is:** The port-generation tool behind Catppuccin's ~300 application ports: a Tera template plus YAML frontmatter, run once per flavour to emit each app's theme file.
- **Interesting because:** The `matrix` frontmatter key takes arbitrary iterables (flavour × accent × …) and generates the whole cross-product of output files from one template, with colour filters (`mix`, `lighten`, `darken`, `transparentize`, hex/rgb/hsl formatters) available inside it, and `whiskers --check` verifies committed outputs still match the template in CI — a theme *distribution compiler*, not a theme pack.

### Tinty (tinted-theming)
- **URL:** https://github.com/tinted-theming/tinty
- **Stats:** Rust · 232 stars · 325 commits · last push 2026-08-10 (companion scheme repo `tinted-theming/schemes`: 293 stars, 146 commits, last push 2026-08-09)
- **What it is:** The base16/base24 theme manager: it fetches scheme YAML files and per-application Mustache templates, renders them, installs the results, and runs per-item hooks to make running apps pick the change up.
- **Interesting because:** The base16 spec is the oldest machine-readable palette contract still in wide use (`base00`–`base0F` as *roles*, base24 extending it with bright ANSI), and Tinty's `config.toml` model of `[[items]]` = template repo + hook + supported-systems is a clean separation between "what the palette is", "how this app spells a palette" and "how this app is told to reload".

### Material Color Utilities
- **URL:** https://github.com/material-foundation/material-color-utilities
- **Stats:** TypeScript (also Dart/Java/C++/Swift) · 2,263 stars · 285 commits · last push 2026-08-21
- **What it is:** Google's reference implementation of the Material You colour system: the HCT colour space (CAM16 hue/chroma plus L*a*b* tone), tonal palettes, quantisation and scheme generation.
- **Interesting because:** HCT's defining property is that *tone* is L\*, so "same hue, tone 40" is a contrast guarantee across every hue — a whole palette can be derived from one seed colour and a contrast level, which is exactly the "transpose a palette by a key" move cc-candybar does in OKLCH; the repo also ships image quantisation (Celebi/Wu) to pick seed colours from a picture.

### Culori
- **URL:** https://github.com/Evercoder/culori
- **Stats:** JavaScript · 1,227 stars · 696 commits · last push 2026-07-02
- **What it is:** A broad colour library covering every CSS Color 4 space (OKLab/OKLCH included) with conversion, interpolation, difference metrics and gamut mapping, in a tree-shakeable `culori/fn` form.
- **Interesting because:** `nearest(colors, differenceCiede2000())` builds a nearest-colour lookup against an arbitrary palette — the principled way to downsample truecolor to a 256-entry or 16-entry terminal palette — and its interpolation API takes an explicit hue-fixup function plus optional spline easing, which is the knob cc-candybar's `ramp` is reaching for.

### Color.js
- **URL:** https://github.com/color-js/color.js
- **Stats:** JavaScript · 2,301 stars · 1,602 commits · last push 2026-09-07
- **What it is:** The colour library by the CSS Color spec editors (Lea Verou, Chris Lilley), tracking CSS Color 4/5 semantics directly.
- **Interesting because:** `color.contrast(other, algorithm)` implements six different contrast algorithms side by side (WCAG21, APCA, Michelson, Weber, Lstar, DeltaPhi) so a project can pick its contrast *model* as a parameter, and it implements the spec's CSS gamut-mapping algorithm (chroma reduction with deltaEOK checking) rather than naive clipping.

### termenv
- **URL:** https://github.com/muesli/termenv
- **Stats:** Go · 2,024 stars · 228 commits · last push 2025-11-21
- **What it is:** The Go library underneath Charm's TUIs for detecting what a terminal can do and adapting output to it.
- **Interesting because:** It resolves a `Profile` (TrueColor / ANSI256 / ANSI / Ascii) from `COLORTERM`/`TERM`/environment, and `profile.Convert(color)` degrades any colour to the nearest entry that profile can express, so call sites never branch on capability; it also queries the terminal's actual background with an OSC 11 request to decide light vs dark, a live capability probe rather than a guess.

### ansi_colours
- **URL:** https://github.com/mina86/ansi_colours
- **Stats:** Rust · 47 stars · 62 commits · last push 2026-02-17 (tiny and single-author; included because it is the sharpest statement of one mechanism)
- **What it is:** A small Rust (and C) library that converts between 24-bit RGB and the xterm 256-colour cube in both directions.
- **Interesting because:** The truecolor→256 direction picks the *perceptually* nearest entry using a CIE Lab distance rather than nearest-RGB-cube arithmetic, with the search precomputed into lookup tables so the conversion stays a table read on a hot path — the measurable difference between "downsampled and still recognisable" and "downsampled and muddy".

### pastel
- **URL:** https://github.com/sharkdp/pastel
- **Stats:** Rust · 6,487 stars · 541 commits · last push 2026-05-01
- **What it is:** A command-line tool and library for generating, analysing, converting and manipulating colours, with a pipeline-friendly `pastel <verb> | pastel <verb>` design.
- **Interesting because:** `pastel distinct N` runs simulated annealing over CIEDE2000 distances to produce a set of maximally distinguishable colours (optionally under a colour-vision-deficiency simulation) — the principled version of "deal each segment a different decorative colour" — and `pastel colorcheck` prints a terminal self-test for 8/256/truecolor support you can eyeball in the target terminal.
