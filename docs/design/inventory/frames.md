# Rendered text: the frame and link minting

An inventory read from the code. Verify a claim against the code before building on it. Decisions live in the design docs, which override anything here.

## The frame

A draw produces a frame: rows of styled runs in the colours drawn at its depth (`src/render/frame.ts`). A bar exists as this structure, and every byte of a draw is encoded from it there.

- A run's colours are the ones drawn at the frame's depth, not the ones a config asked for, in one spelling each (a hex for a drawn truecolor colour, else `color(n)`). So a frame is drawn for one depth and is not depth-independent.
- At depth `none` a run has no look and keeps its link.
- A run's link is a drawn link (`src/render/drawn-link.ts`), and the host turns drawn links into published hrefs.

## Link minting

**Built from `effectsUrl` (`src/click/wire.ts`):**
- `src/render/drawn-link.ts`: the drawn link of an effect, a `run`, or a repository answer.
- `src/render/action.ts`: `renderAction`.
- `src/render/menu.ts`: the trigger.
- `src/render/disclosure-close.ts`: `disclosureCloseFragment`.
- `src/render/picker.ts` and `src/render/carousel.ts`: their options, steps and close controls.
- `src/render/diagnostics.ts`: `copyLink` and `viewerLink`.
- `src/config/repo-question.ts`: the repository question, signed.
- `src/renderer/lane-handoff.ts`: the handoff line.

**Not built from it:**
- `src/install/index.ts`: the printed `hello-world` test URL, which relies on bare-copy parsing.
- Config-authored links through `{{ link url text }}`. Sources: `.git.prUrl` in `src/config/default-dsl-config.ts`, `.git.repoUrl` in `src/config/quick-actions.ts`, and `examples/demo-actions.json5`, which writes literal `cc-candybar://open-vscode/...` links.

**Readers of the scheme:** `parseHandlerUrl` and `isBarLink` in `src/click/read.ts` and `src/click/wire.ts`. The wire still accepts direct `cc-candybar://<verb>/…` URLs, so a reader must take both forms.

**Signing** (`src/click/link-signer.ts`): the host publishes each bar link with a mac over its whole text, and opens each click before any renderer sees it. A `run` link and the repository question's answer carry a mac of their own as well, over what they prove beyond the link: that the action's declaration is unchanged since the draw, and that the question, not a config, drew the answer.
