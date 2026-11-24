# Click verbs: reach, effects, and server state

An inventory of what a click can do, read from the code. Verify a claim against the code before building on it. Decisions live in the design docs, which override anything here.

The code declares 20 leaf verbs and `dispatch` (`src/click/wire.ts`). A verb's handler runs in the renderer (`src/renderer/verbs/index.ts`) and returns effects; the host performs them (`src/daemon/acts.ts`).

## Verbs and what each reaches

| Verbs | Reach |
|---|---|
| `set-state`, `step-state`, `back` | The session's picks and navigation, in the renderer's own state. A settings pick or an edit-mode toggle also writes the settings history. |
| `set-config`, `step-config`, `reset-config`, `save`, `save-preset`, `save-theme-default`, `delete-preset`, `apply-layout-op` | A config file of the session's chain, spliced in place, through a `change` effect the host applies. Every one of them names its layer by role as its second argument. |
| `undo`, `redo`, `rewind` | The settings history's own steps: the files a step wrote, and the session's picks. |
| `repo-config` | The user's answer about a repository's config, in the trust book under the state directory. |
| `copy`, `copy-diagnostic` | The clipboard, by `pbcopy`, as an act the host performs. |
| `open-vscode` | `open -a "Visual Studio Code"` on the path the link carries. The path is not gated. |
| `slash` | The Claude Code prompt in the session's own tmux pane, as an act the host performs. A session that reported no pane is refused. |
| `run` | The program the link's signed declaration names, under the session's environment. The host launches it and its source resumes when it ends. |
| `dispatch` | The union of the effects it carries. It reaches only the leaf verbs, so it does not nest. |

## Effects outside a verb's handler

- **Lane switches.** A click that changes a lane switch changes what the renderer declares, and the host reconciles tmux bar panes from that declaration (`src/daemon/declared-bar-panes.ts`), opening or closing the pane through `src/daemon/lane-setup.ts`. A failed setup is retried, and logged.
- **Idle close.** A menu's idle timer closes the menus through the same journaled write the ✕ makes (`closeIdleMenus`), so savepoints and back treat it like a click, with no click involved.
- **Closing view.** Every session write clears the disclosures nested inside a closed one in the same transaction (`src/renderer/closing-view.ts`).
- **Click errors.** A failed click and each act it asked for hold their errors in the clicking session's state; the request boundary marks them carried once an answer went out.
- **Client timeout.** A click the daemon has read is answered with its own outcome however long its turn takes. A TIMEOUT to a click means no complete frame of it was read before the guard answered, so its action did not run. A url frame's click is under no deadline: its writer waits for no answer, and its click runs however late its turn comes.

## Key files

- `src/renderer/verbs/index.ts`
- `src/renderer/menu-idle.ts`
- `src/renderer/settings-history.ts`
- `src/renderer/navigation-history.ts`
- `src/renderer/config-file-store.ts`
- `src/renderer/closing-view.ts`
- `src/daemon/acts.ts`
- `src/daemon/lane-setup.ts`
- `src/daemon/declared-bar-panes.ts`
- `src/daemon/config-discovery/repo-configs.ts`
- `src/daemon/runs.ts`
- `src/click/read.ts` (`HOST_VERBS` lists the verbs that act on the host's own machine)
