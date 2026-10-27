# Colour

The full rationale and measurements are in design-docs/COLOUR-FROM-THEME-VOCABULARY.md.

## rich-js does the math

All colour arithmetic (palettes, references, mixing, contrast, OKLCH) lives in rich-js. This repo keeps only name policy and memoised palette construction, and one place turns a theme name into a palette.

## Decoration by address

A closed cell's colour depends on where it sits. The row picks the hue: a decorative role chosen by the variation. The cell picks a shade from the window the shade dial is turned to. So neighbouring cells differ by shade, and the hue changes only at a new row or at the end of a run. A new hue in every cell reads as team colours.

No colour is synthesised. A closed cell wears its role at its shade exactly as the theme names it. A test checks that every background the bundled closed bar draws is close to a colour its palette names.

Anything nested inside a cell wears that cell's hue and shade. That's why edit mode's chrome is spliced in as one unit with the cell it edits. Spliced in as siblings, it would take positions and recolour the row.

Because colour follows address, hiding a sibling recolours nothing.

The shade dial is a table, so a new position or a wider window is one more row. Tones within a window are ordered so the default distribution walks a row up and down one rung at a time, and turning the dial one step moves every cell exactly one rung. The shade is picked by nearest point, not by bin, because bins put neighbouring cells on the same shade.

In some themes the accent is the warning colour, so their accent cells read as orange. That's the theme's own choice, and it's accepted.

## Open triggers and bands

An open trigger wears the open colour its variation's lineage gives its depth. It stands apart from the closed cells of its own row by contrast, not by hue alone. Its colour is searched along the hue's own rays through OKLCH lightness, toward white and toward black, keeping the hue's angle and chroma, until it clears the floor. Sliding toward the theme's own light and dark ends would grey the hue instead. The search tries the colour at every point where a constraint starts or stops holding, and enumerates the drawable colours between them, so a colour that clears is never missed between two sampled steps. The search never throws, because the settings door is itself a trigger: a throw there would leave no way to change the setting back. Where nothing clears, it takes the candidate that stands furthest off and reports a shortfall.

A trigger's ground is the set of colours its row's cells actually wear. It is computed per row, because no single colour can stand off the whole bar at once.

A band is a plane hung under the trigger that opened it, not a position in the tree. A band's items are the header's hue at the tones of the dial's window, so a menu reads as a variation on the colour of the header that opened it. A trigger stands off its items as well as its plane. A trigger takes its colour from what it opens. Depth is the number of enclosing bodies and is never stored. A nested trigger stands off the plane and the state colour of the band it sits in, not off the bar row. Held off the bar row, nested states drift to the same end of the lightness axis as their parent's and merge with it.

Band items alternate by cell parity, so neighbouring items never need the joiner's thin divider.

Band colours are computed unrounded from one settled candidate and rounded once. They are never blended from a colour that was already rounded.

## Every floor is measured as drawn

Every contrast floor is measured on the colours the terminal will actually draw at the configured depth, composited over black, never on raw RGBA. At 256 colours, text and background round independently, so a colour that loses its floor after rounding is swapped for the nearest one that clears it. At ansi depth, colours are measured as the VGA palette rich-js assumes. The SGR writer still rounds each colour itself, which keeps a powerline arrow exactly the colour of its cell. Between bands, floors are measured as ΔE in OKLab, because a contrast ratio can't separate two hues at the same lightness.

## Text

Text with no authored colour clears WCAG AA (4.5:1) on its background in every region. A fixed foreground fails on pale bands, and the terminal's own text fails whenever the terminal's light/dark polarity differs from the theme's. `bg: "none"` draws on the terminal's own background with no text colour either, because the detached daemon can't see that background.

The settings door's open ✖ uses the theme's own error colour. In truecolor it isn't adjusted for contrast, so it reads as that theme's red. At lower depths it keeps the contrast it had in truecolor, so rounding doesn't cost it.

## Authored bg is meaning

An authored `bg:` states meaning (an alert, a threshold) and paints over the decoration. A cell with no `bg:` is decorated. The bundled default authors no decorative `bg:`. A threshold's calm state uses the cell's own tint, because a fixed calm colour paints calm neighbours as one slab.

Prefer quiet by default. Give a segment a computed quiet `fg:` and let only the facts that matter set a colour.

## Colours are values

A colour passes through templates as a `#RRGGBB` string, so it can be stored in a variable and composed by nesting. The simple form is a literal prefix of the composed one, so you add an adjustment by wrapping working code, not by rewriting it.

There's no colour-spec mini-language. A themed palette has about 150 variables, and few of them are legal template identifiers, so a family of names could never cover its own domain. Composition inside a string would also need a new grammar production for every operation.

Colour math takes hex only. Symbolic colours like "red" go only to the fg and bg sinks, where the terminal decides what they look like.

Ramp and cascade positions are required and must ascend. A descending pair is a loud error, never a silent sort, because "warning 80, error 50" sorted is a different ramp. The ascending rule is written both here and in rich-js, and a test keeps the two in agreement. Threshold settings declare their order, and it is enforced both at load and when picking.

A gauge colours each cell by the ramp at that cell's lower edge, so a step threshold doesn't bleed into the cell below it.

## Styles and theme selection

A style is a transform, not a palette, so it composes with every theme. It is applied in one transpose per render and never chained, since chaining pays the OKLCH quantization cost twice. A style's swatch transposes the base palette, because transposing an already-styled palette paints in two styles at once. The style memo is keyed per palette object, so passing the wrong base shows up instead of hiding behind a cached answer. Style tests compute their expected values through rich-js directly, because the function under test can't be its own oracle.

Theme, style and effect share one selection shape: either a name, or a rule (a template). Only the config-default rung can hold a rule, so a session pick of "none" is a decision that sticks. A theme rule that names nothing falls back to the floor and reports a warning. A style rule falls back silently, because the style floor is the identity, a harmless answer, while the theme floor is a specific palette. Both report rather than throw: a data-driven value can be right for a week and then name nothing once a threshold moves, and a throw would take the whole bar away at that moment. Endcaps, wrap and padding aren't rule slots, because their values aren't names.

The render is the only producer of the effective theme and style, so a control's label can't disagree with the palette the bar wears. A palette passed separately from its name would be a second clock.

A theme's default look sits under the user's globals, never over them. A theme chosen by a rule gets no theme default, because which theme it is becomes known only after the look has resolved. Saving a theme's default skips fields the config's globals set, so one preset's pinned value doesn't leak into every preset's default.
