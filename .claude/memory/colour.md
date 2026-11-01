# Colour

The full rationale and measurements are in design-docs/COLOUR-FROM-THEME-VOCABULARY.md.

## rich-js does the math

All colour arithmetic (palettes, references, mixing, contrast, OKLCH) lives in rich-js. This repo keeps only name policy and memoised palette construction, and one place turns a theme name into a palette.

## Decoration by address

A closed cell's colour depends on where it sits. The row picks the hue: a decorative role chosen by the variation. The cell picks a shade from the window the shade dial is turned to. So neighbouring cells differ by shade, and the hue changes only at a new row or at the end of a run. A new hue in every cell reads as team colours.

No colour is synthesised. A closed cell wears its role at its shade exactly as the theme names it. A test checks that every background the bar draws, closed or with the settings menu open, is a colour its palette names.

A cell is a leaf of its row. A horizontal group nested in a row is layout, not a colour unit, because its cells sit side by side with the row's other cells, and neighbours must differ: each of its leaves takes its own place on the line, as the settings door and its frame-rate cell do. Edit mode's chrome is the one exception. It is spliced in as one unit with the cell it edits, sharing that cell's place, because entering edit mode must not recolour the bar. Spliced in as siblings, it would take positions and recolour the row.

Because colour follows address, hiding a sibling recolours nothing.

The shade dial is a table, so a new position or a wider window is one more row. Tones within a window are ordered so the default distribution walks a row up and down one rung at a time, and, where the depth draws every rung apart, turning the dial one step moves every cell exactly one rung. The rule that reads a placement as a tone belongs to the distribution, not the window, because whether neighbours ever share a tone is a property of the pair: the default keeps them apart only read by halves, golden angle by equal bins, and the even spreads ramp evenly and in order only by equal bins. Every position deals at least two tones, the muted one included, because a one-tone position puts every pair of neighbours on one shade.

A window is per depth because a terminal is sent colours, not names: two rungs a depth rounds to one entry or slot are one colour there, so the window keeps the rungs the depth draws apart and widens along the ladder toward as many tones as its position names, because that count is what the distributions keep neighbours apart over (golden angle holds only over three). It never takes the last colour of a ladder that draws more than two, because the button pressed in that hue stands beside every tone of its band's window and needs a colour none of them wears; a press drawn like its neighbour puts two neighbours on one colour, while a third closed tone is only look. So at ansi a three-slot ladder's window holds two, and golden-angle neighbours can meet there. That reservation is per hue: a press also stands beside the bar's other hues and the band above, which a window cannot see, so a press can still find no rung. Two tones is the floor. Alike means identical once rounded, never near, so nothing measures a distance between two colours.

In some themes the accent is the warning colour, so their accent cells read as orange. That's the theme's own choice, and it's accepted.

## Open menus

The segment whose menu is open is a pressed button, and like every other cell it selects a named shade: its menu's hue at the shade the dial names for the pressed state, which the ✕ and blank leads of that menu's rows wear too. Where a depth draws that shade as the colour of something the layout puts beside it (its band's items, the cells beside its trigger, the press a depth up), it moves along the ladder the way a window widens; at sixteen colours a ladder can have nothing left, and the joiner shows that seam. What it keeps apart from on the bar is the tones the windows deal, because a band's colours cannot depend on where its trigger stands. A cell a hue turn moves past its window is not among those tones, so that cell keeps off the press instead, wherever its ladder has a rung to give: every trigger on the bar opens the same band, so the press is one colour a cell can know from its own address. The rows sit on the theme's surface. Both are named shades so that nothing on the bar is a synthesised colour, and the joiner guarantees every seam, so nothing here predicts a join or measures one cell against another. Where a theme names two neighbours alike, the seam is the joiner's to show.

A band is a plane hung under the trigger that opened it, not a position in the tree. Its items are the header's hue at the tones of the dial's window, so a menu reads as a variation on the colour of the header that opened it. A trigger takes its colour from what it opens. Depth is the number of enclosing bodies and is never stored. The plane is the backing behind a band's rows, the same at every depth: a nested band is told by its leads and its hue, not by its backing.

## Every floor is measured as drawn

Every contrast floor is measured on the colours the terminal will actually draw at the configured depth, composited over black, never on raw RGBA. At 256 colours, text and background round independently, so a colour that loses its floor after rounding is swapped for the nearest one that clears it. At ansi depth, colours are measured as the VGA palette rich-js assumes. The SGR writer still rounds each colour itself, so an arrow is drawn exactly in its cell's colour wherever that colour stands off the next cell's as drawn; where it doesn't, rich-js's joiner lifts the arrow's ink off the next cell's, so a join never vanishes and is never a divider.

## Text

Text with no authored colour clears WCAG AA (4.5:1) on its background in every region. A fixed foreground fails on pale bands, and the terminal's own text fails whenever the terminal's light/dark polarity differs from the theme's. `bg: "none"` draws on the terminal's own background with no text colour either, because the detached daemon can't see that background.

The settings door's open ✖ stays red on every theme because it only ever selects among the reds the theme names for its error role and never slides lightness: a red slid until it reads stops reading as red. Where none of those reds reads on the pressed state, it wears the one standing farthest off and reads below the text floor, and that is accepted rather than slid. At lower depths it keeps the contrast it had in truecolor, so rounding doesn't cost it.

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
