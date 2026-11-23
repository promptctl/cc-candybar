# Sources, payload, and what a render reads

An inventory read from the code. Verify a claim against the code before building on it. Decisions live in the design docs, which override anything here.

## Repo gate

**Where:** `projectAccess` (pure, `src/config/loader/repo-gate.ts`) is called where config search resolves a layered query (`src/daemon/config-discovery/config-search.ts`). The answers come from the host's book (`src/daemon/config-discovery/repo-configs.ts`). A query for one named file observes no book, so a named file passes unasked.

**What it gates:**
- the project's config layers, filtered by the project's approval *before merge*
- the project's `.cc-candybar/plugins/`, through the stamped `ApprovedRepo` that plugin discovery takes (`src/daemon/config-discovery/plugin-folders.ts`)

**What it does not gate:** the user's own config file, a named file, and user or package plugin roots.

**Trust story:**
- The socket sits in a directory the host verifies is owned by the user, mode 0700, and not a symlink (`ensureOwnedPrivateDir`, `src/daemon/paths.ts`). Requests carry no authentication, so the boundary is filesystem permission.
- A same-UID process can already run any shell today: `--config` or `CC_CANDYBAR_CONFIG` names a file, and a named file never asks. It can also edit the user's config or the book, and read the link key to forge links.
- So the gate defends against a *cloned repository's contents*, not a same-UID process. Claiming otherwise would be false.

**Checks that assume the host loaded the config:**
- `ApprovedRepo` is a compile-time stamp and does not survive a wire.
- `validateRenderable` is the loader's check on a parsed config; wire data is not one. The instant and cycle checks live in the loader, and the regex capture and absolute path checks are the host's run judge (`src/daemon/foundations/judge-run.ts`).
- A click's handler rebuilds a run's signed declaration from the session's config (`src/renderer/verbs/index.ts`).
- A storage folder is the host's: the host creates, watches and numbers each folder's generations.

**A shell declaration from a renderer:** provenance is lost at merge, because a variable carries no source file. The host does not re-run the repo gate over a declaration. It judges each run where its set arrives (`judge-run.ts`), which checks that the run is well formed to run, not where it came from. The gate's protection is that an unapproved layer never reaches the renderer's load.
